/**
 * Auto-issue a RECEIPT (קבלה) when a payment is verified PAID.
 *
 * Business rule (#12): once a payment is finally verified (the Payments
 * Authority Principle — a verified `PAID`, never a raw webhook signal), issue a
 * receipt automatically, link it to the original invoice, keep a full audit,
 * and never create duplicates.
 *
 * Compliance / architecture:
 * - NO new source of truth. The receipt is a normal BillingDocument(RECEIPT)
 *   issued through the ONE compliance issuance engine (`issueBillingDocument`):
 *   sequential numbering, immutable frozen snapshot + hash, lock, audit.
 * - The money-in truth is already recorded by the payment's own
 *   FinancialEvent(PAYMENT); the receipt does NOT create a second financial
 *   event (no double counting) — issuance no-ops the invoice event for receipts.
 * - The receipt is linked to the invoice via BillingPaymentAllocation (the
 *   existing invoice↔receipt link), not a new relation.
 * - Idempotent: keyed on the settlement identity so a duplicate/re-delivered
 *   webhook never issues a second receipt.
 * - Best-effort: the caller (onVerifiedPaid) must never let this break the
 *   payment flow.
 *
 * Delivery: if the customer has an email we mark the receipt delivery-ready in
 * the audit trail. Actual sending needs an email/WhatsApp sender, which does
 * not exist yet (owner must provision a provider) — see the returned reason.
 */

import { prisma } from "@/lib/prisma";
import {
  BillingDocumentStatus,
  BillingDocumentType,
  PaymentMethod,
} from "@prisma/client";
import { createReceiptDraft } from "./billing-receipt-draft.service";
import { setReceiptAllocations } from "./billing-payment-allocation.service";
import { issueBillingDocument } from "../billing-issue.service";
import { createBillingAuditEventBestEffort } from "../billing-audit.service";

export interface VerifiedPaymentSettlement {
  businessId: number;
  paymentRequestId: number;
  transactionId: number;
  amount: string;
  currency: string;
  occurredAt: Date;
}

export type AutoReceiptResult =
  | { status: "issued"; receiptId: number; allocated: boolean; deliveryReady: boolean }
  | { status: "skipped"; reason: string; receiptId?: number };

export async function issueAutoReceiptForVerifiedPayment(
  e: VerifiedPaymentSettlement
): Promise<AutoReceiptResult> {
  // 1. Load the payment request + its linked invoice + customer.
  const paymentRequest = await prisma.paymentRequest.findUnique({
    where: { id: e.paymentRequestId },
    include: { billingDocument: true, customer: true },
  });
  if (!paymentRequest) {
    return { status: "skipped", reason: "payment request not found" };
  }

  const invoice = paymentRequest.billingDocument;
  // Auto-receipt is defined for invoice collections — it links to the original
  // invoice. A standalone payment (no linked invoice) is out of scope here.
  if (!invoice || invoice.businessId !== e.businessId) {
    return { status: "skipped", reason: "no invoice linked to this payment" };
  }
  if (
    invoice.documentType !== BillingDocumentType.TAX_INVOICE ||
    invoice.status !== BillingDocumentStatus.ISSUED
  ) {
    return { status: "skipped", reason: "linked document is not an issued tax invoice" };
  }

  // Deterministic settlement identity: the human-facing receipt reference AND
  // the idempotency anchor. providerTransactionId when present, else the
  // internal transaction id (always present, unique per settlement).
  const transaction = await prisma.paymentTransaction.findUnique({
    where: { id: e.transactionId },
    select: { providerTransactionId: true },
  });
  const providerRef = transaction?.providerTransactionId?.trim();
  const settlementRef = providerRef ? providerRef : `txn:${e.transactionId}`;

  // 2. Idempotency — has a receipt already been issued for this settlement?
  // Queried from the document side (businessId + type filter directly; the
  // settlement reference matched via the to-many payment-lines relation).
  const existing = await prisma.billingDocument.findFirst({
    where: {
      businessId: e.businessId,
      documentType: BillingDocumentType.RECEIPT,
      receiptPayments: { some: { reference: settlementRef } },
    },
    select: { id: true },
  });
  if (existing) {
    return {
      status: "skipped",
      reason: "receipt already issued for this settlement",
      receiptId: existing.id,
    };
  }

  // 3. Resolve the responsible user — issuance is attributed to the business's
  // primary (earliest) account holder, since a webhook has no acting user.
  const actor = await prisma.user.findFirst({
    where: { businessId: e.businessId },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!actor) {
    return { status: "skipped", reason: "no user to attribute the issuance to" };
  }

  const customerNameSnapshot = (
    invoice.customerNameSnapshot ??
    paymentRequest.customer?.name ??
    ""
  ).trim();
  if (!customerNameSnapshot) {
    return { status: "skipped", reason: "no customer name to snapshot on the receipt" };
  }

  // 4. Create the receipt draft — a single payment line for the settlement.
  const draft = await createReceiptDraft({
    businessId: e.businessId,
    actorUserId: actor.id,
    documentType: BillingDocumentType.RECEIPT,
    customerId: invoice.customerId ?? paymentRequest.customerId ?? null,
    customerNameSnapshot,
    currency: e.currency,
    paymentLines: [
      {
        method: PaymentMethod.OTHER,
        amount: e.amount,
        currency: e.currency,
        paymentDate: e.occurredAt,
        reference: settlementRef,
      },
    ],
  });

  // 5. Issue it through the ONE compliance engine (number, snapshot, lock, audit).
  const issued = await issueBillingDocument({
    businessId: e.businessId,
    actorUserId: actor.id,
    billingDocumentId: draft.id,
  });

  // 6. Link the receipt to the original invoice (full-settlement allocation).
  let allocated = false;
  try {
    await setReceiptAllocations({
      businessId: e.businessId,
      receiptDocumentId: issued.id,
      allocations: [{ invoiceDocumentId: invoice.id, allocatedAmount: e.amount }],
    });
    allocated = true;
  } catch (allocErr) {
    console.error(
      "auto-receipt: allocation to invoice failed (receipt issued, not linked):",
      allocErr
    );
  }

  // 7. Audit the automation + settlement linkage; capture delivery readiness.
  const recipientEmail = paymentRequest.customer?.email?.trim() || null;
  await createBillingAuditEventBestEffort({
    businessId: e.businessId,
    billingDocumentId: issued.id,
    actorUserId: null,
    eventType: "BILLING_RECEIPT_AUTO_ISSUED",
    source: "SYSTEM",
    summary: "קבלה הופקה אוטומטית מתשלום מאומת",
    metadata: {
      trigger: "verified_paid",
      paymentRequestId: e.paymentRequestId,
      paymentTransactionId: e.transactionId,
      invoiceDocumentId: invoice.id,
      settlementRef,
      amount: e.amount,
      currency: e.currency,
      allocatedToInvoice: allocated,
      // Delivery readiness: the receipt PDF renders on issue; actual send needs
      // an email/WhatsApp sender that does not exist yet.
      deliveryReady: Boolean(recipientEmail),
      recipientEmail,
    },
    occurredAt: e.occurredAt,
  });

  return {
    status: "issued",
    receiptId: issued.id,
    allocated,
    deliveryReady: Boolean(recipientEmail),
  };
}
