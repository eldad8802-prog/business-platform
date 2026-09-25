/**
 * M7 · Snapshot assembly and cross-domain rules, without a database. Run:
 *   npx tsx lib/knowledge/snapshot/snapshot.test.ts
 *
 * The properties that break silently: a gap that looks like knowledge, a conflict quietly resolved, a
 * duplicate counted twice, a name resemblance joining two domains, a finding outliving its premise, a
 * cause smuggled into an output, a DB row order changing the answer.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assembleSnapshot } from "./assemble";
import { CROSS_DOMAIN_FAMILIES, CROSS_DOMAIN_RULES } from "./cross-domain";
import type { DomainState, StoredKnowledge } from "./snapshot-sources";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else { failed += 1; console.error(`FAIL: ${name}`, extra ?? ""); }
}

const AS_OF = new Date("2026-09-01T00:00:00.000Z");
const DAY = 86_400_000;
const ago = (d: number) => new Date(AS_OF.getTime() - d * DAY);
const pv = (key: string, version = "v1") => ({ version, policy: { key } });
const dec = (n: number) => ({ toString: () => String(n) }) as unknown as import("@prisma/client").Prisma.Decimal;

function baseStored(): StoredKnowledge {
  return {
    measures: [
      { id: 11, measureKey: "documents.paperwork_lag", entityType: null, entityId: null, status: "ACTIVE", valueNumeric: dec(4),
        valueUnit: "days", detail: null, observationCount: 24, windowStart: ago(180), windowEnd: ago(1), trend: null,
        evidenceFingerprint: "fp-a", policyVersion: pv("documents-paperwork-lag") },
      { id: 12, measureKey: "suppliers.purchase_cadence", entityType: "supplier", entityId: 7, status: "ACTIVE", valueNumeric: dec(28),
        valueUnit: "days", detail: null, observationCount: 4, windowStart: ago(365), windowEnd: ago(1), trend: null,
        evidenceFingerprint: "fp-b", policyVersion: pv("suppliers-purchase-cadence") },
      { id: 13, measureKey: "payables.payment_timing", entityType: null, entityId: null, status: "INSUFFICIENT_EVIDENCE", valueNumeric: dec(0),
        valueUnit: "days", detail: { minSupport: 5, have: 2 }, observationCount: 2, windowStart: ago(365), windowEnd: ago(1), trend: null,
        evidenceFingerprint: "fp-c", policyVersion: pv("payables-payment-timing") },
    ],
    temporal: Array.from({ length: 30 }, (_, i) => ({
      id: 100 + i, temporalKey: "documents.vendor_amount", domain: "documents", knowledgeType: "BASELINE", status: "INSUFFICIENT_HISTORY",
      entityType: "party", entityId: 500 + i, contextKey: "", valueKind: "amount", unit: "currency", asOf: ago(1),
      historyStart: ago(485), recentEnd: ago(1), historyCount: i % 4, recentCount: 0, baseline: null, recent: null, finding: null,
      reason: { code: "TOO_FEW_OBSERVATIONS", have: i % 4, need: 6 }, evidenceFingerprint: "x", confirmedAt: ago(1),
      policyVersion: pv("temporal-documents-vendor-amount"),
    })),
    claims: [],
    vendorCategories: [],
    decisions: [],
    identity: [],
    proposals: [],
    installments: [],
    actions: [],
  } as unknown as StoredKnowledge;
}
function baseDomain(): DomainState {
  return { facts: [], awaiting: [], unassignedAwaitingCount: 0 } as unknown as DomainState;
}
const build = (s: StoredKnowledge, d: DomainState, asOf = AS_OF) => assembleSnapshot(9, asOf, s, d, { includeGaps: true });

/* ── gaps are separate from knowledge, and normalised ── */
{
  const snap = build(baseStored(), baseDomain());
  ok("ACTIVE measures are knowledge", snap.knowledge.filter((k) => k.kind === "MEASURE").length === 2);
  ok("an INSUFFICIENT measure is a gap, never a knowledge item", !snap.knowledge.some((k) => k.key === "payables.payment_timing") &&
    snap.knowledgeGaps.some((g) => g.key === "payables.payment_timing" && g.kind === "INSUFFICIENT_EVIDENCE" && g.need === 5));
  const vg = snap.knowledgeGaps.filter((g) => g.key.startsWith("documents.vendor_amount"));
  ok("30 insufficient vendor series collapse into ONE gap with a count and a have-range",
    vg.length === 1 && vg[0].subjectsAffected === 30 && vg[0].have?.min === 0 && vg[0].have?.max === 3 && vg[0].need === 6, vg);
  ok("every non-READY family is stated as a RULE_BLOCKED gap",
    snap.knowledgeGaps.filter((g) => g.kind === "RULE_BLOCKED").length === CROSS_DOMAIN_FAMILIES.filter((f) => f.status !== "READY").length);
}

