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
   * Index-friendly narrowing, NOT the rule.
   *
   * The rule is `isAwaitingPayment`, which counts calendar days in Israel and
   * still runs on every row that comes back. This bound only keeps invoices that
   * cannot possibly be due out of memory, so that the query stays on the
   * `[businessId, status, issuedAt]` index.
   *
   * It is deliberately widened by one day. Millisecond arithmetic and calendar
   * arithmetic disagree at the edges — by an hour across a DST change, and by up
   * to a day depending on the time of issuance — so an exact bound could exclude
   * a row the real rule would have selected, silently dropping a debt from the
   * list. A one-day margin makes the filter a strict over-approximation: it may
   * admit a few rows that the rule then rejects, which costs nothing, and it can
   * never hide one.
   */
  const PREFILTER_MARGIN_DAYS = 1;
  const dueBefore = new Date(
    now.getTime() - (termsDays - PREFILTER_MARGIN_DAYS) * MS_PER_DAY,
  );

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
