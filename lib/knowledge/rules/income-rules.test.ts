/* eslint-disable @typescript-eslint/no-explicit-any -- reads heterogeneous measure-detail JSON in assertions */
/**
 * All-Feature Learning Coverage · W2 — the income side, pure proofs. No database.
 *   node_modules/.bin/tsx lib/knowledge/rules/income-rules.test.ts
 *
 * Each rule is proven on what it must learn AND on what it must refuse: credit-cancelled invoices never
 * count as paid, TAX_INVOICE_RECEIPTs never enter payment timing, immature quotes and invoices are not
 * yet evidence, documents without a customer FK teach nothing about any customer, and the reminder →
 * payment measure is labelled a sequence, never a cause.
 */
import {
  resolveSettlement, toCents,
  deriveBillingCadence, deriveBillingPaymentTiming, deriveBillingLateShare, deriveQuoteConversion, deriveCreditNoteShare,
  deriveCustomerPaymentTiming, deriveCustomerCadence, deriveCustomerTicketSize,
  deriveLinkConversion, deriveLinkTimeToPay,
  deriveReminderTiming, deriveOverdueRemindedShare, deriveSettledAfterReminderShare,
  type IncomeDocumentObservation as Doc, type QuoteObservation, type PaymentRequestObservation,
} from "./income";
import { catalogueDescriptors } from "../registry";

