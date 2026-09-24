/**
 * M4 — every rule in the catalogue, and the kit they share. Run:
 *   npx tsx lib/knowledge/rules/m4-rules.test.ts
 *
 * WHAT IS ACTUALLY BEING TESTED
 *
 * Not "does it compute a median". The arithmetic is three lines and would be fine untested. What
 * needs proving is the RESTRAINT — the properties that decide whether an owner can ever trust a
 * number this system produces:
 *
 *   it refuses below its own support, and says so in a way a consumer can render;
 *   a refusal never carries a value, because a number under "I don't know" gets read anyway;
 *   the same evidence always produces the same fingerprint, whatever order it arrives in;
 *   a trend needs support in BOTH halves, so "worsening" can never come from two observations;
 *   nothing crosses a tenant, and nothing crosses an entity;
 *   every rule is pure — no clock, no database, no environment.
 *
 * Every assertion below is written against the WRITER'S validation too, because a rule that produces
 * something `validateMeasure` would reject is a rule that fails in production rather than here.
 */
import {
  derivePaymentTiming,
  deriveLateShare,
  derivePayeeTiming,
  deriveEvidenceBacking,
  AP01,
  AP03,
  AP04,
  AP06,
  type SettlementObservation,
} from "./payables";
import {
  deriveRestockInterval,
  deriveCountCorrectionShare,
  deriveStockPressure,
  INV02,
  INV04,
  INV05,
  type MovementObservation,
  type AlertObservation,
} from "./inventory";
import {
  derivePurchaseCadence,
  deriveDeliveryLag,
  deriveShortDeliveryShare,
  SUPP01,
  SUPP02,
  SUPP03,
  type SupplierOrderObservation,
  type SupplierDeliveryObservation,
} from "./suppliers";
import {
  deriveVendorBillingCadence,
  deriveVendorAmountStability,
  deriveCorrectionRate,
  DOC02,
  DOC05,
  DOC06,
  type VendorDocumentObservation,
  type ReviewObservation,
} from "./documents";
import { validateMeasure } from "../measure-writer";
import { cadenceMeasure, calendarDays, groupByEntity } from "../rule-kit";
import type { MeasureResult } from "../measure.contract";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra ?? "");
  }
}

