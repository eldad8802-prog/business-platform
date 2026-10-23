/**
 * Revenue truth — the loader: the database → the read model's evidence. READ-ONLY. docs/revenue-truth-milestone-a.md.
 *
 * Reads the new Revenue* tables and, IN PLACE (never copied, never written), the existing:
 *   BillingDocument     status ISSUED: tax invoices / invoice-receipts (sales), credit notes (refunds),
 *                       receipts (money in, unless issued for a payment);
 *   PaymentTransaction  status PAID (money in; a refund is negative), tenant-scoped through its PaymentRequest;
 *   ExternalTransaction direction CREDIT (bank money in).
 * Deliberately NOT read: FinancialEvent (it books an invoice AND its payment as two INCOME rows) and
 * FinancialRecord (an approved upload is not proof of a sale — an open owner decision).
 *
 * The window is per layer, by the date that layer carries (sale / receipt / Z: business day; settlement: value date;
 * document: issue day; payment: creation day; bank: booking day). A settlement or a deposit that lands after the
 * window is simply not in it — the view then shows the money as still in transit.
 *
 * NOT CONNECTED: nothing calls this in milestone A except the lab battery.
 */
import { moneyFromDecimal } from "@/lib/money/money";
import { parseCurrency, isSupportedCurrency, type CurrencyCode } from "@/lib/money/currency";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { jerusalemDayKey, jerusalemDayUtcHalfOpen, type JerusalemDayKey } from "@/lib/utils/jerusalem-day";
import { computeRevenueView, type RevenueView } from "./read-model";
import type { DubizDocument, RevenueInputs } from "./types";

export type RevenueWindow = { fromDay: JerusalemDayKey; toDay: JerusalemDayKey };

/** Rows the loader could not express without guessing (an unsupported currency) — reported, never summed. */
export type SkippedRow = { table: string; id: number; reason: "UNSUPPORTED_CURRENCY" };

const dateOf = (day: JerusalemDayKey) => new Date(`${day}T00:00:00.000Z`);
const dayOf = (d: Date): JerusalemDayKey => d.toISOString().slice(0, 10);
const minor = (amount: { toString(): string }, currency: string) => moneyFromDecimal(amount.toString(), currency).minor;

