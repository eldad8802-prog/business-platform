import { Prisma } from "@prisma/client";
import { NotFoundError } from "@/lib/errors";
import { billingTenantTx } from "@/lib/services/billing/billing-tenant-tx";
import { computeEconomicRemaining } from "@/lib/services/billing/domain/billing-invoice-economic-remaining";
import { readProviderDocument } from "@/lib/services/payments/payment-evidence";
import type { ProviderIssuedDocument } from "@/lib/services/payments/providers/payment-provider.types";

/**
 * A customer's financial story, in order — /collection/c/[customerId].
 *
 * Each event is a fact Dubiz holds: an invoice issued, a credit note, a
 * payment request, the provider's verified outcome, the receipt Dubiz issued
 * and what it settled, a refund. The accounting stays exact underneath (a
 * refund is money returned, never an invoice reopened; excess is stated
 * unapplied money, not a hidden gap); the owner reads it in plain words.
 */

export type ThreadEvent =
  | { kind: "INVOICE_ISSUED"; at: string; invoiceId: number; number: string | null; amount: string; currency: string; outstanding: string }
  | { kind: "CREDIT_NOTE_ISSUED"; at: string; documentId: number; number: string | null; amount: string; currency: string; invoiceId: number | null }
  | { kind: "REQUEST_CREATED"; at: string; requestId: number; amount: string; currency: string; invoiceId: number | null; invoiceNumber: string | null; status: string; paymentUrl: string | null }
  | { kind: "REQUEST_CANCELLED"; at: string; requestId: number; paidAfterward: boolean }
  | { kind: "PAYMENT_FAILED"; at: string; requestId: number; amount: string; currency: string }
  | { kind: "PAYMENT_VERIFIED"; at: string; requestId: number; paymentTransactionId: number; amount: string; currency: string; accounting: "RECEIPTED" | "RECEIPT_PENDING" | "RECEIPT_ATTENTION" | "NO_AUTOMATIC_RECEIPT"; attentionReason: string | null; /** Only when the provider document was checked (foreign currency, PROVIDER_ISSUES): the verified document, or null. */ providerDocument?: ProviderIssuedDocument | null }
  | { kind: "RECEIPT_ISSUED"; at: string; receiptId: number; number: string | null; amount: string; currency: string; allocations: { invoiceId: number; invoiceNumber: string | null; amount: string }[]; unappliedAmount: string; automatic: boolean }
  | { kind: "REFUND"; at: string; requestId: number; amount: string; currency: string; outcome: "SETTLED" | "PENDING" | "FAILED" };

export type CustomerFinancialThread = {
  /** How the business signs a message to its customer. */
  businessName: string;
  customer: { id: number; name: string; phone: string | null; email: string | null };
  totals: {
    outstanding: string;
    currency: string | null;
    openInvoices: number;
    isMixedCurrency: boolean;
    outstandingByCurrency: { currency: string; outstanding: string }[];
  };
  openInvoices: { id: number; number: string | null; outstanding: string; currency: string }[];
  events: ThreadEvent[];
};

const dec = (v: Prisma.Decimal | null | undefined) => (v ?? new Prisma.Decimal(0)).toFixed(2);
const iso = (d: Date | null | undefined, fallback: Date) => (d ?? fallback).toISOString();

