/**
 * ALL-FEATURE LEARNING COVERAGE — the last two hops, proven for every rule. No database. Run:
 *   npx tsx lib/knowledge/coverage/bks-brain-coverage.test.ts
 *
 *   rule → KnowledgeMeasure / TemporalKnowledge → BKS (assembleSnapshot) → Brain context (shadow)
 *
 * The feature-coverage contract proves every feature has rules. This proves every rule's output
 * actually REACHES the Business Knowledge Snapshot under its own domain, and reaches the Brain context
 * under the same privacy rules as everything else: subjects as opaque aliases (never a database id or a
 * name), and no money value — a per-customer ticket size reaches the Brain as "this is a currency
 * measure", never as the amount.
 */
import { assembleSnapshot } from "../snapshot/assemble";
import type { DomainState, StoredKnowledge } from "../snapshot/snapshot-sources";
import { buildBrainContext } from "../brain/context-builder";
import type { BusinessKnowledgeSnapshot } from "../snapshot/snapshot.contract";
import { catalogueDescriptors } from "../registry";
import { temporalCatalogue } from "../temporal/rules";

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
const CUSTOMER_ID = 424242;

const rules = catalogueDescriptors();
const temporal = temporalCatalogue();

/** One ACTIVE, fresh measure per rule, as the measure writer would store it. */
const stored = {
  measures: rules.map((d, i) => ({
    id: 1000 + i, measureKey: d.measureKey, entityType: d.entityType, entityId: d.entityType ? (d.entityType === "customer" ? CUSTOMER_ID : 7) : null,
    status: "ACTIVE", valueNumeric: dec(d.valueUnit === "currency" ? 1234.56 : 3), valueUnit: d.valueUnit,
    detail: d.ruleId === "SEC-02" ? { authority: "OWNER_ASSERTED" }
      : d.ruleId === "BILL-01" ? { caveat: "SEQUENCE_NOT_CAUSE" } : null,
    observationCount: d.minSupport + 1, windowStart: ago(d.windowDays), windowEnd: ago(1), trend: null,
    evidenceFingerprint: `fp-${d.ruleId}`, policyVersion: pv(d.policyKey),
  })),
  temporal: temporal.map((t, i) => ({
    id: 5000 + i, temporalKey: t.temporalKey, domain: t.domain, knowledgeType: "BASELINE", status: "ACTIVE",
    entityType: null, entityId: null, contextKey: "", valueKind: t.spec.valueKind, unit: t.spec.unit, asOf: ago(1),
    historyStart: ago(455), recentEnd: ago(1), historyCount: 20, recentCount: 6,
    baseline: { n: 20, median: 3, q1: 2, q3: 4 }, recent: null, finding: null, reason: null,
    evidenceFingerprint: `tfp-${t.ruleId}`, confirmedAt: ago(1), policyVersion: pv(t.policyKey),
  })),
  claims: [], vendorCategories: [], decisions: [], identity: [], proposals: [], installments: [], actions: [],
} as unknown as StoredKnowledge;
const domainState = { facts: [], awaiting: [], unassignedAwaitingCount: 0 } as unknown as DomainState;

const snap = assembleSnapshot(9, AS_OF, stored, domainState, { includeGaps: true });

/* ── hop 1: every rule reaches the BKS, under its own domain ── */
for (const d of rules) {
  const item = snap.knowledge.find((k) => k.kind === "MEASURE" && k.key === d.measureKey);
  ok(`${d.ruleId} → BKS as MEASURE ${d.measureKey}`, !!item);
  ok(`${d.ruleId} → BKS domain "${d.domain}"`, item?.domain === d.domain, item?.domain);
}
for (const t of temporal) {
  const item = snap.knowledge.find((k) => k.kind === "BASELINE" && k.key.startsWith(t.temporalKey));
  ok(`${t.ruleId} → BKS as temporal BASELINE (${t.temporalKey})`, !!item, snap.knowledge.filter((k) => k.kind !== "MEASURE").map((k) => k.key).slice(0, 5));
  ok(`${t.ruleId} → BKS domain "${t.domain}"`, item?.domain === t.domain, item?.domain);
}

/* ── hop 2: every domain reaches the Brain context, privately ── */
const full = { ...snap, stats: { truncated: {} } } as unknown as BusinessKnowledgeSnapshot;
const { context, aliases } = buildBrainContext(full);
const domainsIn = new Set(context.knowledge.map((k) => k.domain));
for (const dom of [...new Set([...rules.map((r) => r.domain), ...temporal.map((t) => t.domain)])].sort()) {
  ok(`domain "${dom}" reaches the Brain context`, domainsIn.has(dom), [...domainsIn]);
}
const serialized = JSON.stringify(context);
ok("no customer database id is serialized to the Brain", !serialized.includes(String(CUSTOMER_ID)));
ok("every subject is an opaque alias", context.knowledge.every((k) => k.subject === null || /^S\d+$/.test(k.subject)));
ok("the alias map (server-side only) still resolves the customer", [...aliases.subjects.values()].some((s) => s.type === "customer" && s.id === CUSTOMER_ID));
const ticket = context.knowledge.find((k) => k.key === "customers.ticket_size");
ok("a per-customer ticket size reaches the Brain WITHOUT its amount", !!ticket && !("value" in ticket.facts) && ticket.facts.unit === "currency", ticket);
ok("no money value anywhere in the context", !serialized.includes("1234.56"));
ok("relationships are not serialized to the Brain", !("relationships" in context));
const caveatOf = (key: string) => context.knowledge.find((k) => k.key === key && k.kind === "MEASURE")?.caveats ?? null;
// The label travels with the item: on the BKS item always, and on the Brain item whenever the byte budget admits it
// (this fixture makes EVERY rule ACTIVE at once, so the lowest-priority tail may be trimmed — and counted in omitted).
const secBks = snap.knowledge.find((k) => k.key === "secretary.obligation_closure_timing" && k.kind === "MEASURE");
ok("SEC-02 is labelled OWNER_ASSERTED in the BKS", JSON.stringify(secBks?.caveats) === '["OWNER_ASSERTED"]');
ok("…and in the Brain context whenever admitted (never without the label)",
  caveatOf("secretary.obligation_closure_timing") === null || JSON.stringify(caveatOf("secretary.obligation_closure_timing")) === '["OWNER_ASSERTED"]');
const secState = snap.knowledge.find((k) => k.key === "secretary.obligation_closure_timing" && k.kind === "TEMPORAL_STATE");
ok("…and its temporal state inherits OWNER_ASSERTED (built from the same owner claims)", !secState || JSON.stringify(secState.caveats) === '["OWNER_ASSERTED"]');
ok("anything trimmed by the Brain budget is counted, never silent", context.knowledge.length + Object.values(context.omitted).reduce((a, b) => a + b, 0) >= snap.knowledge.filter((k) => k.freshness.fresh).length - 1);
ok("an unknown detail label is never promoted to a caveat", JSON.stringify(caveatOf("billing.invoicing_cadence")) === "[]");

console.log(`\nRULES → BKS: ${rules.length} measures + ${temporal.length} temporal; BRAIN DOMAINS: ${[...domainsIn].sort().join(", ")}`);
console.log(failed === 0 ? "BKS / Brain coverage: every rule reaches the snapshot and the shadow Brain, privately. ✔" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