let failures = 0;
let total = 0;
function ok(name: string, cond: boolean, extra: unknown = ""): void {
  total += 1;
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${cond || extra === "" ? "" : " — " + JSON.stringify(extra)}`);
}
const section = (t: string) => console.log(`\n${t}`);

const BIZ = 7;
const NOW = new Date("2026-10-01T09:00:00Z");
const DAY = 86_400_000;
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);

let seq = 0;
function inv(p: Partial<Doc> & { issuedDaysAgo: number }): Doc {
  seq += 1;
  const issuedAt = ago(p.issuedDaysAgo);
  return {
    recordId: seq, businessId: BIZ, docType: "TAX_INVOICE", customerId: null, issuedAt, total: 1000,
    expectedAt: new Date(issuedAt.getTime() + 30 * DAY), settledAt: null, creditedOut: false, hasCreditNote: false,
    firstReminderAt: null, ...p,
  };
}
/** An invoice issued `issued` days ago, due 30 days later, paid `late` days after due (negative = early). */
const paid = (issued: number, late: number, extra: Partial<Doc> = {}) => {
  const d = inv({ issuedDaysAgo: issued, ...extra });
  return { ...d, settledAt: new Date((d.expectedAt as Date).getTime() + late * DAY) };
};

section("settlement — the collection screen's arithmetic, in agorot");
{
  const t = (d: number) => ago(d);
  const r1 = resolveSettlement(10000, [{ at: t(10), cents: 4000, kind: "RECEIPT" }, { at: t(5), cents: 6000, kind: "RECEIPT" }]);
  ok("settled at the receipt that completed coverage", r1.settledAt?.getTime() === t(5).getTime() && !r1.creditedOut);
  const r2 = resolveSettlement(10000, [{ at: t(10), cents: 10000, kind: "CREDIT" }]);
  ok("fully credited = cancelled, not paid", r2.settledAt === null && r2.creditedOut && r2.hasCreditNote);
  const r3 = resolveSettlement(10000, [{ at: t(10), cents: 3000, kind: "CREDIT" }, { at: t(4), cents: 7000, kind: "RECEIPT" }]);
  ok("partial credit + payment = paid, at the payment", r3.settledAt?.getTime() === t(4).getTime() && !r3.creditedOut && r3.hasCreditNote);
  const r4 = resolveSettlement(10000, [{ at: t(10), cents: 9999, kind: "RECEIPT" }]);
  ok("one agora short is not settled", r4.settledAt === null);
  ok("a zero-total invoice is never 'settled'", resolveSettlement(0, [{ at: t(1), cents: 0, kind: "RECEIPT" }]).settledAt === null);
  const a = resolveSettlement(10000, [{ at: t(3), cents: 5000, kind: "CREDIT" }, { at: t(3), cents: 5000, kind: "RECEIPT" }]);
  const b = resolveSettlement(10000, [{ at: t(3), cents: 5000, kind: "RECEIPT" }, { at: t(3), cents: 5000, kind: "CREDIT" }]);
  ok("row order does not change the answer", a.settledAt?.getTime() === b.settledAt?.getTime());
  ok("toCents is exact on Decimal strings", toCents("1234.56") === 123456 && toCents("0.10") === 10 && toCents(19.99) === 1999);
}

section("BILL-01 invoicing cadence");
{
  const rows = [10, 20, 30, 40, 50].map((d) => inv({ issuedDaysAgo: d }));
  const [m] = deriveBillingCadence(rows, NOW, BIZ);
  ok("4 gaps of 10 days → ACTIVE, median 10", m.status === "ACTIVE" && m.valueNumeric === 10, m);
  const [few] = deriveBillingCadence(rows.slice(0, 4), NOW, BIZ);
  ok("3 gaps → INSUFFICIENT_EVIDENCE (never a lowered threshold)", few.status === "INSUFFICIENT_EVIDENCE" && (few.detail as any).have === 3);
}

section("BILL-02 / BILL-03 payment timing and lateness");
{
  const rows = [paid(200, -2), paid(180, 0), paid(160, 3), paid(140, 5), paid(120, 10)];
  const receiptOnly = inv({ issuedDaysAgo: 100, docType: "TAX_INVOICE_RECEIPT", expectedAt: null, settledAt: null });
  const cancelled = { ...paid(90, 50), creditedOut: true };
  const [m] = deriveBillingPaymentTiming([...rows, receiptOnly, cancelled], NOW, BIZ);
  ok("median of signed days vs due = 3", m.status === "ACTIVE" && m.valueNumeric === 3, m);
  ok("TAX_INVOICE_RECEIPT and credit-cancelled invoices are not in the sample", m.observationCount === 5);
  const [late] = deriveBillingLateShare([...rows, cancelled], NOW, BIZ);
  ok("late share = 3 of 5 (on-time-on-the-due-day is not late)", late.valueNumeric === 0.6 && (late.detail as any).hits === 3, late);
  const unpaid = [inv({ issuedDaysAgo: 50 }), inv({ issuedDaysAgo: 60 })];
  const [none] = deriveBillingPaymentTiming(unpaid, NOW, BIZ);
  ok("unpaid invoices are not evidence of timing", none.status === "INSUFFICIENT_EVIDENCE" && none.observationCount === 0);
}

section("BILL-04 quote conversion — only matured quotes");
{
  const q = (id: number, daysAgo: number, converted: boolean, validDays: number | null = 14): QuoteObservation =>
    ({ recordId: id, businessId: BIZ, issuedAt: ago(daysAgo), validUntil: validDays === null ? null : new Date(ago(daysAgo).getTime() + validDays * DAY), converted });
  const rows = [q(1, 100, true), q(2, 90, false), q(3, 80, true), q(4, 70, false), q(5, 60, true), q(6, 5, false), q(7, 40, false, 60)];
  const [m] = deriveQuoteConversion(rows, NOW, BIZ);
  ok("young or still-valid unconverted quotes are not 'lost' yet", m.observationCount === 5, m.observationCount);
  ok("conversion = 3 of 5", m.valueNumeric === 0.6);
  const [withYoungWin] = deriveQuoteConversion([...rows, q(8, 3, true)], NOW, BIZ);
  ok("a converted quote counts at once, however young", withYoungWin.observationCount === 6);
}

section("BILL-05 credit-note share — matured invoices only");
{
  const rows = Array.from({ length: 10 }, (_, i) => inv({ issuedDaysAgo: 40 + i * 5, hasCreditNote: i < 2 }));
  const young = inv({ issuedDaysAgo: 10, hasCreditNote: true });
  const [m] = deriveCreditNoteShare([...rows, young], NOW, BIZ);
  ok("2 of 10 matured invoices credited; the young one waits", m.valueNumeric === 0.2 && m.observationCount === 10, m);
}

section("CUST-01..03 — per customer, by foreign key only");
{
  const rows = [
    paid(200, 2, { customerId: 11, total: 500 }), paid(150, 4, { customerId: 11, total: 700 }), paid(100, 6, { customerId: 11, total: 600 }),
    paid(190, -1, { customerId: 12 }), paid(90, -3, { customerId: 12 }),
    paid(180, 30), paid(170, 30), paid(160, 30), // no customer FK
  ];
  const timing = deriveCustomerPaymentTiming(rows, NOW, BIZ);
  ok("one measure per customer with a FK, none for FK-less documents", timing.length === 2 && timing.every((m) => m.entityType === "customer"));
  const c11 = timing.find((m) => m.entityId === 11)!;
  const c12 = timing.find((m) => m.entityId === 12)!;
  ok("customer 11 pays a median 4 days late", c11.status === "ACTIVE" && c11.valueNumeric === 4, c11);
  ok("customer 12 with 2 payments stays INSUFFICIENT_EVIDENCE", c12.status === "INSUFFICIENT_EVIDENCE");
  const ticket = deriveCustomerTicketSize(rows, NOW, BIZ).find((m) => m.entityId === 11)!;
  ok("customer 11 ticket median 600", ticket.valueNumeric === 600 && ticket.valueUnit === "currency");
  const cad = deriveCustomerCadence(rows, NOW, BIZ).find((m) => m.entityId === 11)!;
  ok("customer 11 cadence: 2 gaps < 3 → INSUFFICIENT_EVIDENCE", cad.status === "INSUFFICIENT_EVIDENCE");
  ok("measures emitted in canonical customer order", timing.map((m) => m.entityId).join() === "11,12");
}

section("PAY-01 / PAY-02 payment links");
{
  let id = 0;
  const pr = (p: Partial<PaymentRequestObservation> & { createdDaysAgo: number }): PaymentRequestObservation => ({
    recordId: ++id, businessId: BIZ, customerId: null, createdAt: ago(p.createdDaysAgo), status: "PENDING", paidAt: null, expiresAt: null, ...p,
  });
  const rows = [
    pr({ createdDaysAgo: 50, status: "PAID", paidAt: ago(49) }), pr({ createdDaysAgo: 40, status: "PAID", paidAt: ago(37) }),
    pr({ createdDaysAgo: 30, status: "PAID", paidAt: ago(28) }), pr({ createdDaysAgo: 25, status: "EXPIRED" }),
    pr({ createdDaysAgo: 20, status: "CANCELLED" }), pr({ createdDaysAgo: 18, status: "PAID", paidAt: ago(16) }),
    pr({ createdDaysAgo: 15, status: "PAID", paidAt: ago(14) }),
    pr({ createdDaysAgo: 2 }), // still open
    pr({ createdDaysAgo: 30, expiresAt: ago(10) }), // pending but expired: resolved, not paid
  ];
  const [conv] = deriveLinkConversion(rows, NOW, BIZ);
  ok("open links wait; lapsed pending links count as not paid", conv.observationCount === 8 && conv.valueNumeric === 0.63, conv);
  const [ttp] = deriveLinkTimeToPay(rows, NOW, BIZ);
  ok("time to pay median 2 days over 5 paid links", ttp.status === "ACTIVE" && ttp.valueNumeric === 2 && ttp.observationCount === 5, ttp);
}

section("COLL-01..03 collection — timing, coverage, and a sequence that is never a cause");
{
  const due = (d: Doc) => (d.expectedAt as Date).getTime();
  const rem = (d: Doc, afterDue: number): Doc => ({ ...d, firstReminderAt: new Date(due(d) + afterDue * DAY) });
  const a = rem(paid(200, 12), 8);   // reminded day 8, paid day 12 → within 14
  const b = rem(paid(180, 30), 10);  // reminded day 10, paid day 30 → not within 14
  const c = rem(paid(160, 15), 5);   // within 14
  const d = rem(inv({ issuedDaysAgo: 140 }), 6); // unpaid, window long closed → miss
  const e = rem(paid(120, 9), 7);    // within
  const early = rem(paid(110, -1), 3);  // paid before reminder → outside COLL-03 population
  const fresh = rem(inv({ issuedDaysAgo: 40 }), 5); // reminder 5 days ago-ish, window still open → waits
  const [timing] = deriveReminderTiming([a, b, c, d, e], NOW, BIZ);
  ok("first reminder lands a median 7 days after due", timing.status === "ACTIVE" && timing.valueNumeric === 7, timing);
  const [seq] = deriveSettledAfterReminderShare([a, b, c, d, e, early, fresh], NOW, BIZ);
  ok("3 of 5 settled within 14 days of the first reminder", seq.valueNumeric === 0.6 && seq.observationCount === 5, seq);
  ok("labelled SEQUENCE_NOT_CAUSE", (seq.detail as any)?.caveat === "SEQUENCE_NOT_CAUSE");

  const overdueUnreminded = [paid(300, 20), paid(280, 25), inv({ issuedDaysAgo: 100 })];
  const onTime = paid(260, 2); // paid within the grace: never overdue
  const [cov] = deriveOverdueRemindedShare([a, b, c, d, e, ...overdueUnreminded, onTime], NOW, BIZ);
  ok("overdue population excludes invoices paid within grace", cov.observationCount === 8, cov.observationCount);
  ok("reminded share = 5 of 8", cov.valueNumeric === 0.63, cov);
}

section("catalogue — the income rules are registered once, in their own domains");
{
  const d = catalogueDescriptors();
  const ids = ["BILL-01", "BILL-02", "BILL-03", "BILL-04", "BILL-05", "CUST-01", "CUST-02", "CUST-03", "PAY-01", "PAY-02", "COLL-01", "COLL-02", "COLL-03"];
  ok("all 13 income rules registered exactly once", ids.every((i) => d.filter((x) => x.ruleId === i).length === 1));
  ok("measure-key prefix = domain (BKS derives domain from it)", d.filter((x) => ids.includes(x.ruleId)).every((x) => x.measureKey.startsWith(`${x.domain}.`)));
  ok("policy keys and measure keys are unique across the catalogue",
    new Set(d.map((x) => x.policyKey)).size === d.length && new Set(d.map((x) => x.measureKey)).size === d.length);
  ok("customer rules are the only ones keyed on `customer`", d.filter((x) => x.entityType === "customer").map((x) => x.ruleId).join() === "CUST-01,CUST-02,CUST-03");
}

console.log(`\n${total - failures}/${total} passed`);
if (failures > 0) { console.error(`${failures} FAILED`); process.exit(1); }
console.log("Income rules: learn from the ledger, refuse what is not yet evidence, never call a sequence a cause. ✔");
