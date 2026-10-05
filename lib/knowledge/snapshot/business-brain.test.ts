/* eslint-disable @typescript-eslint/no-explicit-any -- reads heterogeneous item values in assertions */
/**
 * Business Brain (bks.v2) — temporal states, memory, record links, cross-domain families, Brain context.
 * No database. Run: npx tsx lib/knowledge/snapshot/business-brain.test.ts
 *
 * Each capability is proven on what it must produce AND on what it must refuse: a new subject is not
 * "new behaviour" unless the business already had history; memory is never a premise; a foreign-key
 * link is never identity; a cash window never judges adequacy; stock quantities never enter
 * replenishment; nothing claims a cause; nothing money-shaped or id-shaped reaches the Brain.
 */
import { interpretSeries, type SeriesRow } from "../temporal/interpret";
import { assembleSnapshot } from "./assemble";
import type { DomainState, StoredKnowledge } from "./snapshot-sources";
import type { BusinessKnowledgeSnapshot } from "./snapshot.contract";
import { buildBrainContext } from "../brain/context-builder";
import { CROSS_DOMAIN_FAMILIES } from "./cross-domain";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else { failed += 1; console.error(`FAIL: ${name}`, extra ?? ""); }
}
const AS_OF = new Date("2026-10-01T00:00:00.000Z");
const DAY = 86_400_000;
const ago = (d: number) => new Date(AS_OF.getTime() - d * DAY);
const pv = (key: string) => ({ version: "v1", policy: { key } });
const dec = (n: number) => ({ toString: () => String(n) }) as unknown as import("@prisma/client").Prisma.Decimal;
const CAUSAL = /\b(because|caused|due to|led to|result(?:s|ed)? in|driven by|thanks to|improved|effect)\b/i;

/* ───────── 1. temporal interpretation ───────── */
const row = (id: number, knowledgeType: SeriesRow["knowledgeType"], status: SeriesRow["status"], finding: unknown = null, h = 20, r = 6): SeriesRow =>
  ({ id, knowledgeType, status, historyCount: h, recentCount: r, historyStart: ago(455), finding });
const B = row(1, "BASELINE", "ACTIVE");
const S = (rows: SeriesRow[], pol: "LOWER_IS_FAVORABLE" | "HIGHER_IS_FAVORABLE" | null = null, est = true) => interpretSeries(rows, pol, 4, est)?.state;
ok("NORMAL: a baseline and nothing else", S([B]) === "NORMAL");
ok("STABLE_PATTERN", S([B, row(2, "STABLE_PATTERN", "ACTIVE")]) === "STABLE_PATTERN");
ok("ONE_OFF_ANOMALY over stable", S([B, row(2, "STABLE_PATTERN", "ACTIVE"), row(3, "ANOMALY", "ACTIVE")]) === "ONE_OFF_ANOMALY");
ok("a level shift beats an anomaly (several unusual points = a shift)", S([B, row(3, "ANOMALY", "ACTIVE"), row(4, "MATERIAL_CHANGE", "ACTIVE", { direction: "UP" })]) === "SHIFTED");
ok("polarity LOWER: shift UP = DETERIORATING", S([B, row(4, "MATERIAL_CHANGE", "ACTIVE", { direction: "UP" })], "LOWER_IS_FAVORABLE") === "DETERIORATING");
ok("polarity LOWER: shift DOWN = IMPROVING", S([B, row(4, "MATERIAL_CHANGE", "ACTIVE", { direction: "DOWN" })], "LOWER_IS_FAVORABLE") === "IMPROVING");
ok("polarity HIGHER: trend UP = IMPROVING", S([B, row(5, "TREND", "ACTIVE", { direction: "UP" })], "HIGHER_IS_FAVORABLE") === "IMPROVING");
ok("no polarity: trend = TRENDING (no value judgement)", S([B, row(5, "TREND", "ACTIVE", { direction: "DOWN" })]) === "TRENDING");
ok("a FLAT / NONE trend is not a trend", S([B, row(5, "TREND", "ACTIVE", { direction: "FLAT" })]) === "NORMAL" && S([B, row(5, "TREND", "ACTIVE", { direction: "NONE" })]) === "NORMAL");
ok("a TREND row INSUFFICIENT_HISTORY is ignored", S([B, row(5, "TREND", "INSUFFICIENT_HISTORY", { direction: "UP" })]) === "NORMAL");
ok("GONE_QUIET: stale baseline", S([row(1, "BASELINE", "STALE")]) === "GONE_QUIET");
ok("INSUFFICIENT_HISTORY: thin history", S([row(1, "BASELINE", "INSUFFICIENT_HISTORY", null, 2, 1)]) === "INSUFFICIENT_HISTORY");
ok("NEW_BEHAVIOR: no history, enough recent, key established elsewhere", S([row(1, "BASELINE", "INSUFFICIENT_HISTORY", null, 0, 5)], null, true) === "NEW_BEHAVIOR");
ok("…but NOT when the business has no established history for the key (Dubiz may just have started recording)",
  S([row(1, "BASELINE", "INSUFFICIENT_HISTORY", null, 0, 5)], null, false) === "INSUFFICIENT_HISTORY");