/* ── determinism: row order and repeated builds ── */
{
  const s = baseStored();
  const a = build(s, baseDomain());
  const shuffled = { ...s, measures: [...s.measures].reverse(), temporal: [...s.temporal].reverse() } as StoredKnowledge;
  const b = build(shuffled, baseDomain());
  ok("DB row order does not change the snapshot fingerprint", a.snapshotFingerprint === b.snapshotFingerprint);
  ok("…nor the order of knowledge items", JSON.stringify(a.knowledge.map((k) => k.slot)) === JSON.stringify(b.knowledge.map((k) => k.slot)));
  const renumbered = { ...s, measures: s.measures.map((m) => ({ ...m, id: m.id + 1000 })) } as StoredKnowledge;
  ok("a re-derived measure with a new row id is the SAME knowledge (ids are provenance, not semantics)",
    build(renumbered, baseDomain()).snapshotFingerprint === a.snapshotFingerprint);
  const changed = { ...s, measures: s.measures.map((m) => (m.id === 11 ? { ...m, valueNumeric: dec(9) } : m)) } as StoredKnowledge;
  ok("a changed value is a different snapshot", build(changed, baseDomain()).snapshotFingerprint !== a.snapshotFingerprint);
}

/* ── deduplication and divergent-slot conflict ── */
{
  const s = baseStored();
  const dup = { ...s, measures: [...s.measures, { ...s.measures[0], id: 99, policyVersion: pv("documents-paperwork-lag", "v1") }] } as StoredKnowledge;
  const d = build(dup, baseDomain());
  const lag = d.knowledge.filter((k) => k.key === "documents.paperwork_lag");
  ok("the same knowledge from two stored rows appears ONCE, with both provenances", lag.length === 1 && lag[0].provenance.length === 2);
  const div = { ...s, measures: [...s.measures, { ...s.measures[0], id: 98, valueNumeric: dec(12) }] } as StoredKnowledge;
  const v = build(div, baseDomain());
  const c = v.conflicts.find((x) => x.kind === "DIVERGENT_SAME_SLOT");
  ok("two different values for one slot: both kept, a CONFLICT recorded, UNRESOLVED",
    v.knowledge.filter((k) => k.key === "documents.paperwork_lag").length === 2 && c?.resolution === "UNRESOLVED" && c.sides.length === 2);
}

/* ── claims: competing values and owner authority ── */
{
  const s = { ...baseStored(),
    claims: [{ id: 5, subjectDomain: "vendor", subjectNormalizedKey: "acme", claimType: "vendor-category", evidenceSetFingerprint: "e",
      materializedAt: ago(2), policyVersion: pv("vendor-category"), candidates: [{ id: 1, propositionValue: "office" }, { id: 2, propositionValue: "food" }] }],
    vendorCategories: [{ id: 44, vendorNameNormalized: "acme", category: "rent" }] } as unknown as StoredKnowledge;
  const snap = build(s, baseDomain());
  const claim = snap.knowledge.find((k) => k.kind === "CLAIM");
  ok("a vendor claim's subject is a row id, never the vendor's name", claim?.subject?.type === "vendor-learning" && !JSON.stringify(snap).includes("acme"));
  ok("competing candidate values are an UNRESOLVED conflict", snap.conflicts.some((c) => c.kind === "COMPETING_CLAIM_VALUES" && c.resolution === "UNRESOLVED"));
  const mo = snap.conflicts.find((c) => c.kind === "MACHINE_VS_OWNER");
  ok("machine claim vs the owner's own category: the owner PREVAILS, and both sides are kept",
    mo?.resolution === "RESOLVED_BY_AUTHORITY" && mo.prevailing === "OWNER_CONFIRMED" && mo.sides.length === 2);
  ok("the owner's truth and the inference carry different authority", claim?.authority === "DERIVED_CLAIM");
}

/* ── identity: authority joins, resemblance does not ── */
function partyStored(withLink: boolean): StoredKnowledge {
  const s = baseStored();
  return { ...s,
    identity: withLink
      ? [{ id: 1, partyId: 900, subjectType: "SUPPLIER", subjectId: 7, method: "DETERMINISTIC_EXACT" },
         { id: 2, partyId: 900, subjectType: "PAYEE", subjectId: 70, method: "OWNER_CONFIRMED" }]
      : [],
    // The weak version of the same link: a machine proposal only.
    proposals: withLink ? [] : [{ id: 3, subjectType: "PAYEE", subjectId: 70, candidatePartyId: 900, state: "PROPOSED", signalType: "NORMALIZED_NAME" }],
    installments: [{ id: 61, dueAt: ago(5), scheduledAmount: dec(500), currency: "ILS", commitment: { payeeId: 70 }, allocations: [] }],
  } as unknown as StoredKnowledge;
}
{
  const linked = build(partyStored(true), baseDomain());
  const f = linked.crossDomainFindings.find((x) => x.ruleId === "X-PARTY-01");
  ok("POSITIVE: a supplier and a payee bound by tax id + owner produce a cross-domain finding",
    f?.subject.id === 900 && f.domains.includes("suppliers") && f.domains.includes("payables"));
  ok("…which says what co-occurs and claims no cause", f?.causal === false && !/because|caus|driv|impact|led to/i.test(f.establishes));
  ok("…and traces back to its premises (relationship, measure, exposure)",
    (f?.premises.length ?? 0) >= 3 && f!.premises.some((p) => p.provenance.some((r) => r.store === "KnowledgeMeasure")) &&
      f!.premises.some((p) => p.provenance.some((r) => r.store === "PartyResolutionClaim")));
  const weak = build(partyStored(false), baseDomain());
  ok("NEGATIVE: the same pair linked only by a name PROPOSAL produces no finding",
    !weak.crossDomainFindings.some((x) => x.ruleId === "X-PARTY-01"));
  ok("…the proposal is visible as PROPOSED, with MACHINE_PROPOSAL authority",
    weak.relationships.some((r) => r.status === "PROPOSED" && r.authority === "MACHINE_PROPOSAL"));
}