export async function loadCustomerFinancialThread(
  businessId: number,
  customerId: number
): Promise<CustomerFinancialThread> {
  return billingTenantTx(businessId, async (tx) => {
    const customer = await tx.customer.findFirst({
      where: { id: customerId, businessId },
      select: { id: true, name: true, phone: true, email: true },
    });
    if (!customer) throw new NotFoundError("Customer not found");

    const invoices = await tx.billingDocument.findMany({
      where: { businessId, customerId, documentType: "TAX_INVOICE", status: "ISSUED" },
      select: {
        id: true, documentNumberFormatted: true, totalAmount: true, currency: true, issuedAt: true, createdAt: true,
        paymentAllocationsAsInvoice: {
          where: { businessId, receiptDocument: { businessId, status: "ISSUED" } },
          select: { allocatedAmount: true },
        },
        creditNotes: {
          where: { businessId, documentType: "CREDIT_NOTE", status: "ISSUED" },
          select: { id: true, documentNumberFormatted: true, totalAmount: true, currency: true, issuedAt: true, createdAt: true },
        },
      },
      orderBy: { issuedAt: "asc" },
      take: 500,
    });
    const invoiceIds = invoices.map((i) => i.id);

    const requests = await tx.paymentRequest.findMany({
      where: {
        businessId,
        OR: [{ customerId }, ...(invoiceIds.length ? [{ billingDocumentId: { in: invoiceIds } }] : [])],
      },
      select: {
        id: true, amount: true, currency: true, status: true, createdAt: true, updatedAt: true, paymentUrl: true,
        billingDocumentId: true,
        billingDocument: { select: { documentNumberFormatted: true } },
        transactions: { select: { id: true, amount: true, currency: true, status: true, createdAt: true, rawPayload: true } },
        auditEvents: { where: { eventType: "PAYMENT_REQUEST_CANCELLED" }, select: { occurredAt: true } },
      },
      orderBy: { createdAt: "asc" },
      take: 500,
    });
    const txIds = requests.flatMap((r) => r.transactions.filter((t) => t.amount.greaterThan(0)).map((t) => t.id));
    const settlements = txIds.length
      ? await tx.paymentAccountingSettlement.findMany({
          where: { businessId, paymentTransactionId: { in: txIds } },
          select: { paymentTransactionId: true, status: true, attentionReason: true },
        })
      : [];

    const receipts = await tx.billingDocument.findMany({
      where: {
        businessId,
        documentType: "RECEIPT",
        status: "ISSUED",
        OR: [
          { customerId },
          ...(txIds.length ? [{ sourcePaymentTransactionId: { in: txIds } }] : []),
          ...(invoiceIds.length ? [{ paymentAllocationsAsReceipt: { some: { invoiceDocumentId: { in: invoiceIds } } } }] : []),
        ],
      },
      select: {
        id: true, documentNumberFormatted: true, totalAmount: true, currency: true, issuedAt: true, createdAt: true,
        unappliedAmount: true, sourcePaymentTransactionId: true,
        paymentAllocationsAsReceipt: {
          select: { invoiceDocumentId: true, allocatedAmount: true, invoiceDocument: { select: { documentNumberFormatted: true } } },
        },
      },
      take: 500,
    });

    const events: ThreadEvent[] = [];
    const open: CustomerFinancialThread["openInvoices"] = [];
    // Per currency: an ILS balance and a USD balance are never added into one number.
    const outstandingBy = new Map<string, Prisma.Decimal>();
    for (const inv of invoices) {
      const alloc = inv.paymentAllocationsAsInvoice.reduce((a, x) => a.plus(x.allocatedAmount), new Prisma.Decimal(0));
      const credited = inv.creditNotes.reduce((a, x) => a.plus(x.totalAmount), new Prisma.Decimal(0));
      const remaining = computeEconomicRemaining(inv.totalAmount, alloc, credited);
      outstandingBy.set(inv.currency, (outstandingBy.get(inv.currency) ?? new Prisma.Decimal(0)).plus(remaining));
      if (remaining.greaterThan(0)) {
        open.push({ id: inv.id, number: inv.documentNumberFormatted, outstanding: dec(remaining), currency: inv.currency });
      }
      events.push({
        kind: "INVOICE_ISSUED", at: iso(inv.issuedAt, inv.createdAt), invoiceId: inv.id, number: inv.documentNumberFormatted,
        amount: dec(inv.totalAmount), currency: inv.currency, outstanding: dec(remaining),
      });
      for (const cn of inv.creditNotes) {
        events.push({
          kind: "CREDIT_NOTE_ISSUED", at: iso(cn.issuedAt, cn.createdAt), documentId: cn.id, number: cn.documentNumberFormatted,
          amount: dec(cn.totalAmount), currency: cn.currency, invoiceId: inv.id,
        });
      }
    }

    for (const r of requests) {
      // The money is the fact: a request that carries verified money is PAID
      // whatever its own status says (e.g. cancelled by the owner, then paid
      // through its link) — and is never offered for sharing or cancelling.
      const hasVerifiedMoney = r.transactions.some((t) => t.status === "PAID" && t.amount.greaterThan(0));
      const status = hasVerifiedMoney ? "PAID" : r.status;
      events.push({
        kind: "REQUEST_CREATED", at: r.createdAt.toISOString(), requestId: r.id, amount: dec(r.amount), currency: r.currency,
        invoiceId: r.billingDocumentId, invoiceNumber: r.billingDocument?.documentNumberFormatted ?? null, status,
        paymentUrl: status === "PENDING" ? r.paymentUrl : null,
      });
      for (const c of r.auditEvents) {
        // M1 — a cancellation is kept as history, and says so when the customer
        // paid through the link anyway: the money is real and was recorded.
        events.push({ kind: "REQUEST_CANCELLED", at: c.occurredAt.toISOString(), requestId: r.id, paidAfterward: hasVerifiedMoney });
      }
      const verified = r.transactions.filter((t) => t.status === "PAID" && t.amount.greaterThan(0));
      if (r.status === "FAILED" && verified.length === 0) {
        events.push({ kind: "PAYMENT_FAILED", at: r.updatedAt.toISOString(), requestId: r.id, amount: dec(r.amount), currency: r.currency });
      }
      for (const t of verified) {
        const s = settlements.find((x) => x.paymentTransactionId === t.id);
        const hasReceipt = receipts.some((x) => x.sourcePaymentTransactionId === t.id);
        const providerDocument = readProviderDocument(t.rawPayload);
        events.push({
          kind: "PAYMENT_VERIFIED", at: t.createdAt.toISOString(), requestId: r.id, paymentTransactionId: t.id,
          amount: dec(t.amount), currency: t.currency,
          accounting: hasReceipt ? "RECEIPTED" : !s ? "NO_AUTOMATIC_RECEIPT" : s.status === "REQUIRES_ATTENTION" ? "RECEIPT_ATTENTION" : "RECEIPT_PENDING",
          attentionReason: s?.attentionReason ?? null,
          ...(providerDocument !== undefined ? { providerDocument } : {}),
        });
      }
      for (const t of r.transactions.filter((x) => x.amount.lessThan(0))) {
        events.push({
          kind: "REFUND", at: t.createdAt.toISOString(), requestId: r.id, amount: dec(t.amount.negated()), currency: t.currency,
          outcome: t.status === "PAID" ? "SETTLED" : t.status === "PENDING" ? "PENDING" : "FAILED",
        });
      }
    }

    for (const rc of receipts) {
      events.push({
        kind: "RECEIPT_ISSUED", at: iso(rc.issuedAt, rc.createdAt), receiptId: rc.id, number: rc.documentNumberFormatted,
        amount: dec(rc.totalAmount), currency: rc.currency,
        allocations: rc.paymentAllocationsAsReceipt.map((a) => ({
          invoiceId: a.invoiceDocumentId, invoiceNumber: a.invoiceDocument?.documentNumberFormatted ?? null, amount: dec(a.allocatedAmount),
        })),
        unappliedAmount: dec(rc.unappliedAmount), automatic: rc.sourcePaymentTransactionId !== null,
      });
    }

    const headline: string | null =
      outstandingBy.size === 0 ? null : outstandingBy.has("ILS") ? "ILS" : [...outstandingBy.keys()].sort()[0];

    events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    const business = await tx.business.findUnique({
      where: { id: businessId },
      select: { name: true, profile: { select: { billingLegalName: true } } },
    });
    return {
      businessName: (business?.profile?.billingLegalName ?? "").trim() || business?.name || "",
      customer: { id: customer.id, name: customer.name, phone: customer.phone, email: customer.email },
      totals: {
        // Headline: ILS when present (every business today), else the first currency by code.
        outstanding: dec(outstandingBy.get(headline ?? "") ?? new Prisma.Decimal(0)),
        currency: headline,
        openInvoices: open.length,
        isMixedCurrency: outstandingBy.size > 1,
        outstandingByCurrency: [...outstandingBy.entries()]
          .sort(([a], [b]) => (a === headline ? -1 : b === headline ? 1 : a.localeCompare(b)))
          .map(([currency, amount]) => ({ currency, outstanding: dec(amount) })),
      },
      openInvoices: open,
      events,
    };
  });
}