ok("…and not with too few recent observations", S([row(1, "BASELINE", "INSUFFICIENT_HISTORY", null, 0, 3)], null, true) === "INSUFFICIENT_HISTORY");
ok("provenance: the state names the rows it was read from",
  JSON.stringify(interpretSeries([B, row(4, "MATERIAL_CHANGE", "ACTIVE", { direction: "UP" })], null, 4, true)?.basedOn) === "[1,4]");

/* ───────── fixture: one business with depth ───────── */
const measure = (id: number, key: string, policy: string, entityType: string | null = null, entityId: number | null = null, unit = "days") => ({
  id, measureKey: key, entityType, entityId, status: "ACTIVE", valueNumeric: dec(unit === "currency" ? 777.77 : 4), valueUnit: unit, detail: null,
  observationCount: 8, windowStart: ago(365), windowEnd: ago(1), trend: null, evidenceFingerprint: `fp${id}`, policyVersion: pv(policy),
});
const temporal = (id: number, key: string, domain: string, kt: string, status: string, finding: unknown, entityType: string | null = null, entityId: number | null = null, h = 20, r = 6) => ({
  id, temporalKey: key, domain, knowledgeType: kt, status, entityType, entityId, contextKey: "", valueKind: "duration", unit: "days",
  asOf: ago(1), historyStart: ago(455), recentEnd: ago(1), historyCount: h, recentCount: r,
  baseline: kt === "BASELINE" ? { n: h, median: 3, q1: 2, q3: 4 } : null, recent: null, finding,
  reason: status === "INSUFFICIENT_HISTORY" ? { code: "TOO_FEW_OBSERVATIONS", have: h, need: 10 } : null,
  evidenceFingerprint: `t${id}`, confirmedAt: ago(1), policyVersion: pv(`temporal-${key.replace(/\./g, "-")}`),
});
const CUST = 4242;
const stored = {
  measures: [
    measure(1, "customers.payment_timing", "customers-payment-timing", "customer", CUST),
    measure(2, "billing.payment_timing", "billing-payment-timing"),
    measure(3, "inventory.restock_interval", "inventory-restock-interval", "inventory-item", 70),
    measure(4, "suppliers.delivery_lag", "suppliers-delivery-lag", "supplier", 50),
    measure(5, "inventory.stock_pressure", "inventory-stock-pressure", "inventory-item", 71),
    measure(6, "conversations.first_reply_days", "conversations-first-reply-days"),
    measure(7, "leads.first_handling_days", "leads-first-handling-days"),
  ],
  temporal: [
    temporal(101, "billing.payment_timing", "billing", "BASELINE", "ACTIVE", null),
    temporal(102, "billing.payment_timing", "billing", "MATERIAL_CHANGE", "ACTIVE", { direction: "UP", shift: 6 }),
    temporal(201, "suppliers.purchase_cadence", "suppliers", "BASELINE", "STALE", null, "supplier", 50),
    temporal(202, "suppliers.purchase_cadence", "suppliers", "BASELINE", "ACTIVE", null, "supplier", 51),
    temporal(203, "suppliers.purchase_cadence", "suppliers", "BASELINE", "INSUFFICIENT_HISTORY", null, "supplier", 52, 0, 5),
    temporal(301, "documents.paperwork_lag", "documents", "BASELINE", "INSUFFICIENT_HISTORY", null, null, null, 0, 9),
  ],
  claims: [], vendorCategories: [], decisions: [], identity: [], proposals: [],
  installments: [
    { id: 900, dueAt: new Date(AS_OF.getTime() + 10 * DAY), scheduledAmount: dec(5000), currency: "ILS", commitment: { payeeId: 1 }, allocations: [] },
    { id: 901, dueAt: ago(5), scheduledAmount: dec(300), currency: "ILS", commitment: { payeeId: 1 }, allocations: [] },
  ],
  actions: [], outcomes: [],
  depth: {
    historicalMeasures: [
      { id: 11, measureKey: "suppliers.purchase_cadence", entityType: "supplier", entityId: 50, status: "STALE", valueNumeric: dec(14), valueUnit: "days",
        observationCount: 9, windowStart: ago(500), windowEnd: ago(120), evidenceFingerprint: "h1", policyVersion: pv("suppliers-purchase-cadence") },
      { id: 12, measureKey: "documents.paperwork_lag", entityType: null, entityId: null, status: "SUPERSEDED", valueNumeric: dec(5), valueUnit: "days",
        observationCount: 30, windowStart: ago(400), windowEnd: ago(12), evidenceFingerprint: "h2", policyVersion: pv("vendor-category") },
      { id: 13, measureKey: "customers.payment_timing", entityType: "customer", entityId: CUST + 1, status: "STALE", valueNumeric: dec(9), valueUnit: "days",
        observationCount: 4, windowStart: ago(400), windowEnd: ago(10), evidenceFingerprint: "h3", policyVersion: pv("customers-payment-timing") },
    ],
    previousBaselines: [
      { id: 401, temporalKey: "billing.payment_timing", domain: "billing", entityType: null, entityId: null, contextKey: "", valueKind: "duration", unit: "days",
        historyStart: ago(900), historyEnd: ago(500), historyCount: 30, baseline: { n: 30, median: 1, q1: 0, q3: 2 }, supersededAt: ago(200), evidenceFingerprint: "pb", policyVersion: pv("temporal-billing-payment-timing") },
    ],
    links: [
      { relation: "customer.invoices", left: { type: "customer", id: CUST }, right: null, records: 12, lastAt: ago(3) },
      { relation: "customer.appointments", left: { type: "customer", id: CUST }, right: null, records: 4, lastAt: ago(9) },
      { relation: "customer.invoices", left: { type: "customer", id: CUST + 2 }, right: null, records: 2, lastAt: ago(30) },
      { relation: "customer.invoices", left: { type: "customer", id: CUST + 1 }, right: null, records: 3, lastAt: ago(40) },
      { relation: "supplier.items", left: { type: "supplier", id: 50 }, right: { type: "inventory-item", id: 70 }, records: 6, lastAt: ago(20) },
      { relation: "supplier.items", left: { type: "supplier", id: 50 }, right: { type: "inventory-item", id: 71 }, records: 6, lastAt: ago(20) },
    ],
    receivablesWindow: { days: 30, invoices: 3, amount: 4100, currency: "ILS", invoiceIds: [501, 502, 503] },
  },
} as unknown as StoredKnowledge;
const domain = {
  facts: [], unassignedAwaitingCount: 0,
  awaiting: [{ customerId: CUST, totalOutstanding: "1200.00", currency: "ILS", invoiceCount: 2, invoiceIds: [601, 602], maxDaysAwaiting: 21, awaitingSince: ago(21) }],
} as unknown as DomainState;
const snap = assembleSnapshot(9, AS_OF, stored, domain, { includeGaps: true });
const item = (slot: string) => snap.knowledge.find((k) => k.slot === slot);

