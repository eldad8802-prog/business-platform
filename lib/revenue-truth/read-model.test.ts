/**
 * Revenue truth — the read model's rules, proven without a database. docs/revenue-truth-milestone-a.md.
 * Every scenario is synthetic. The database-side proofs (isolation, idempotent ingestion, the existing systems
 * left untouched) are in .rev/app-battery.ts.
 *
 * Run: npx tsx lib/revenue-truth/read-model.test.ts
 */
import { CurrencyMismatchError } from "@/lib/money/money";
import { computeRevenueView, requireSingleCurrency, type CurrencyView, type RevenueView } from "./read-model";
import { emptyInputs, type DailyClose, type Decision, type Link, type RevenueInputs } from "./types";

let total = 0;
let failures = 0;
function check(name: string, cond: boolean, extra = ""): void {
  total += 1;
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra && !cond ? " — " + extra : ""}`);
}
const B = (n: number) => BigInt(n);
const TODAY = "2026-10-23";
const J = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x instanceof Map ? Object.fromEntries(x) : x));

function ils(view: RevenueView): CurrencyView {
  const v = view.byCurrency.get("ILS");
  if (!v) throw new Error("no ILS view");
  return v;
}
function inputs(patch: Partial<RevenueInputs>): RevenueInputs {
  return { ...emptyInputs(), ...patch };
}
let nextId = 1000;
const id = () => ++nextId;
const sale = (o: { kind?: "SALE" | "REFUND" | "VOID"; total: number; vat: number; day?: string; register?: string | null; scope?: string; currency?: "ILS" | "USD"; discount?: number; sid?: number }) => ({
  id: o.sid ?? id(), sourceScope: o.scope ?? "pos.a", registerKey: o.register === undefined ? "r1" : o.register, businessDay: o.day ?? "2026-10-20",
  kind: o.kind ?? "SALE", currency: o.currency ?? "ILS",
  grossMinor: B(o.total + (o.discount ?? 0)), discountMinor: B(o.discount ?? 0), totalMinor: B(o.total), vatMinor: B(o.vat),
}) as RevenueInputs["sales"][number];
const close = (o: Partial<DailyClose> & { total: number; vat: number }): DailyClose => ({
  id: o.id ?? id(), sourceScope: o.sourceScope ?? "upload.z", salesScope: o.salesScope === undefined ? "pos.a" : o.salesScope,
  registerKey: o.registerKey ?? "r1", externalId: o.externalId ?? `z${nextId}`, revision: o.revision ?? 1,
  capture: o.capture ?? "FILE_STRUCTURED", validation: o.validation ?? "PASSED", businessDay: o.businessDay ?? "2026-10-20",
  currency: o.currency ?? "ILS", grossMinor: o.grossMinor ?? B(o.total), discountMinor: o.discountMinor ?? B(0),
  refundMinor: o.refundMinor ?? B(0), voidMinor: o.voidMinor ?? B(0), totalMinor: B(o.total), vatMinor: B(o.vat),
  tenders: o.tenders ?? [],
});
const link = (o: Partial<Link> & { linkKind: Link["linkKind"] }): Link => ({
  id: o.id ?? id(), saleId: null, receiptId: null, dailyCloseTenderId: null, settlementId: null, externalTransactionId: null,
  billingDocumentId: null, amountMinor: null, currency: "ILS", ...o,
});
const decide = (o: Partial<Decision> & { decision: Decision["decision"] }): Decision => ({ id: id(), linkId: null, dailyCloseId: null, saleId: null, receiptId: null, settlementId: null, ...o });

// ─────────────────────────────────────────────────────────────────────────────────────────────────
console.log("1. an invoice and the payment for it are ONE sale");
{
  const v = computeRevenueView(inputs({
    documents: [
      { id: 1, documentType: "TAX_INVOICE", currency: "ILS", totalMinor: B(11800), vatMinor: B(1800), referenceDocumentId: null, sourcePaymentTransactionId: null },
      // the system receipt issued for the payment below
      { id: 2, documentType: "RECEIPT", currency: "ILS", totalMinor: B(11800), vatMinor: B(0), referenceDocumentId: null, sourcePaymentTransactionId: 77 },
    ],
    payments: [{ id: 77, currency: "ILS", amountMinor: B(11800) }],
  }), { today: TODAY });
  const s = ils(v).sales;
  check("net sales = the invoice once (11800), not invoice + payment", s.netMinor === B(11800), J(s));
  check("VAT = the invoice's VAT once (1800)", s.vatMinor === B(1800));
  check("money in = the payment once: the system receipt for it is the same receipt", ils(v).receipts.inMinor === B(11800), J(ils(v).receipts));
  check("the system receipt is excluded as SAME_RECEIPT_AS_PAYMENT", v.excluded.some((e) => e.kind === "DOCUMENT" && e.id === 2 && e.reason === "SAME_RECEIPT_AS_PAYMENT"));
  check("money in is attributed to the payment provider", ils(v).receipts.byChannel.PAYMENT_PROVIDER === B(11800));
}

console.log("2. a POS sale and the Z report for the same day are counted once");
{
  const s1 = sale({ total: 11800, vat: 1800 });
  const z = close({ total: 11800, vat: 1800 });
  const v = computeRevenueView(inputs({ sales: [s1], closes: [z] }), { today: TODAY });
  check("net = 11800 (the Z), not 23600", ils(v).sales.netMinor === B(11800), J(ils(v).sales));
  check("the POS sale is excluded as COVERED_BY_CLOSE", v.excluded.some((e) => e.kind === "SALE" && e.id === s1.id && e.reason === "COVERED_BY_CLOSE"));
  check("the day is CLOSED with zero variance", v.days.length === 1 && v.days[0].status === "CLOSED" && v.days[0].varianceMinor === B(0), J(v.days));
  check("closed net = 11800, provisional = 0", ils(v).sales.closedNetMinor === B(11800) && ils(v).sales.provisionalNetMinor === B(0));
  const zMore = close({ total: 12000, vat: 1831 });
  const v2 = computeRevenueView(inputs({ sales: [s1], closes: [zMore] }), { today: TODAY });
  check("a Z that differs from the POS stream counts the Z once and reports the variance (+200)",
    ils(v2).sales.netMinor === B(12000) && v2.days[0].status === "CLOSED_WITH_VARIANCE" && v2.days[0].varianceMinor === B(200), J(v2.days));
  const twoShifts = computeRevenueView(inputs({ sales: [s1], closes: [close({ total: 6000, vat: 915 }), close({ total: 5800, vat: 885 })] }), { today: TODAY });
  check("two Z reports for one register day (two shifts) together close it once", ils(twoShifts).sales.netMinor === B(11800) && twoShifts.days[0].status === "CLOSED", J(twoShifts.days));
  const otherRegister = computeRevenueView(inputs({ sales: [s1], closes: [close({ total: 11800, vat: 1800, registerKey: "r2" })] }), { today: TODAY });
  check("a Z of ANOTHER register does not cover this register's sales (both counted, two days)",
    ils(otherRegister).sales.netMinor === B(23600) && otherRegister.days.length === 2, J(otherRegister.days));
}

console.log("3. a bank deposit never creates revenue");
{
  const v = computeRevenueView(inputs({ deposits: [{ id: 5, currency: "ILS", amountMinor: B(50000) }] }), { today: TODAY });
  check("sales are zero", ils(v).sales.netMinor === B(0) && ils(v).sales.grossMinor === B(0));
  check("the credit is money in the bank, unmatched", ils(v).deposits.creditsMinor === B(50000) && ils(v).deposits.unmatchedMinor === B(50000));
  check("no receipt is invented from a deposit", ils(v).receipts.inMinor === B(0));
  const s1 = sale({ total: 11800, vat: 1800 });
  const withSale = computeRevenueView(inputs({ sales: [s1], deposits: [{ id: 5, currency: "ILS", amountMinor: B(11800) }] }), { today: TODAY });
  check("a sale plus a deposit of the same amount is still ONE sale", ils(withSale).sales.netMinor === B(11800));
}

console.log("4. a partial settlement creates no sale");
{
  const s1 = sale({ total: 11800, vat: 1800, day: TODAY });
  const r1 = { id: id(), sourceScope: "pos.a", registerKey: "r1", businessDay: TODAY, direction: "IN" as const, method: "CARD" as const, currency: "ILS" as const, amountMinor: B(11800) };
  const st = { id: id(), validation: "PASSED" as const, currency: "ILS" as const, grossMinor: B(4000), feeMinor: B(40), otherDeductionsMinor: B(0), netMinor: B(3960) };
  const l1 = link({ linkKind: "TENDER_SETTLED_BY", receiptId: r1.id, settlementId: st.id, amountMinor: B(4000) });
  const base = inputs({ sales: [s1], receipts: [r1] });
  const before = computeRevenueView(base, { today: TODAY });
  const after = computeRevenueView({ ...base, settlements: [st], links: [l1], decisions: [decide({ linkId: l1.id, decision: "CONFIRMED" })] }, { today: TODAY });
  check("sales unchanged by the settlement (11800 → 11800)", ils(before).sales.netMinor === B(11800) && ils(after).sales.netMinor === B(11800));
  check("card awaiting settlement drops by the settled part (11800 → 7800)",
    ils(before).inTransit.cardAwaitingSettlementMinor === B(11800) && ils(after).inTransit.cardAwaitingSettlementMinor === B(7800), J(ils(after).inTransit));
  check("the fee is the settlement's gross − net (40)", ils(after).settlements.feesMinor === B(40));
  check("the settlement net awaits its bank credit (3960)", ils(after).inTransit.settlementAwaitingDepositMinor === B(3960));
  const unconfirmed = computeRevenueView({ ...base, settlements: [st], links: [l1] }, { today: TODAY });
  check("an UNCONFIRMED link closes nothing", ils(unconfirmed).inTransit.cardAwaitingSettlementMinor === B(11800));
}

console.log("5. installments do not grow sales on every credit date");
{
  const s1 = sale({ total: 12000, vat: 1831, day: TODAY });
  const r1 = { id: id(), sourceScope: "pos.a", registerKey: "r1", businessDay: TODAY, direction: "IN" as const, method: "CARD" as const, currency: "ILS" as const, amountMinor: B(12000) };
  const installments = [1, 2, 3].map(() => ({ id: id(), validation: "PASSED" as const, currency: "ILS" as const, grossMinor: B(4000), feeMinor: B(30), otherDeductionsMinor: B(0), netMinor: B(3970) }));
  const links = installments.map((st) => link({ linkKind: "TENDER_SETTLED_BY", receiptId: r1.id, settlementId: st.id, amountMinor: B(4000) }));
  const decisions = links.map((l) => decide({ linkId: l.id, decision: "CONFIRMED" }));
  const nets: bigint[] = [];
  const awaiting: bigint[] = [];
  for (let k = 0; k <= 3; k++) {
    const v = computeRevenueView(inputs({ sales: [s1], receipts: [r1], settlements: installments.slice(0, k), links: links.slice(0, k), decisions: decisions.slice(0, k) }), { today: TODAY });
    nets.push(ils(v).sales.netMinor);
    awaiting.push(ils(v).inTransit.cardAwaitingSettlementMinor);
  }
  check("net sales 12000 after 0, 1, 2 and 3 installments", nets.every((n) => n === B(12000)), nets.join(","));
  check("card awaiting settlement 12000 → 8000 → 4000 → 0", awaiting.join(",") === "12000,8000,4000,0", awaiting.join(","));
}

console.log("6. refunds and voids, without duplicates");
{
  const s1 = sale({ total: 11800, vat: 1800, day: TODAY });
  const rf = sale({ kind: "REFUND", total: 2000, vat: 305, day: TODAY });
  const vd = sale({ kind: "VOID", total: 500, vat: 76, day: TODAY });
  const v = computeRevenueView(inputs({ sales: [s1, rf, vd, rf] }), { today: TODAY });
  const s = ils(v).sales;
  check("gross 11800, refunds 2000, voids 500, net 9300", s.grossMinor === B(11800) && s.refundsMinor === B(2000) && s.voidsMinor === B(500) && s.netMinor === B(9300), J(s));
  check("VAT nets the refund and the void (1800 − 305 − 76 = 1419)", s.vatMinor === B(1419), String(s.vatMinor));
  check("the refund loaded twice counts once", s.refundsMinor === B(2000));
  check("net ex-VAT = 9300 − 1419", s.netExVatMinor === B(9300 - 1419));
  const z = close({ total: 9300, vat: 1419, grossMinor: B(11800), refundMinor: B(2000), voidMinor: B(500), businessDay: TODAY });
  const vz = computeRevenueView(inputs({ sales: [s1, rf, vd], closes: [z] }), { today: TODAY });
  check("with the day's Z: refunds and voids from the Z once, net 9300, variance 0",
    ils(vz).sales.netMinor === B(9300) && ils(vz).sales.refundsMinor === B(2000) && vz.days[0].varianceMinor === B(0), J(vz.days));
  const credit = computeRevenueView(inputs({
    documents: [
      { id: 1, documentType: "TAX_INVOICE", currency: "ILS", totalMinor: B(11800), vatMinor: B(1800), referenceDocumentId: null, sourcePaymentTransactionId: null },
      { id: 2, documentType: "CREDIT_NOTE", currency: "ILS", totalMinor: B(5900), vatMinor: B(900), referenceDocumentId: 1, sourcePaymentTransactionId: null },
    ],
    payments: [{ id: 9, currency: "ILS", amountMinor: B(11800) }, { id: 10, currency: "ILS", amountMinor: B(-5900) }],
  }), { today: TODAY });
  check("a credit note is a refund of the invoice (net 5900, VAT 900)", ils(credit).sales.netMinor === B(5900) && ils(credit).sales.vatMinor === B(900), J(ils(credit).sales));
  check("a provider refund is money paid back (in 11800, out 5900)", ils(credit).receipts.inMinor === B(11800) && ils(credit).receipts.outMinor === B(5900));
}

console.log("7. the same event twice is one event");
{
  const s1 = sale({ total: 11800, vat: 1800, day: TODAY });
  const v = computeRevenueView(inputs({ sales: [s1, s1, { ...s1 }], payments: [{ id: 3, currency: "ILS", amountMinor: B(100) }, { id: 3, currency: "ILS", amountMinor: B(100) }] }), { today: TODAY });
  check("a sale loaded three times counts once", ils(v).sales.netMinor === B(11800));
  check("a payment loaded twice counts once", ils(v).receipts.inMinor === B(100));
}

console.log("8. currencies are never added together");
{
  const v = computeRevenueView(inputs({ sales: [sale({ total: 11800, vat: 1800, day: TODAY }), sale({ total: 5000, vat: 763, currency: "USD", day: TODAY, scope: "pos.us" })] }), { today: TODAY });
  check("ILS and USD are two separate views", v.byCurrency.size === 2 && ils(v).sales.netMinor === B(11800) && v.byCurrency.get("USD")!.sales.netMinor === B(5000));
  let threw: unknown = null;
  try { requireSingleCurrency(v); } catch (e) { threw = e; }
  check("asking a mixed view for one figure throws CurrencyMismatchError", threw instanceof CurrencyMismatchError);
  const one = computeRevenueView(inputs({ sales: [sale({ total: 100, vat: 15, day: TODAY })] }), { today: TODAY });
  check("a single-currency view answers with its one figure", requireSingleCurrency(one)?.sales.netMinor === B(100));
  check("an empty view has no figure (null), not zero in some currency", requireSingleCurrency(computeRevenueView(emptyInputs(), { today: TODAY })) === null);
}

console.log("9. which Z closes a day");
{
  const s1 = sale({ total: 11800, vat: 1800 });
  const photo = close({ total: 11800, vat: 1800, capture: "FILE_EXTRACTED" });
  const pending = computeRevenueView(inputs({ sales: [s1], closes: [photo] }), { today: TODAY });
  check("a Z read from a photo, not yet confirmed, does not close the day (UNCLOSED, POS counted)",
    pending.days[0].status === "UNCLOSED" && pending.days[0].awaitingConfirmationCloseIds[0] === photo.id && ils(pending).sales.unclosedNetMinor === B(11800), J(pending.days));
  const confirmedZ = computeRevenueView(inputs({ sales: [s1], closes: [photo], decisions: [decide({ dailyCloseId: photo.id, decision: "CONFIRMED" })] }), { today: TODAY });
  check("once the owner confirms it, it closes the day (counted once)", confirmedZ.days[0].status === "CLOSED" && ils(confirmedZ).sales.netMinor === B(11800));
  const rejected = computeRevenueView(inputs({ sales: [s1], closes: [close({ id: 9001, total: 99999, vat: 0 })], decisions: [decide({ dailyCloseId: 9001, decision: "REJECTED" })] }), { today: TODAY });
  check("a rejected Z is excluded; the POS stream counts", ils(rejected).sales.netMinor === B(11800) && rejected.excluded.some((e) => e.id === 9001 && e.reason === "CLOSE_REJECTED"));
  const failed = computeRevenueView(inputs({ sales: [s1], closes: [close({ id: 9002, total: 1, vat: 0, validation: "FAILED" })] }), { today: TODAY });
  check("a Z that failed validation is excluded", ils(failed).sales.netMinor === B(11800) && failed.excluded.some((e) => e.id === 9002 && e.reason === "VALIDATION_FAILED"));
  const r1 = close({ id: 9003, externalId: "z55", total: 11000, vat: 1678 });
  const r2 = close({ id: 9004, externalId: "z55", revision: 2, total: 11800, vat: 1800 });
  const revised = computeRevenueView(inputs({ sales: [s1], closes: [r1, r2] }), { today: TODAY });
  check("a corrected Z (revision 2) replaces revision 1; revision 1 is kept and excluded as SUPERSEDED",
    ils(revised).sales.netMinor === B(11800) && revised.excluded.some((e) => e.id === 9003 && e.reason === "SUPERSEDED"), J(revised.excluded));
  const today = computeRevenueView(inputs({ sales: [sale({ total: 500, vat: 76, day: TODAY })] }), { today: TODAY });
  check("today without a Z is PROVISIONAL; a past day without one is UNCLOSED",
    today.days[0].status === "PROVISIONAL" && ils(today).sales.provisionalNetMinor === B(500) && pending.days[0].status === "UNCLOSED");
  const fileOnly = computeRevenueView(inputs({ closes: [close({ total: 7000, vat: 1068, salesScope: null })] }), { today: TODAY });
  check("a business with Z reports only (no POS stream) is counted from the Z, CLOSED, no variance",
    ils(fileOnly).sales.netMinor === B(7000) && fileOnly.days[0].status === "CLOSED" && fileOnly.days[0].varianceMinor === null, J(fileOnly.days));
}

console.log("10. a register sale and the Dubiz invoice for it");
{
  const s1 = sale({ total: 11800, vat: 1800, day: TODAY });
  const doc = { id: 1, documentType: "TAX_INVOICE" as const, currency: "ILS" as const, totalMinor: B(11800), vatMinor: B(1800), referenceDocumentId: null, sourcePaymentTransactionId: null };
  const l = link({ linkKind: "SALE_SAME_AS_DOCUMENT", saleId: s1.id, billingDocumentId: 1 });
  const base = inputs({ sales: [s1], documents: [doc], links: [l] });
  const c = decide({ linkId: l.id, decision: "CONFIRMED" });
  const confirmedSame = computeRevenueView({ ...base, decisions: [c] }, { today: TODAY });
  check("confirmed as the same sale: counted once (11800), the document excluded", ils(confirmedSame).sales.netMinor === B(11800) && confirmedSame.excluded.some((e) => e.kind === "DOCUMENT" && e.reason === "SAME_AS_SALE"));
  const revoked = computeRevenueView({ ...base, decisions: [c, decide({ linkId: l.id, decision: "REVOKED" })] }, { today: TODAY });
  check("revoked later: the latest decision wins, both count again (the owner said they are different)", ils(revoked).sales.netMinor === B(23600));
  const credit = { id: 2, documentType: "CREDIT_NOTE" as const, currency: "ILS" as const, totalMinor: B(1000), vatMinor: B(153), referenceDocumentId: 1, sourcePaymentTransactionId: null };
  const warn = computeRevenueView({ ...base, documents: [doc, credit], decisions: [c] }, { today: TODAY });
  check("a credit note on a document that IS a register sale is flagged for review", warn.warnings.some((w) => w.code === "CREDIT_NOTE_ON_LINKED_DOCUMENT"));
}

console.log("11. deposits: matched, cash, over-allocation");
{
  const z = close({ total: 10000, vat: 1525, businessDay: TODAY, tenders: [{ id: 701, method: "CASH", amountMinor: B(4000) }, { id: 702, method: "CARD", amountMinor: B(6000) }] });
  const st = { id: 801, validation: "PASSED" as const, currency: "ILS" as const, grossMinor: B(6000), feeMinor: B(60), otherDeductionsMinor: B(0), netMinor: B(5940) };
  const bank = [{ id: 901, currency: "ILS" as const, amountMinor: B(5940) }, { id: 902, currency: "ILS" as const, amountMinor: B(4000) }, { id: 903, currency: "ILS" as const, amountMinor: B(250) }];
  const ls = [
    link({ linkKind: "TENDER_SETTLED_BY", dailyCloseTenderId: 702, settlementId: 801, amountMinor: B(6000) }),
    link({ linkKind: "SETTLEMENT_DEPOSITED_AS", settlementId: 801, externalTransactionId: 901, amountMinor: B(5940) }),
    link({ linkKind: "CASH_DEPOSITED_AS", dailyCloseTenderId: 701, externalTransactionId: 902, amountMinor: B(4000) }),
  ];
  const v = computeRevenueView(inputs({ closes: [z], settlements: [st], deposits: bank, links: ls, decisions: ls.map((l) => decide({ linkId: l.id, decision: "CONFIRMED" })) }), { today: TODAY });
  const x = ils(v);
  check("sales = the Z once (10000) after settlement and both deposits", x.sales.netMinor === B(10000));
  check("everything closed: card, settlement and cash awaiting = 0", x.inTransit.cardAwaitingSettlementMinor === B(0) && x.inTransit.settlementAwaitingDepositMinor === B(0) && x.inTransit.cashAwaitingDepositMinor === B(0), J(x.inTransit));
  check("bank: 10190 in, 9940 matched, 250 unexplained", x.deposits.creditsMinor === B(10190) && x.deposits.matchedMinor === B(9940) && x.deposits.unmatchedMinor === B(250), J(x.deposits));
  check("Z tenders are money in by method (cash 4000, card 6000)", x.receipts.byChannel.CASH === B(4000) && x.receipts.byChannel.CARD === B(6000));
  const over = [link({ linkKind: "SETTLEMENT_DEPOSITED_AS", settlementId: 801, externalTransactionId: 901, amountMinor: B(5940) }), link({ linkKind: "SETTLEMENT_DEPOSITED_AS", settlementId: 801, externalTransactionId: 902, amountMinor: B(4000) })];
  const vo = computeRevenueView(inputs({ settlements: [st], deposits: bank, links: over, decisions: over.map((l) => decide({ linkId: l.id, decision: "CONFIRMED" })) }), { today: TODAY });
  check("links closing more than a settlement holds are clamped and flagged OVER_ALLOCATED",
    ils(vo).inTransit.settlementAwaitingDepositMinor === B(0) && vo.warnings.some((w) => w.code === "OVER_ALLOCATED" && w.ref === "settlement:801"), J(vo.warnings));
  const failedSt = computeRevenueView(inputs({ settlements: [{ ...st, id: 802, validation: "FAILED" }] }), { today: TODAY });
  check("a settlement that failed validation is excluded (it adds nothing, not even a currency)",
    failedSt.byCurrency.size === 0 && failedSt.excluded.some((e) => e.id === 802 && e.reason === "VALIDATION_FAILED"));
}

console.log("12. till receipts on a closed day are the Z's, not added twice");
{
  const s1 = sale({ total: 10000, vat: 1525 });
  const rCash = { id: 601, sourceScope: "pos.a", registerKey: "r1", businessDay: "2026-10-20", direction: "IN" as const, method: "CASH" as const, currency: "ILS" as const, amountMinor: B(10000) };
  const z = close({ total: 10000, vat: 1525, tenders: [{ id: 703, method: "CASH", amountMinor: B(10000) }] });
  const v = computeRevenueView(inputs({ sales: [s1], receipts: [rCash], closes: [z] }), { today: TODAY });
  check("money in = 10000 (the Z tender), not 20000", ils(v).receipts.inMinor === B(10000), J(ils(v).receipts));
  check("the till receipt is excluded as COVERED_BY_CLOSE", v.excluded.some((e) => e.kind === "RECEIPT" && e.id === 601 && e.reason === "COVERED_BY_CLOSE"));
  check("cash awaiting deposit = 10000 once", ils(v).inTransit.cashAwaitingDepositMinor === B(10000));
}

console.log("13. evidence recorded in error: rejected, kept, counted nowhere");
{
  const good = sale({ total: 11800, vat: 1800, day: TODAY });
  const wrong = sale({ total: 99900, vat: 15239, day: TODAY });
  const base = inputs({ sales: [good, wrong] });
  const before = computeRevenueView(base, { today: TODAY });
  const rej = decide({ saleId: wrong.id, decision: "REJECTED" });
  const after = computeRevenueView({ ...base, decisions: [rej] }, { today: TODAY });
  check("a rejected sale leaves the totals (111700 → 11800) and its VAT with it", ils(before).sales.netMinor === B(111700) && ils(after).sales.netMinor === B(11800) && ils(after).sales.vatMinor === B(1800), J(ils(after).sales));
  check("…and is listed as excluded REJECTED (kept, not lost)", after.excluded.some((e) => e.kind === "SALE" && e.id === wrong.id && e.reason === "REJECTED"));
  check("…and leaves the register day too (POS net of the day = 11800)", after.days[0].posNetMinor === B(11800), J(after.days));
  const restored = computeRevenueView({ ...base, decisions: [rej, decide({ saleId: wrong.id, decision: "REVOKED" })] }, { today: TODAY });
  check("the rejection REVOKED: the sale counts again (latest decision wins)", ils(restored).sales.netMinor === B(111700));
  const twice = computeRevenueView({ ...base, decisions: [rej, rej] }, { today: TODAY });
  check("the same rejection loaded twice is one rejection", ils(twice).sales.netMinor === B(11800) && twice.excluded.filter((e) => e.reason === "REJECTED").length === 1);

  // A settlement recorded in error: it stops counting, and nothing it was matched to stays closed by it.
  const r1 = { id: id(), sourceScope: "pos.a", registerKey: "r1", businessDay: TODAY, direction: "IN" as const, method: "CARD" as const, currency: "ILS" as const, amountMinor: B(11800) };
  const st = { id: id(), validation: "PASSED" as const, currency: "ILS" as const, grossMinor: B(11800), feeMinor: B(118), otherDeductionsMinor: B(0), netMinor: B(11682) };
  const bank = { id: id(), currency: "ILS" as const, amountMinor: B(11682) };
  const lt = link({ linkKind: "TENDER_SETTLED_BY", receiptId: r1.id, settlementId: st.id, amountMinor: B(11800) });
  const ld = link({ linkKind: "SETTLEMENT_DEPOSITED_AS", settlementId: st.id, externalTransactionId: bank.id, amountMinor: B(11682) });
  const linked = inputs({ sales: [good], receipts: [r1], settlements: [st], deposits: [bank], links: [lt, ld], decisions: [decide({ linkId: lt.id, decision: "CONFIRMED" }), decide({ linkId: ld.id, decision: "CONFIRMED" })] });
  const okView = computeRevenueView(linked, { today: TODAY });
  check("(control) settled and deposited: nothing in transit, bank fully matched", ils(okView).inTransit.cardAwaitingSettlementMinor === B(0) && ils(okView).deposits.unmatchedMinor === B(0));
  const stRejected = computeRevenueView({ ...linked, decisions: [...linked.decisions, decide({ settlementId: st.id, decision: "REJECTED" })] }, { today: TODAY });
  check("a rejected settlement adds no gross / fee / net", ils(stRejected).settlements.grossMinor === B(0) && ils(stRejected).settlements.feesMinor === B(0));
  check("…the links on it close nothing: the card is awaiting settlement again (11800) and the bank credit is unmatched again (11682)",
    ils(stRejected).inTransit.cardAwaitingSettlementMinor === B(11800) && ils(stRejected).deposits.unmatchedMinor === B(11682), J({ t: ils(stRejected).inTransit, d: ils(stRejected).deposits }));
  check("…each such link is reported LINK_ON_REJECTED_EVIDENCE (the writer refuses to create this state; this is the read side)",
    stRejected.warnings.filter((w) => w.code === "LINK_ON_REJECTED_EVIDENCE").length === 2, J(stRejected.warnings));
  check("…and sales are untouched by it (11800)", ils(stRejected).sales.netMinor === B(11800));

  const rcRejected = computeRevenueView({ ...linked, decisions: [...linked.decisions, decide({ receiptId: r1.id, decision: "REJECTED" })] }, { today: TODAY });
  check("a rejected receipt is not money in, and no longer awaits settlement", ils(rcRejected).receipts.inMinor === B(0) && ils(rcRejected).inTransit.cardAwaitingSettlementMinor === B(0));

  const refund = { ...sale({ kind: "REFUND", total: 1000, vat: 153, day: TODAY }), originalSaleId: wrong.id };
  const payment = { id: id(), sourceScope: "pos.a", registerKey: "r1", businessDay: TODAY, direction: "IN" as const, method: "CASH" as const, currency: "ILS" as const, amountMinor: B(99900), saleId: wrong.id };
  const orphan = computeRevenueView(inputs({ sales: [good, wrong, refund], receipts: [payment], decisions: [rej] }), { today: TODAY });
  check("a live refund or receipt naming a rejected sale is reported (UNDOES_REJECTED_SALE / PAYS_REJECTED_SALE), never silently dropped",
    orphan.warnings.some((w) => w.code === "UNDOES_REJECTED_SALE") && orphan.warnings.some((w) => w.code === "PAYS_REJECTED_SALE"), J(orphan.warnings));
  const sameAs = link({ linkKind: "SALE_SAME_AS_DOCUMENT", saleId: wrong.id, billingDocumentId: 1 });
  const doc = { id: 1, documentType: "TAX_INVOICE" as const, currency: "ILS" as const, totalMinor: B(99900), vatMinor: B(15239), referenceDocumentId: null, sourcePaymentTransactionId: null };
  const docBack = computeRevenueView(inputs({ sales: [wrong], documents: [doc], links: [sameAs], decisions: [decide({ linkId: sameAs.id, decision: "CONFIRMED" }), decide({ saleId: wrong.id, decision: "REJECTED" })] }), { today: TODAY });
  check("a register sale 'same as' a Dubiz invoice, then rejected: the invoice is the sale again (counted once, 99900)", ils(docBack).sales.netMinor === B(99900), J(ils(docBack).sales));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
console.log("S. Sources are not interchangeable: only POS is register evidence");
{
  const pos = { ...sale({ total: 11800, vat: 1800 }), sourceKind: "POS" as const };
  const posReceipt = { id: id(), sourceKind: "POS" as const, sourceScope: "pos.a", registerKey: "r1", businessDay: "2026-10-20", direction: "IN" as const, method: "CARD" as const, currency: "ILS" as const, amountMinor: B(11800), saleId: pos.id };
  const base = computeRevenueView(inputs({ sales: [pos], receipts: [posReceipt] }), { today: TODAY });
  const unlabelled = computeRevenueView(inputs({ sales: [{ ...pos, sourceKind: undefined }], receipts: [{ ...posReceipt, sourceKind: undefined }] }), { today: TODAY });
  check("POS evidence reads exactly as before (net 11800, one UNCLOSED register day, card 11800 awaiting settlement)",
    ils(base).sales.netMinor === B(11800) && ils(base).sales.unclosedNetMinor === B(11800) && base.days.length === 1 && base.days[0].status === "UNCLOSED"
      && ils(base).inTransit.cardAwaitingSettlementMinor === B(11800) && Object.keys(ils(base).otherSources).length === 0, J(ils(base)));
  check("an in-memory input without a source kind is read as POS (the milestone-A shape) — identical view", J(unlabelled) === J(base));

  // A Rivhit document (ACCOUNTING_APP) with its cash tender, a refund, and a void of another document.
  const acc = { ...sale({ total: 23600, vat: 3600, scope: "pos.rivhit:c7", register: null }), sourceKind: "ACCOUNTING_APP" as const, capture: "API_PULL" as const };
  const accRefund = { ...sale({ kind: "REFUND", total: 5900, vat: 900, scope: "pos.rivhit:c7", register: null }), sourceKind: "ACCOUNTING_APP" as const };
  const accVoided = { ...sale({ total: 1000, vat: 153, scope: "pos.rivhit:c7", register: null }), sourceKind: "ACCOUNTING_APP" as const };
  const accVoid = { ...sale({ kind: "VOID", total: 1000, vat: 153, scope: "pos.rivhit:c7", register: null }), sourceKind: "ACCOUNTING_APP" as const, originalSaleId: accVoided.id };
  const accCash = { id: id(), sourceKind: "ACCOUNTING_APP" as const, sourceScope: "pos.rivhit:c7", registerKey: null, businessDay: "2026-10-20", direction: "IN" as const, method: "CASH" as const, currency: "ILS" as const, amountMinor: B(23600), saleId: acc.id };
  const mixed = computeRevenueView(inputs({ sales: [pos, acc, accRefund, accVoided, accVoid], receipts: [posReceipt, accCash] }), { today: TODAY });
  const m = ils(mixed);
  check("accounting-app documents never enter register sales: net stays the POS 11800", m.sales.netMinor === B(11800) && m.sales.grossMinor === B(11800) && m.sales.unclosedNetMinor === B(11800) && m.sales.provisionalNetMinor === B(0), J(m.sales));
  check("…and never form a register day (still one day, the POS one)", mixed.days.length === 1 && mixed.days[0].stream === "pos.a", J(mixed.days));
  check("…they are shown apart: 2 sales (gross 24600), refunds 5900, voids 1000 → net 17700", (() => {
    const a = m.otherSources.ACCOUNTING_APP!;
    return a.saleCount === 2 && a.grossMinor === B(24600) && a.refundsMinor === B(5900) && a.voidsMinor === B(1000) && a.netMinor === B(17700);
  })(), J(m.otherSources));
  check("their cash is not till money: receipts stay the POS 11800; it is shown apart (CASH 23600)", m.receipts.inMinor === B(11800) && m.otherSources.ACCOUNTING_APP!.receiptsByMethod.CASH === B(23600) && !m.receipts.byChannel.CASH);
  check("…and never awaits a bank deposit as till cash", m.inTransit.cashAwaitingDepositMinor === B(0));
  check("every accounting-app row is listed NOT_REGISTER_EVIDENCE", [acc, accRefund, accVoided, accVoid].every((s) => mixed.excluded.some((e) => e.kind === "SALE" && e.id === s.id && e.reason === "NOT_REGISTER_EVIDENCE"))
    && mixed.excluded.some((e) => e.kind === "RECEIPT" && e.id === accCash.id && e.reason === "NOT_REGISTER_EVIDENCE"));
  const z = close({ total: 11800, vat: 1800 });
  const withZ = computeRevenueView(inputs({ sales: [pos, acc], closes: [z] }), { today: TODAY });
  check("a Z closes the POS day only: no variance from the accounting document, which is not COVERED_BY_CLOSE",
    withZ.days.length === 1 && withZ.days[0].status === "CLOSED" && withZ.days[0].varianceMinor === B(0)
      && !withZ.excluded.some((e) => e.id === acc.id && e.reason === "COVERED_BY_CLOSE") && ils(withZ).sales.netMinor === B(11800), J(withZ.days));

  // A payment provider's charge is never a sale; its receipts are shown apart.
  const ppSale = { ...sale({ total: 11800, vat: 1800, scope: "psp.payplus:c9", register: null }), sourceKind: "PAYMENT_PROVIDER" as const };
  const ppReceipt = { id: id(), sourceKind: "PAYMENT_PROVIDER" as const, sourceScope: "psp.payplus:c9", registerKey: null, businessDay: "2026-10-20", direction: "IN" as const, method: "CARD" as const, currency: "ILS" as const, amountMinor: B(11800), saleId: null };
  const withPsp = computeRevenueView(inputs({ sales: [pos, ppSale], receipts: [posReceipt, ppReceipt] }), { today: TODAY });
  check("a payment-provider 'sale' counts nowhere (NOT_A_SALE_SOURCE): net stays 11800, no other-source sale", ils(withPsp).sales.netMinor === B(11800)
    && withPsp.excluded.some((e) => e.id === ppSale.id && e.reason === "NOT_A_SALE_SOURCE") && (ils(withPsp).otherSources.PAYMENT_PROVIDER?.saleCount ?? 0) === 0);
  check("its card charge does not double the till's money in (11800) and is shown apart", ils(withPsp).receipts.inMinor === B(11800) && ils(withPsp).otherSources.PAYMENT_PROVIDER!.receiptsInMinor === B(11800)
    && ils(withPsp).inTransit.cardAwaitingSettlementMinor === B(11800));

  // The same deal in Rivhit and in Dubiz.
  const dubiz = { id: 501, documentType: "TAX_INVOICE_RECEIPT" as const, currency: "ILS" as const, totalMinor: B(23600), vatMinor: B(3600), referenceDocumentId: null, sourcePaymentTransactionId: null };
  const unlinked = computeRevenueView(inputs({ sales: [acc], documents: [dubiz] }), { today: TODAY });
  check("no link: nothing merged or guessed — the Dubiz document counts (23600), the Rivhit one stays apart, and the view warns POSSIBLE_DUPLICATE_ACROSS_SOURCES",
    ils(unlinked).sales.netMinor === B(23600) && ils(unlinked).otherSources.ACCOUNTING_APP!.netMinor === B(23600)
      && unlinked.warnings.some((w) => w.code === "POSSIBLE_DUPLICATE_ACROSS_SOURCES"), J({ s: ils(unlinked).sales.netMinor, w: unlinked.warnings }));
  const same = link({ linkKind: "SALE_SAME_AS_DOCUMENT", saleId: acc.id, billingDocumentId: 501 });
  const proposed = computeRevenueView(inputs({ sales: [acc], documents: [dubiz], links: [same] }), { today: TODAY });
  check("a PROPOSED (unconfirmed) link changes nothing: still apart, still warned", ils(proposed).otherSources.ACCOUNTING_APP!.netMinor === B(23600) && proposed.warnings.some((w) => w.code === "POSSIBLE_DUPLICATE_ACROSS_SOURCES"));
  const linked = computeRevenueView(inputs({ sales: [acc], documents: [dubiz], links: [same], decisions: [decide({ linkId: same.id, decision: "CONFIRMED" })] }), { today: TODAY });
  check("a CONFIRMED link: one deal — the Dubiz document stays counted once (23600), the Rivhit sale is SAME_AS_DUBIZ_DOCUMENT and leaves the unmatched figures",
    ils(linked).sales.netMinor === B(23600) && !linked.excluded.some((e) => e.kind === "DOCUMENT" && e.id === 501)
      && linked.excluded.some((e) => e.id === acc.id && e.reason === "SAME_AS_DUBIZ_DOCUMENT")
      && ils(linked).otherSources.ACCOUNTING_APP!.netMinor === B(0) && ils(linked).otherSources.ACCOUNTING_APP!.matchedToDubizDocumentMinor === B(23600)
      && !linked.warnings.some((w) => w.code === "POSSIBLE_DUPLICATE_ACROSS_SOURCES"), J({ s: ils(linked).sales, o: ils(linked).otherSources, x: linked.excluded }));
  const posSame = link({ linkKind: "SALE_SAME_AS_DOCUMENT", saleId: pos.id, billingDocumentId: 502 });
  const posDoc = { ...dubiz, id: 502, totalMinor: B(11800), vatMinor: B(1800) };
  const posLinked = computeRevenueView(inputs({ sales: [pos], documents: [posDoc], links: [posSame], decisions: [decide({ linkId: posSame.id, decision: "CONFIRMED" })] }), { today: TODAY });
  check("(unchanged) a Dubiz document confirmed as the same as a POS sale is still excluded SAME_AS_SALE — counted once (11800)",
    ils(posLinked).sales.netMinor === B(11800) && posLinked.excluded.some((e) => e.kind === "DOCUMENT" && e.id === 502 && e.reason === "SAME_AS_SALE"));
  const rejectedAcc = computeRevenueView(inputs({ sales: [acc], decisions: [decide({ saleId: acc.id, decision: "REJECTED" })] }), { today: TODAY });
  check("a rejected accounting-app sale counts nowhere, not even apart", !rejectedAcc.byCurrency.has("ILS") || (ils(rejectedAcc).otherSources.ACCOUNTING_APP?.saleCount ?? 0) === 0);
}

console.log(`\n${total - failures}/${total} passed`);
if (failures > 0) process.exit(1);