const NOW = new Date("2026-09-24T12:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const BIZ = 3;

/** Every measure a rule produces must survive the writer's own validation. */
function writable(results: readonly MeasureResult[]): boolean {
  try {
    for (const r of results) validateMeasure(BIZ, r);
    return true;
  } catch {
    return false;
  }
}

const detailOf = (r: MeasureResult) => (r.detail ?? {}) as Record<string, unknown>;

/* ══════════════════════════════ THE SHARED KIT ══════════════════════════════ */
{
  // Cadence counts GAPS, not events — the distinction that stops a rule claiming a rhythm it has
  // seen once. Four events are three gaps, so a rule wanting three gaps needs four events.
  const pts = [1, 2, 3, 4].map((i) => ({ recordId: i, businessId: BIZ, at: ago(40 - i * 10) }));
  const r = cadenceMeasure(
    { measureKey: "t.cadence", entityType: null, entityId: null, valueUnit: "days",
      evidenceKind: "t", minSupport: 3, windowDays: 180 },
    pts, NOW, BIZ);
  ok("cadence: four events make three gaps", r.status === "ACTIVE" && detailOf(r).gapCount === 3);
  ok("cadence: the value is the typical gap", r.valueNumeric === 10, r.valueNumeric);
  ok("cadence: evidence is the EVENTS, not the gaps", r.evidenceSet.refs.length === 4);
  ok("cadence: observationCount matches the evidence set, as the writer demands",
    r.observationCount === r.evidenceSet.refs.length);

  const short = cadenceMeasure(
    { measureKey: "t.cadence", entityType: null, entityId: null, valueUnit: "days",
      evidenceKind: "t", minSupport: 3, windowDays: 180 },
    pts.slice(0, 3), NOW, BIZ);
  ok("cadence: three events are only two gaps, so it refuses",
    short.status === "INSUFFICIENT_EVIDENCE" && detailOf(short).have === 2);
  ok("cadence: the refusal names its unit of support", detailOf(short).supportUnit === "gaps");

  // Ordering must never leak into the result: the fingerprint is the point.
  const shuffled = [pts[2], pts[0], pts[3], pts[1]];
  const rs = cadenceMeasure(
    { measureKey: "t.cadence", entityType: null, entityId: null, valueUnit: "days",
      evidenceKind: "t", minSupport: 3, windowDays: 180 },
    shuffled, NOW, BIZ);
  ok("the fingerprint does not depend on the order rows arrived in",
    rs.evidenceSet.fingerprint === r.evidenceSet.fingerprint);
  ok("neither does the value", rs.valueNumeric === r.valueNumeric);

  // Anything outside the window is not evidence, and must not be linked as if it were.
  const stale = cadenceMeasure(
    { measureKey: "t.cadence", entityType: null, entityId: null, valueUnit: "days",
      evidenceKind: "t", minSupport: 3, windowDays: 20 },
    pts, NOW, BIZ);
  ok("a narrower window drops the older evidence entirely",
    stale.evidenceSet.refs.length < 4 && stale.status === "INSUFFICIENT_EVIDENCE");

  ok("grouping by entity is deterministic and ascending",
    [...groupByEntity([{ e: 9 }, { e: 2 }, { e: 5 }], (x) => x.e).keys()].join(",") === "2,5,9");

  // Calendar days, not elapsed milliseconds — the thing that is wrong twice a year.
  ok("day distance is calendar-based",
    calendarDays(new Date("2026-03-26T23:00:00Z"), new Date("2026-03-29T23:00:00Z")) === 3);
}

/* ══════════════════════════════ PAYABLES ══════════════════════════════ */

const settle = (
  id: number, paidAgo: number, lateDays: number,
  payeeId: number | null = 7, backed = false,
): SettlementObservation => ({
  recordId: id,
  businessId: BIZ,
  at: ago(paidAgo),
  expectedAt: new Date(ago(paidAgo).getTime() - lateDays * DAY),
  payeeId,
  externallyBacked: backed,
});

{
  const late = [1, 2, 3, 4, 5].map((i) => settle(i, 100 - i, 4));
  const r = derivePaymentTiming(late, NOW, BIZ)[0];
  ok("AP-01 derives a typical lateness", r.status === "ACTIVE" && r.valueNumeric === 4);
  ok("AP-01 is business-level", r.entityType === null && r.entityId === null);
  ok("AP-01 is writable", writable([r]));

  // SIGNED, and that is the point: a punctual payer must not be flattened into an average one.
  const early = [1, 2, 3, 4, 5].map((i) => settle(i, 100 - i, -3));
  const e = derivePaymentTiming(early, NOW, BIZ)[0];
  ok("AP-01 reports EARLY payment as a negative number, not a magnitude", e.valueNumeric === -3);
  ok("AP-01 counts the early ones as on time or better", detailOf(e).onTimeOrEarly === 5);

  const thin = derivePaymentTiming(late.slice(0, 4), NOW, BIZ)[0];
  ok("AP-01 refuses below support", thin.status === "INSUFFICIENT_EVIDENCE");
  ok("AP-01's refusal carries no number", thin.valueNumeric === null);
  ok("AP-01's refusal is still writable", writable([thin]));

  // AP-03: on the due day is NOT late.
  const onTime = [1, 2, 3, 4, 5].map((i) => settle(i, 100 - i, 0));
  const s = deriveLateShare([...onTime, settle(6, 94, 2)], NOW, BIZ)[0];
  ok("AP-03 counts only payments strictly after the due day",
    s.status === "ACTIVE" && detailOf(s).hits === 1 && detailOf(s).population === 6);
  ok("AP-03 produces a ratio", s.valueUnit === "ratio" && s.valueNumeric === 0.17, s.valueNumeric);
  ok("AP-03 offers no trend — a ratio's halves cannot support one at this volume", s.trend === null);

  // AP-04: per payee, and never pooled by name.
  const mixed = [
    ...[1, 2, 3, 4].map((i) => settle(i, 100 - i, 10, 7)),
    ...[5, 6, 7, 8].map((i) => settle(i, 100 - i, 0, 8)),
    settle(9, 90, 30, null),
  ];
  const perPayee = derivePayeeTiming(mixed, NOW, BIZ);
  ok("AP-04 produces one measure per payee", perPayee.length === 2);
  ok("AP-04 keeps the payees apart",
    perPayee[0].valueNumeric === 10 && perPayee[1].valueNumeric === 0);
  ok("AP-04 emits them in a deterministic order",
    perPayee[0].entityId === 7 && perPayee[1].entityId === 8);
  ok("AP-04 DROPS a payment with no payee rather than pooling it by name",
    perPayee.every((m) => m.evidenceSet.refs.every((f) => f.recordId !== 9)));
  ok("AP-04 is writable", writable(perPayee));

  // No evidence ref may ever belong to another tenant — the writer would reject it, and should.
  const crossTenant = [...late, { ...settle(99, 50, 1), businessId: 999 }];
  const x = derivePaymentTiming(crossTenant, NOW, BIZ)[0];
  ok("a foreign evidence ref is REFUSED by the writer, not silently written", !writable([x]));

  // AP-06
  const backed = [
    ...[1, 2, 3].map((i) => settle(i, 100 - i, 0, 7, true)),
    ...[4, 5].map((i) => settle(i, 100 - i, 0, 7, false)),
  ];
  const b = deriveEvidenceBacking(backed, NOW, BIZ)[0];
  ok("AP-06 measures how much of the record rests on more than memory",
    b.status === "ACTIVE" && b.valueNumeric === 0.6);
}

/* ══════════════════════════════ INVENTORY ══════════════════════════════ */

const move = (
  id: number, agoDays: number, itemId: number, reason: string, type = "IN",
): MovementObservation => ({
  recordId: id, businessId: BIZ, at: ago(agoDays), itemId, movementType: type, reason,
});

{
  const restocks = [40, 30, 20, 10].map((d, i) => move(i + 1, d, 5, "SUPPLIER_PURCHASE"));
  const noise = [move(10, 35, 5, "SALE", "OUT"), move(11, 50, 5, "INITIAL_STOCK")];
  const r = deriveRestockInterval([...restocks, ...noise], NOW, BIZ);
  ok("INV-02 produces one measure per item", r.length === 1 && r[0].entityId === 5);
  ok("INV-02 finds the replenishment rhythm", r[0].status === "ACTIVE" && r[0].valueNumeric === 10);
  ok("INV-02 ignores sales and the item's first ever stocking",
    r[0].evidenceSet.refs.length === 4);
  ok("INV-02 carries the recorded-time caveat WITH the number",
    detailOf(r[0]).recordedTimeOnly === true);
  ok("INV-02 is writable", writable(r));

  const twoItems = [
    ...[40, 30, 20, 10].map((d, i) => move(i + 1, d, 5, "MANUAL_ADD")),
    ...[40, 20].map((d, i) => move(i + 20, d, 6, "MANUAL_ADD")),
  ];
  const t = deriveRestockInterval(twoItems, NOW, BIZ);
  ok("INV-02 refuses for the item with too few restocks, and still says so",
    t.length === 2 && t[1].status === "INSUFFICIENT_EVIDENCE" && detailOf(t[1]).have === 1);
  ok("INV-02 never mixes two items' evidence",
    t[0].evidenceSet.refs.every((f) => f.recordId < 10) &&
    t[1].evidenceSet.refs.every((f) => f.recordId >= 20));

  const corrections = [
    ...Array.from({ length: 8 }, (_, i) => move(i + 1, 50 - i, 5, "SALE", "OUT")),
    move(9, 20, 5, "INVENTORY_COUNT_CORRECTION", "ADJUSTMENT"),
    move(10, 15, 5, "INVENTORY_COUNT_CORRECTION", "ADJUSTMENT"),
  ];
  const c = deriveCountCorrectionShare(corrections, NOW, BIZ)[0];
  ok("INV-04 measures how often the book had to be corrected",
    c.status === "ACTIVE" && c.valueNumeric === 0.2);
  ok("INV-04 refuses under ten movements",
    deriveCountCorrectionShare(corrections.slice(0, 9), NOW, BIZ)[0].status === "INSUFFICIENT_EVIDENCE");

  const alerts: AlertObservation[] = [
    { recordId: 1, businessId: BIZ, at: ago(50), itemId: 5, alertType: "LOW_STOCK" },
    { recordId: 2, businessId: BIZ, at: ago(20), itemId: 5, alertType: "CRITICAL_STOCK" },
    { recordId: 3, businessId: BIZ, at: ago(10), itemId: 6, alertType: "LOW_STOCK" },
    { recordId: 4, businessId: BIZ, at: ago(5), itemId: 6, alertType: "UNMATCHED_POS_PRODUCT" },
  ];
  const p = deriveStockPressure(alerts, NOW, BIZ);
  ok("INV-05 counts recurring pressure per item",
    p.length === 2 && p[0].entityId === 5 && p[0].valueNumeric === 2);
  ok("INV-05 separates critical from merely low", detailOf(p[0]).criticalCount === 1);
  ok("INV-05 ignores alerts that are not about stock levels",
    p[1].status === "INSUFFICIENT_EVIDENCE" && p[1].evidenceSet.refs.length === 1);
  ok("INV-05 is writable", writable(p));
}

/* ══════════════════════════════ SUPPLIERS ══════════════════════════════ */
{
  const orders: SupplierOrderObservation[] = [70, 56, 42, 28].map((d, i) => ({
    recordId: i + 1, businessId: BIZ, at: ago(d), supplierId: 11, datedFromCreation: false,
  }));
  const c = derivePurchaseCadence(orders, NOW, BIZ);
  ok("SUPP-01 finds a supplier's purchase rhythm",
    c.length === 1 && c[0].status === "ACTIVE" && c[0].valueNumeric === 14);
  ok("SUPP-01 is keyed on the supplier RECORD, never a name", c[0].entityType === "supplier");
  ok("SUPP-01 reports how much of its sample lacked a real order date",
    detailOf(c[0]).datedFromCreation === 0);

  const guessed = derivePurchaseCadence(
    orders.map((o) => ({ ...o, datedFromCreation: true })), NOW, BIZ);
  ok("SUPP-01 counts the fallback dates rather than hiding them",
    detailOf(guessed[0]).datedFromCreation === 4);

  const deliveries: SupplierDeliveryObservation[] = [60, 40, 20].map((d, i) => ({
    recordId: i + 1, businessId: BIZ, at: ago(d),
    expectedAt: new Date(ago(d).getTime() - 5 * DAY),
    supplierId: 11, linesOrdered: 4, linesShort: i === 0 ? 1 : 0,
  }));
  const lag = deriveDeliveryLag(deliveries, NOW, BIZ);
  ok("SUPP-02 measures order-to-arrival", lag[0].status === "ACTIVE" && lag[0].valueNumeric === 5);
  ok("SUPP-02 is writable", writable(lag));

  const short = deriveShortDeliveryShare(deliveries, NOW, BIZ);
  ok("SUPP-03 counts INCOMPLETE ORDERS, not incomplete lines",
    short[0].status === "ACTIVE" && short[0].valueNumeric === 0.33, short[0].valueNumeric);
  ok("SUPP-03 still reports the line totals underneath",
    detailOf(short[0]).linesShortTotal === 1 && detailOf(short[0]).linesOrderedTotal === 12);

  const twoSuppliers = [
    ...deliveries,
    ...[50, 30, 10].map((d, i) => ({
      recordId: i + 20, businessId: BIZ, at: ago(d),
      expectedAt: new Date(ago(d).getTime() - 12 * DAY),
      supplierId: 12, linesOrdered: 2, linesShort: 0,
    })),
  ];
  const both = deriveDeliveryLag(twoSuppliers, NOW, BIZ);
  ok("SUPP-02 keeps two suppliers' lead times apart",
    both.length === 2 && both[0].valueNumeric === 5 && both[1].valueNumeric === 12);
  ok("…and never lets one supplier's evidence into the other's measure",
    both[0].evidenceSet.refs.every((f) => f.recordId < 10) &&
    both[1].evidenceSet.refs.every((f) => f.recordId >= 20));
}

/* ══════════════════════════════ DOCUMENTS ══════════════════════════════ */
{
  const docs: VendorDocumentObservation[] = [120, 90, 60, 30].map((d, i) => ({
    recordId: i + 1, businessId: BIZ, at: ago(d), partyId: 21, amount: 500, direction: "expense",
  }));
  const cad = deriveVendorBillingCadence(docs, NOW, BIZ);
  ok("DOC-02 finds a vendor's billing rhythm",
    cad.length === 1 && cad[0].status === "ACTIVE" && cad[0].valueNumeric === 30);
  ok("DOC-02 is keyed on a resolved identity, not a name", cad[0].entityType === "party");

  const withIncome = [...docs, { ...docs[0], recordId: 99, direction: "income" }];
  ok("DOC-02 does not mix money coming IN with money going OUT",
    deriveVendorBillingCadence(withIncome, NOW, BIZ)[0].evidenceSet.refs.length === 4);

  const varied = docs.map((d, i) => ({ ...d, amount: [100, 500, 520, 480][i] }));
  const amt = deriveVendorAmountStability(varied, NOW, BIZ);
  ok("DOC-05 reports the TYPICAL amount, not the mean",
    amt[0].status === "ACTIVE" && amt[0].valueNumeric === 490);
  ok("DOC-05 says how much it varies, so the headline is not read as a promise",
    detailOf(amt[0]).lowest === 100 && detailOf(amt[0]).highest === 520);
  ok("DOC-05 offers NO trend — a rising amount has no observed cause", amt[0].trend === null);
  ok("DOC-05 is writable", writable(amt));

  const reviews: ReviewObservation[] = Array.from({ length: 10 }, (_, i) => ({
    recordId: i + 1, businessId: BIZ, at: ago(50 - i),
    corrected: i < 3,
    correctedFields: i < 3 ? ["amount"] : [],
  }));
  const cr = deriveCorrectionRate(reviews, NOW, BIZ)[0];
  ok("DOC-06 measures how often the engine had to be corrected",
    cr.status === "ACTIVE" && cr.valueNumeric === 0.3);
  ok("DOC-06 names WHICH fields, and only the field names",
    (detailOf(cr).byField as Record<string, number>).amount === 3);
  ok("DOC-06 refuses under ten reviews",
    deriveCorrectionRate(reviews.slice(0, 9), NOW, BIZ)[0].status === "INSUFFICIENT_EVIDENCE");
}

/* ══════════════════════════════ TREND DISCIPLINE ══════════════════════════════ */
{
  // The single most dangerous thing a rule here could do is call something "worsening" on the
  // strength of two observations. Both halves must carry their own support, or there is no trend.
  const worsening = [
    ...[1, 2, 3].map((i) => settle(i, 300 - i, 1)),
    ...[4, 5, 6].map((i) => settle(i, 60 - i, 20)),
  ];
  const w = derivePaymentTiming(worsening, NOW, BIZ)[0];
  ok("a real deterioration IS reported", w.trend === "WORSENING", w.trend);

  const lopsided = [
    ...[1, 2, 3, 4, 5].map((i) => settle(i, 60 - i, 1)),
    settle(9, 300, 40),
  ];
  const l = derivePaymentTiming(lopsided, NOW, BIZ)[0];
  ok("one lonely old observation is NOT a trend", l.trend === null, l.trend);
  ok("…but it still counts toward the headline",
    l.status === "ACTIVE" && l.observationCount === 6);
}

/* ══════════════════════════════ PURITY ══════════════════════════════ */
{
  const fs = require("node:fs");
  const path = require("node:path");

  /**
   * Comments are stripped before any of this is checked, and that is not a loosening.
   *
   * These rules are about what the CODE does. A file that explains at length why it refuses to
   * invent a confidence score would fail a naive text search for the word "confidence" — which is
   * the guard punishing exactly the documentation that makes the property comprehensible. Strip the
   * prose, keep the statements, and the check tightens rather than relaxes.
   */
  const codeOf = (file: string): string =>
    fs
      .readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

  for (const f of ["payables.ts", "inventory.ts", "suppliers.ts", "documents.ts"]) {
    const src = codeOf(path.join(__dirname, f));
    ok(`${f} imports no Prisma and opens no transaction`,
      !/@prisma\/client|lib\/prisma|tenantTx/.test(src));
    ok(`${f} reads no clock`, !/Date\.now\(\)|new Date\(\)/.test(src));
    ok(`${f} reads no env`, !/process\.env/.test(src));
    ok(`${f} declares no confidence score`, !/confidence\s*[:=]/i.test(src));
  }
  const kit = codeOf(path.join(__dirname, "..", "rule-kit.ts"));
  ok("the shared kit reads no clock either", !/Date\.now\(\)|new Date\(\)/.test(kit));
  ok("the shared kit reaches no database", !/@prisma\/client|lib\/prisma|tenantTx/.test(kit));

  // Descriptors are the catalogue's contract with everything downstream.
  const all = [AP01, AP03, AP04, AP06, INV02, INV04, INV05, SUPP01, SUPP02, SUPP03, DOC02, DOC05, DOC06];
  ok("every rule has a distinct measure key",
    new Set(all.map((d) => d.measureKey)).size === all.length);
  ok("every rule has a distinct policy lineage",
    new Set(all.map((d) => d.policyKey)).size === all.length);
  ok("every rule states a minimum support above zero", all.every((d) => d.minSupport > 0));
  ok("every rule states what makes it stale", all.every((d) => d.freshness.length > 0));
  ok("every rule states the question it answers in one sentence",
    all.every((d) => d.question.trim().endsWith("?")));
  ok("no rule uses one universal window",
    new Set(all.map((d) => d.windowDays)).size > 1);
}

console.log(
  failed === 0
    ? "\nM4 rules: they derive, they refuse, they explain, and they stay in their lane. ✔"
    : `\n${failed} FAILED`,
);
process.exit(failed === 0 ? 0 : 1);