/* ───────── 2. temporal states in the BKS ───────── */
const tb = item("tstate|billing.payment_timing|||");
ok("BKS: billing payment timing shifted UP with LOWER polarity → DETERIORATING", (tb?.value as any)?.state === "DETERIORATING", tb?.value);
ok("…its provenance is the two temporal rows", JSON.stringify(tb?.provenance.map((p) => p.id)) === "[101,102]");
ok("BKS: supplier 50 gone quiet → GONE_QUIET, not fresh (never a premise)", (item("tstate|suppliers.purchase_cadence|supplier|50|")?.value as any)?.state === "GONE_QUIET"
  && item("tstate|suppliers.purchase_cadence|supplier|50|")?.freshness.fresh === false);
ok("BKS: supplier 52 new (others have history) → NEW_BEHAVIOR", (item("tstate|suppliers.purchase_cadence|supplier|52|")?.value as any)?.state === "NEW_BEHAVIOR");
ok("BKS: business-level paperwork with no other subject → stays a gap, no state", !item("tstate|documents.paperwork_lag|||")
  && snap.knowledgeGaps.some((g) => g.key.startsWith("documents.paperwork_lag")));
ok("BKS: a STALE temporal row is not counted as an insufficient-history gap (only supplier 52 is)",
  snap.knowledgeGaps.find((g) => g.slot === "gap|suppliers.purchase_cadence|BASELINE|TOO_FEW_OBSERVATIONS")?.subjectsAffected === 1);

