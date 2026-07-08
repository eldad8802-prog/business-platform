/**
 * Open-receivables read-model — a PURE DERIVATION, not a new source of truth.
 *
 * The system rule (docs/dubiz-business-obligation-domain-v1.md): a Receivable is
 * INBOUND and owned by Billing; it is never a Business Obligation and the
 * Payment Secretary never owns it. So we do NOT persist a Receivable entity.
 * Instead we derive "the customer still owes the business" directly from the
 * authoritative Billing data: an issued TAX_INVOICE with no verified (PAID)
 * PaymentRequest is an open receivable, and it stays open until a collection is
 * detected (a PaymentRequest reaches PAID — the existing verified-payment path).
 *
 * v1 scope (intentionally honest, matches the Collection Workspace v1): counts
 * the full invoice total as open. It does NOT yet net partial payments, receipt
 * allocations, or credit notes — those settlement mechanics are a later layer.
 */

import { prisma } from "@/lib/prisma";
import {
  BillingDocumentStatus,
  BillingDocumentType,
  PaymentRequestStatus,
} from "@prisma/client";

export interface OpenReceivableItem {
  documentId: number;
  documentNumber: string | null;
  customerName: string | null;
  /** Full invoice total, 2-decimal string. */
  amount: string;
  currency: string;
  issuedAt: string | null;
  /** Whole days since the invoice was issued (null if no issuedAt). */
  openDays: number | null;
}

export interface OpenReceivablesTotal {
  currency: string;
  amount: string;
  count: number;
}

export interface OpenReceivablesResult {
  items: OpenReceivableItem[];
  totals: OpenReceivablesTotal[];
  count: number;
}

function openDaysSince(issuedAt: Date | null, now: Date): number | null {
  if (!issuedAt) return null;
  const ms = now.getTime() - issuedAt.getTime();
  if (ms < 0) return 0;
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

export async function getOpenReceivables(
  businessId: number,
  now: Date = new Date()
): Promise<OpenReceivablesResult> {
  // Issued tax invoices with NO verified (PAID) payment request = still owed.
  const invoices = await prisma.billingDocument.findMany({
    where: {
      businessId,
      documentType: BillingDocumentType.TAX_INVOICE,
      status: BillingDocumentStatus.ISSUED,
      paymentRequests: { none: { status: PaymentRequestStatus.PAID } },
    },
    select: {
      id: true,
      documentNumberFormatted: true,
      customerNameSnapshot: true,
      totalAmount: true,
      currency: true,
      issuedAt: true,
    },
    orderBy: { issuedAt: "desc" },
  });

  const totalsByCurrency = new Map<string, { amount: number; count: number }>();

  const items: OpenReceivableItem[] = invoices.map((inv) => {
    const amount = Number(inv.totalAmount);
    const currency = inv.currency || "ILS";
    const bucket = totalsByCurrency.get(currency) ?? { amount: 0, count: 0 };
    bucket.amount += Number.isFinite(amount) ? amount : 0;
    bucket.count += 1;
    totalsByCurrency.set(currency, bucket);

    return {
      documentId: inv.id,
      documentNumber: inv.documentNumberFormatted,
      customerName: inv.customerNameSnapshot,
      amount: (Number.isFinite(amount) ? amount : 0).toFixed(2),
      currency,
      issuedAt: inv.issuedAt ? inv.issuedAt.toISOString() : null,
      openDays: openDaysSince(inv.issuedAt, now),
    };
  });

  const totals: OpenReceivablesTotal[] = Array.from(
    totalsByCurrency.entries()
  ).map(([currency, bucket]) => ({
    currency,
    amount: bucket.amount.toFixed(2),
    count: bucket.count,
  }));

  return { items, totals, count: items.length };
}