export async function loadRevenueInputs(businessId: number, window: RevenueWindow): Promise<{ inputs: RevenueInputs; skipped: SkippedRow[] }> {
  const from = dateOf(window.fromDay);
  const to = dateOf(window.toDay);
  const instants = { gte: jerusalemDayUtcHalfOpen(window.fromDay).from, lt: jerusalemDayUtcHalfOpen(window.toDay).toExclusive };
  const skipped: SkippedRow[] = [];
  const supported = (table: string, id: number, currency: string): currency is CurrencyCode => {
    if (isSupportedCurrency(currency)) return true;
    skipped.push({ table, id, reason: "UNSUPPORTED_CURRENCY" });
    return false;
  };

  const inputs = await tenantTx(businessId, async (tx) => {
    const [sales, receipts, closes, settlements, documents, payments, deposits] = await Promise.all([
      tx.revenueSale.findMany({ where: { businessId, businessDay: { gte: from, lte: to } } }),
      tx.revenueReceipt.findMany({ where: { businessId, businessDay: { gte: from, lte: to } } }),
      tx.revenueDailyClose.findMany({ where: { businessId, businessDay: { gte: from, lte: to } }, include: { tenders: true } }),
      tx.revenueSettlement.findMany({ where: { businessId, valueDate: { gte: from, lte: to } } }),
      tx.billingDocument.findMany({
        where: { businessId, status: "ISSUED", documentType: { in: ["TAX_INVOICE", "TAX_INVOICE_RECEIPT", "CREDIT_NOTE", "RECEIPT"] }, issuedAt: instants },
        select: { id: true, documentType: true, currency: true, totalAmount: true, vatAmount: true, referenceDocumentId: true, sourcePaymentTransactionId: true },
      }),
      tx.paymentTransaction.findMany({
        where: { status: "PAID", paymentRequest: { businessId }, createdAt: instants },
        select: { id: true, amount: true, currency: true },
      }),
      tx.externalTransaction.findMany({
        where: { businessId, direction: "CREDIT", bookedAt: instants },
        select: { id: true, amount: true, currency: true },
      }),
    ]);

    const ids = {
      sale: sales.map((s) => s.id), receipt: receipts.map((r) => r.id), close: closes.map((c) => c.id),
      tender: closes.flatMap((c) => c.tenders.map((t) => t.id)), settlement: settlements.map((s) => s.id),
      bank: deposits.map((d) => d.id), document: documents.map((d) => d.id),
    };
    const links = await tx.revenueLink.findMany({
      where: {
        businessId,
        OR: [
          { saleId: { in: ids.sale } }, { receiptId: { in: ids.receipt } }, { dailyCloseTenderId: { in: ids.tender } },
          { settlementId: { in: ids.settlement } }, { externalTransactionId: { in: ids.bank } }, { billingDocumentId: { in: ids.document } },
        ],
      },
    });
    const decisions = await tx.revenueDecision.findMany({
      where: { businessId, OR: [{ linkId: { in: links.map((l) => l.id) } }, { dailyCloseId: { in: ids.close } }] },
      select: { id: true, linkId: true, dailyCloseId: true, decision: true },
    });

    const out: RevenueInputs = {
      sales: sales.map((s) => ({
        id: s.id, sourceScope: s.sourceScope, registerKey: s.registerKey, businessDay: dayOf(s.businessDay), kind: s.kind,
        currency: parseCurrency(s.currency), grossMinor: s.grossMinor, discountMinor: s.discountMinor, totalMinor: s.totalMinor, vatMinor: s.vatMinor,
      })),
      receipts: receipts.map((r) => ({
        id: r.id, sourceScope: r.sourceScope, registerKey: r.registerKey, businessDay: dayOf(r.businessDay), direction: r.direction,
        method: r.method, currency: parseCurrency(r.currency), amountMinor: r.receivedMinor,
      })),
      closes: closes.map((c) => ({
        id: c.id, sourceScope: c.sourceScope, salesScope: c.salesScope, registerKey: c.registerKey, externalId: c.externalId,
        revision: c.revision, capture: c.capture, validation: c.validation, businessDay: dayOf(c.businessDay), currency: parseCurrency(c.currency),
        grossMinor: c.grossMinor, discountMinor: c.discountMinor, refundMinor: c.refundMinor, voidMinor: c.voidMinor,
        totalMinor: c.totalMinor, vatMinor: c.vatMinor,
        tenders: c.tenders.map((t) => ({ id: t.id, method: t.method, amountMinor: t.amountMinor })),
      })),
      settlements: settlements.map((s) => ({
        id: s.id, validation: s.validation, currency: parseCurrency(s.currency), grossMinor: s.grossMinor,
        feeMinor: s.feeMinor, otherDeductionsMinor: s.otherDeductionsMinor, netMinor: s.netMinor,
      })),
      deposits: deposits.filter((d) => supported("ExternalTransaction", d.id, d.currency)).map((d) => ({
        id: d.id, currency: d.currency as CurrencyCode, amountMinor: minor(d.amount, d.currency),
      })),
      documents: documents.filter((d) => supported("BillingDocument", d.id, d.currency)).map((d): DubizDocument => ({
        id: d.id, documentType: d.documentType as DubizDocument["documentType"], currency: d.currency as CurrencyCode,
        totalMinor: minor(d.totalAmount, d.currency), vatMinor: minor(d.vatAmount, d.currency),
        referenceDocumentId: d.referenceDocumentId, sourcePaymentTransactionId: d.sourcePaymentTransactionId,
      })),
      payments: payments.filter((p) => supported("PaymentTransaction", p.id, p.currency)).map((p) => ({
        id: p.id, currency: p.currency as CurrencyCode, amountMinor: minor(p.amount, p.currency),
      })),
      links: links.map((l) => ({
        id: l.id, linkKind: l.linkKind, saleId: l.saleId, receiptId: l.receiptId, dailyCloseTenderId: l.dailyCloseTenderId,
        settlementId: l.settlementId, externalTransactionId: l.externalTransactionId, billingDocumentId: l.billingDocumentId,
        amountMinor: l.linkedMinor, currency: parseCurrency(l.currency),
      })),
      decisions,
    };
    return out;
  });
  return { inputs, skipped };
}

/** Load the window and compute the view. `now` decides which register days are still PROVISIONAL. */
export async function readRevenueView(businessId: number, window: RevenueWindow, now: Date = new Date()): Promise<{ view: RevenueView; skipped: SkippedRow[] }> {
  const { inputs, skipped } = await loadRevenueInputs(businessId, window);
  return { view: computeRevenueView(inputs, { today: jerusalemDayKey(now) }), skipped };
}
