/**
 * Collection · "awaiting payment" loader — the only place this feature touches
 * the database.
 *
 * Read-only by construction. It reads issued invoices, what has been paid
 * against them and what has been credited, hands the rows to the pure rules in
 * `awaiting-payment.rules.ts`, and returns the list. It writes nothing, issues
 * nothing, and changes no document state — a collection screen must never be
 * able to alter a legal record.
 *
 * The split is deliberate: every decision about what counts as a debt lives in
 * the pure module where it can be tested exhaustively without a database. This
 * file only knows how to fetch.
 */

import { BillingDocumentStatus, BillingDocumentType, Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import {
  buildAwaitingPaymentList,
  type AwaitingPaymentList,
  type InvoiceRow,
} from "./awaiting-payment.rules";
import { resolvePaymentTermsDays } from "./payment-terms";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ZERO = new Prisma.Decimal(0);

/**
 * Load the list of customers who owe this business money right now.
 *
 * `now` is injected so the caller — and the tests — control the clock.
 */
export async function loadAwaitingPaymentList(
  businessId: number,
  now: Date = new Date(),
): Promise<AwaitingPaymentList> {
  const profile = await prisma.businessProfile.findUnique({
    where: { businessId },
    select: { billingPaymentTermsDays: true },
  });

  const termsDays = resolvePaymentTermsDays(profile?.billingPaymentTermsDays ?? null);

  /**
   * An invoice is awaited once `issuedAt + terms` is in the past, so anything
   * issued on or after this instant cannot be due yet. Filtering here rather
   * than in JavaScript keeps the query on the
   * `[businessId, status, issuedAt]` index and keeps not-yet-due invoices out
   * of memory entirely. It is exactly equivalent to the pure `isAwaitingPayment`
   * check, which still runs on every row.
   */
  const dueBefore = new Date(now.getTime() - termsDays * MS_PER_DAY);

  const documents = await prisma.billingDocument.findMany({
    where: {
      businessId,
      documentType: BillingDocumentType.TAX_INVOICE,
      status: BillingDocumentStatus.ISSUED,
      issuedAt: { not: null, lt: dueBefore },
    },
    select: {
      id: true,
      documentNumberFormatted: true,
      documentType: true,
      status: true,
      issuedAt: true,
      totalAmount: true,
      currency: true,
      customerId: true,
      customerNameSnapshot: true,
      customer: { select: { name: true, phone: true, email: true } },
      // What has been paid against this invoice.
      paymentAllocationsAsInvoice: { select: { allocatedAmount: true } },
      // D3 — only an ISSUED credit note reduces the balance. A draft credit
      // note is an intention, not a reversal, and must not remove a real debt.
      creditNotes: {
        where: {
          documentType: BillingDocumentType.CREDIT_NOTE,
          status: BillingDocumentStatus.ISSUED,
        },
        select: { totalAmount: true },
      },
    },
    orderBy: { issuedAt: "asc" },
  });

  const rows: InvoiceRow[] = documents.map((doc) => ({
    id: doc.id,
    documentNumber: doc.documentNumberFormatted,
    type: doc.documentType,
    status: doc.status,
    issuedAt: doc.issuedAt,
    totalAmount: doc.totalAmount,
    currency: doc.currency,
    allocatedAmount: doc.paymentAllocationsAsInvoice.reduce(
      (sum, a) => sum.plus(a.allocatedAmount),
      ZERO,
    ),
    creditedAmount: doc.creditNotes.reduce(
      (sum, c) => sum.plus(c.totalAmount),
      ZERO,
    ),
    customerId: doc.customerId,
    // The live customer name is what the owner is about to message; the
    // snapshot is the fallback for a customer row that has since been removed.
    customerName: doc.customer?.name ?? doc.customerNameSnapshot,
    customerPhone: doc.customer?.phone ?? null,
    customerEmail: doc.customer?.email ?? null,
  }));

  return buildAwaitingPaymentList({
    rows,
    configuredTermsDays: profile?.billingPaymentTermsDays ?? null,
    now,
  });
}