/* ───────── 3. memory ───────── */
const stale = item("hist|suppliers.purchase_cadence|supplier|50|STALE");
ok("memory: STALE measure → HISTORICAL_MEASURE with its value and validUntil", (stale?.value as any)?.value === "14" && !!(stale?.value as any)?.validUntil);
ok("memory: never fresh, caveat NOT_CURRENT_KNOWLEDGE", stale?.freshness.fresh === false && stale?.caveats.includes("NOT_CURRENT_KNOWLEDGE"));
const sup = item("hist|documents.paperwork_lag|||SUPERSEDED");
ok("memory: SUPERSEDED (other rule version) keeps no value — not comparable", !!sup && !("value" in (sup.value as any)));
const pb = item("prevbase|billing.payment_timing|||");
ok("memory: previous baseline = what normal used to be (from, until)", !!pb && (pb.value as any).normalFrom && (pb.value as any).normalUntil);

/* ───────── 4. record links ───────── */
const rel = snap.relationships.filter((r) => r.type === "RECORD_LINK");
ok("record links: one per entity and relation, authoritative domain state", rel.length === 6 && rel.every((r) => r.authority === "AUTHORITATIVE_DOMAIN_STATE" && r.via.type === "foreign-key"));
ok("record links: provenance names the relation, never a name", rel.every((r) => r.provenance[0].store === "DomainRecordLink"));

/* ───────── 5. cross-domain families ───────── */
const f = (slot: string) => snap.crossDomainFindings.find((x) => x.slot === slot);
const cust = f(`finding|X-CUST-01|customer|${CUST}`);
ok("X-CUST-01: customer knowledge + invoices + appointments + awaiting → one profile", !!cust && cust.domains.join() === "appointments,billing,collection,customers", cust?.domains);
ok("X-CUST-01: a customer with links but no active knowledge → no finding, counted as a gap",
  !f(`finding|X-CUST-01|customer|${CUST + 2}`) && snap.knowledgeGaps.some((g) => g.ruleId === "X-CUST-01"));
ok("X-CUST-01: a STALE (memory) measure is never a premise", !f(`finding|X-CUST-01|customer|${CUST + 1}`));
const cash = f("finding|X-CASH-01|business");
ok("X-CASH-01: payables due and receivables due side by side", (cash?.value as any)?.payablesDue?.installments === 1 && (cash?.value as any)?.receivablesDue?.invoices === 3
  && (cash?.value as any)?.payablesOverdue?.installments === 1);