/* ── a stale premise cannot satisfy a rule ── */
{
  const s = partyStored(true);
  const stale = { ...s, measures: s.measures.map((m) => (m.id === 12 ? { ...m, windowEnd: ago(200) } : m)), installments: [] } as StoredKnowledge;
  const snap = build(stale, baseDomain());
  ok("with the only supplier knowledge 200 days old (and no open payables), the rule does not fire",
    !snap.crossDomainFindings.some((x) => x.ruleId === "X-PARTY-01"));
  ok("…and says so as a PREMISE_UNAVAILABLE gap", snap.knowledgeGaps.some((g) => g.ruleId === "X-PARTY-01" && g.kind === "PREMISE_UNAVAILABLE"));
}

/* ── collections: exposure with recorded activity, no causal wording ── */
{
  const s = { ...baseStored(), actions: [{ id: 1, customerId: 3, occurredAt: ago(4), channel: "WHATSAPP" }] } as unknown as StoredKnowledge;
  const d = { facts: [], unassignedAwaitingCount: 0, awaiting: [
    { customerId: 3, totalOutstanding: "1200.00", currency: "ILS", invoiceCount: 2, invoiceIds: [31, 32], maxDaysAwaiting: 20, awaitingSince: ago(20) },
    { customerId: 8, totalOutstanding: "300.00", currency: "ILS", invoiceCount: 1, invoiceIds: [33], maxDaysAwaiting: 3, awaitingSince: ago(3) },
  ] } as unknown as DomainState;
  const snap = build(s, d);
  const f3 = snap.crossDomainFindings.find((x) => x.slot === "finding|X-COLL-01|customer|3");
  const f8 = snap.crossDomainFindings.find((x) => x.slot === "finding|X-COLL-01|customer|8");
  ok("an overdue customer with a recorded reminder: the combined condition is stated",
    (f3?.value as { recordedRemindersLast90d: number }).recordedRemindersLast90d === 1 && (f3?.value as { remindersSinceAwaiting: number }).remindersSinceAwaiting === 1);
  ok("an overdue customer with NO recorded reminder is stated too — with the caveat that outside reminders are unseen",
    (f8?.value as { recordedRemindersLast90d: number }).recordedRemindersLast90d === 0 && f8!.caveats.includes("REMINDERS_OUTSIDE_DUBIZ_NOT_OBSERVED"));
  ok("no finding type or sentence asserts a cause",
    snap.crossDomainFindings.every((x) => x.causal === false && !/CAUSE|DRIVER|IMPACT/.test(x.type) && !/because|caus/i.test(x.establishes)));
}

/* ── privacy and the AI boundary, statically ── */
{
  const dir = join(__dirname);
  // Code only: the comments in this layer SAY "no LLM, no embeddings", which is the point.
  const src = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => readFileSync(join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""))
    .join("\n");
  ok("no LLM, embedding or model SDK anywhere in the snapshot layer",
    !/openai|anthropic|@google\/generative|gemini|embedding|vector|chat\.completions|messages\.create/i.test(src));
  const sources = readFileSync(join(dir, "snapshot-sources.ts"), "utf8");
  ok("the producers never select names, phones, emails, text, notes, titles or payloads",
    !/\b(name|customerName|payeeNameSnapshot|phone|email|contentText|ocrText|title|note|notes|rawPayload|payload|signalValue|taxId)\s*:\s*true/.test(sources));
  ok("the snapshot layer never logs", !/console\./.test(src));
  ok("rules are versioned and declared", CROSS_DOMAIN_RULES.every((r) => /^X-[A-Z]+-\d+$/.test(r.ruleId) && /^v\d+$/.test(r.version) && r.requires.length > 40));
}

/* ── bounds: history size does not grow the snapshot ── */
{
  const s = baseStored();
  const many = { ...s, temporal: Array.from({ length: 3000 }, (_, i) => ({ ...s.temporal[0], id: 5000 + i, entityId: 9000 + i })) } as StoredKnowledge;
  const small = build(s, baseDomain());
  const big = build(many, baseDomain());
  ok("3,000 insufficient series produce the same number of gap entries as 30",
    big.knowledgeGaps.length === small.knowledgeGaps.length);
}

console.log(failed === 0 ? "\nM7 snapshot: governed, separated, traceable, bounded. ✔" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