ok("X-CASH-01: no adequacy judgement, labelled NOT_A_FORECAST and NO_CASH_BALANCE_KNOWN",
  !!cash && !/cover|enough|afford|shortfall|deficit/i.test(cash.establishes.replace("whether one covers the other", "")) && cash.caveats.includes("NOT_A_FORECAST") && cash.caveats.includes("NO_CASH_BALANCE_KNOWN"));
const repl = f("finding|X-REPL-01|inventory-item|70");
ok("X-REPL-01: item restock + its PO-named supplier's delivery lag", !!repl && repl.premises.some((p) => p.slot.includes("suppliers.delivery_lag")));
ok("X-REPL-01: stock pressure (POS defect) is never a premise", !snap.crossDomainFindings.some((x) => x.premises.some((p) => p.slot.includes("stock_pressure"))));
ok("X-RESP-01: responsiveness known in conversations AND leads", !!f("finding|X-RESP-01|business"));
ok("every finding is non-causal in flag and in words", snap.crossDomainFindings.every((x) => x.causal === false && !CAUSAL.test(x.establishes)));
ok("X-PARTY-01 ignores record links (they are not identity)", !snap.crossDomainFindings.some((x) => x.ruleId === "X-PARTY-01"));
ok("families: D, F, G, I READY; E still BLOCKED", ["D", "F", "G", "I"].every((k) => CROSS_DOMAIN_FAMILIES.find((x) => x.family === k)?.status === "READY")
  && CROSS_DOMAIN_FAMILIES.find((x) => x.family === "E")?.status === "BLOCKED_SENSOR");

/* ───────── 6. Brain context ───────── */
const { context } = buildBrainContext({ ...snap, stats: { truncated: {} } } as unknown as BusinessKnowledgeSnapshot);
const ser = JSON.stringify(context);
const ts = context.knowledge.find((k) => k.kind === "TEMPORAL_STATE" && k.key === "billing.payment_timing");
ok("Brain: the temporal state reaches it with state and direction", ts?.facts.state === "DETERIORATING" && ts?.facts.direction === "UP");
ok("Brain: the raw baseline of a summarised series is not sent twice", !context.knowledge.some((k) => k.kind === "BASELINE" && k.key === "billing.payment_timing"));
ok("Brain: memory reaches it labelled NOT_CURRENT_KNOWLEDGE", context.knowledge.some((k) => k.kind === "HISTORICAL_MEASURE" && k.caveats.includes("NOT_CURRENT_KNOWLEDGE")));
const cf = context.findings.find((x) => x.type === "OBLIGATIONS_AND_RECEIVABLES_IN_WINDOW");
ok("Brain: cash finding carries counts, never amounts", cf?.facts.payablesDue_installments === 1 && cf?.facts.receivablesDue_invoices === 3 && !("payablesDue_amount" in (cf?.facts ?? {})));
ok("Brain: no money value and no customer id anywhere", !ser.includes("4100") && !ser.includes("5000") && !ser.includes("1200") && !ser.includes(String(CUST)) && !ser.includes("777.77"));
ok("Brain: record links themselves are not serialized", !("relationships" in context));
ok("Brain: context version v3", context.contextVersion === "brain-context.v3");

/* ───────── 7. tenancy & determinism ───────── */
ok("BKS is for exactly the given business", snap.businessId === 9);
const again = assembleSnapshot(9, AS_OF, stored, domain, { includeGaps: true });
ok("deterministic: same inputs → same fingerprint", again.snapshotFingerprint === snap.snapshotFingerprint);
const reversed = { ...stored, depth: { ...(stored as any).depth, links: [...(stored as any).depth.links].reverse() }, temporal: [...stored.temporal].reverse() } as StoredKnowledge;
ok("deterministic: input row order does not change the snapshot", assembleSnapshot(9, AS_OF, reversed, domain, { includeGaps: true }).snapshotFingerprint === snap.snapshotFingerprint);

console.log(failed === 0 ? "\nBusiness Brain: time, memory, relationships and cross-domain knowledge — grounded, non-causal, private. ✔" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
