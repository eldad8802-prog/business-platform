/**
 * M9 · Outcome-learning evaluation corpus — PURE, deterministic, no database, no model. Run:
 *   npx tsx lib/knowledge/outcomes/outcomes.test.ts
 *
 * Every M9 phase-12 case that does not need a real database: generation and memory, decision
 * semantics, action and outcome tracking, reversal, supersession, late and duplicate events, the
 * attribution vocabulary, learning thresholds, the feedback into bks.v1 and the Brain context, and
 * the causal-wording boundary. Synthetic TEST data only.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { deriveCandidates, effectiveDecision, planRecommendations, type BrainLink } from "./recommend";
import { trackOutcomes, type DomainTruth, type InstallmentTruth } from "./track";
import { assessRecommendation, type AssessAction, type AssessObservation } from "./assess";
import { learnFromOutcomes, type OutcomeLearningRow } from "./learn";
import { ATTRIBUTIONS, type StoredDecision, type StoredRecommendation } from "./outcome.contract";
import { buildBrainContext } from "../brain/context-builder";
import { validateBrainOutput } from "../brain/validator";
import { BRAIN_SYSTEM_PROMPT } from "../brain/prompt";
import type { BusinessKnowledgeSnapshot, KnowledgeItem } from "../snapshot/snapshot.contract";
import type { ValidatedFinding } from "../brain/brain.contract";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else { failed += 1; console.error(`FAIL: ${name}`, extra ?? ""); }
}

const DAY = 86_400_000;
const T0 = new Date("2026-06-01T09:00:00.000Z");
const at = (d: number) => new Date(T0.getTime() + d * DAY);
const BIZ = 77;

function fact(slot: string, key: string, subject: { type: string; id: number }, value: Record<string, unknown>): KnowledgeItem {
  return {
    slot, kind: "FACT", domain: key === "documents-inbox" ? "documents" : "payables", subject, key, ruleId: key, ruleVersion: null,
    authority: "AUTHORITATIVE_DOMAIN_STATE", value, observationCount: null, window: null, status: "ACTIVE",
    freshness: { ageDays: 0, fresh: true }, evidence: { fingerprint: null, refCount: null }, caveats: [],
    provenance: [{ store: "BusinessStatus", id: slot }], conflictIds: [],
  };
}
function snap(knowledge: KnowledgeItem[], over: Partial<BusinessKnowledgeSnapshot> = {}): BusinessKnowledgeSnapshot {
  return {
    contractVersion: "bks.v2", businessId: BIZ, asOf: T0.toISOString(), knowledge, relationships: [], crossDomainFindings: [],
    conflicts: [], knowledgeGaps: [], snapshotFingerprint: "fp", stats: { counts: {}, truncated: {}, serializedBytes: 0, largestSection: "knowledge", queries: 10 },
    ...over,
  };
}
const docFact = (id: number) => fact(`fact|documents-inbox|document|${id}`, "documents-inbox", { type: "document", id }, { category: "ACTION_REQUIRED", severity: "MEDIUM" });
const instFact = (id: number, severity = "HIGH") => fact(`fact|payables-schedule|installment|${id}`, "payables-schedule", { type: "installment", id }, { category: "ACTION_REQUIRED", severity });

let nextId = 100;
function stored(c: ReturnType<typeof deriveCandidates>[number], over: Partial<StoredRecommendation> = {}): StoredRecommendation {
  const issuedAt = over.issuedAt ?? T0;
  const window = c.type === "REVIEW_PENDING_DOCUMENTS" ? 14 : 30;
  return {
    id: over.id ?? nextId++, recommendationKey: c.recommendationKey, version: 1, type: c.type, subjectType: c.subject.type, subjectId: c.subject.id,
    targets: c.targets, severity: c.severity, evidenceFingerprint: c.evidenceFingerprint, issuedAt,
    validUntil: new Date(issuedAt.getTime() + 14 * DAY), outcomeWindowEnd: new Date(issuedAt.getTime() + window * DAY),
    status: "ACTIVE", closedAt: null, ...over,
  };
}
const decision = (recommendationId: number, kind: StoredDecision["decision"], day: number, over: Partial<StoredDecision> = {}): StoredDecision => ({
  id: nextId++, recommendationId, recommendationVersion: 1, decision: kind, modification: null, deferUntil: null, decidedAt: at(day), supersedesDecisionId: null, ...over,
});

function installment(id: number, allocations: InstallmentTruth["allocations"], status = "SCHEDULED"): InstallmentTruth {
  return { installmentId: id, dueAt: at(-10), status, scheduledAmount: 1000, allocations };
}
const alloc = (id: number, createdDay: number, paidDay: number, amount = 1000, over: { reversedDay?: number; voidedDay?: number } = {}) => ({
  id, createdAt: at(createdDay), createdByUserId: 5, allocatedAmount: amount, reversedAt: over.reversedDay != null ? at(over.reversedDay) : null,
  payment: { id: id + 1000, status: over.voidedDay != null ? "VOID" : "RECORDED", paidAt: at(paidDay), voidedAt: over.voidedDay != null ? at(over.voidedDay) : null },
});
const truth = (over: Partial<DomainTruth>): DomainTruth => ({ documents: new Map(), installments: new Map(), backlogAtWindowEnd: new Map(), ...over });

/** Track, then assess — the service's own composition, pure. */
function pipeline(asOf: Date, recs: StoredRecommendation[], decisions: StoredDecision[], t: DomainTruth, existing: (AssessObservation & { recommendationId: number })[] = []) {
  const tracked = trackOutcomes({ asOf, recommendations: recs, decisions, truth: t, existingObservations: existing });
  const actions: AssessAction[] = tracked.actions;
  // Exactly the service's composition: stored and freshly tracked, de-duplicated by idempotency key.
  const observations: AssessObservation[] = [...new Map([...existing, ...tracked.observations].map((o) => [o.idempotencyKey, o])).values()];
  return { tracked, assessments: recs.map((rec) => assessRecommendation({ asOf, rec, decisions, actions, observations })) };
}

async function main(): Promise<void> {
  /* ── Generation: only from governed knowledge ── */
  const docs = snap([docFact(1), docFact(2), docFact(3)]);
  const cDocs = deriveCandidates(docs, { pendingDocumentIds: [3, 1, 2, 2] });
  ok("a review backlog of 3 supported by snapshot facts yields ONE queue recommendation with sorted, unique targets",
    cDocs.length === 1 && cDocs[0].type === "REVIEW_PENDING_DOCUMENTS" && cDocs[0].targets.join() === "1,2,3");
  ok("its supporting slots are exactly snapshot slots", cDocs[0].supportingSlots.every((s) => docs.knowledge.some((k) => k.slot === s)));
  ok("below the minimum backlog there is no recommendation", deriveCandidates(docs, { pendingDocumentIds: [1, 2] }).length === 0);
  ok("a backlog the snapshot does not state yields nothing (no knowledge → no recommendation)",
    deriveCandidates(snap([]), { pendingDocumentIds: [1, 2, 3, 4] }).length === 0);
  const gapsOnly = snap([], { knowledgeGaps: [{ slot: "gap|payables.payment_timing|INSUFFICIENT_EVIDENCE", domain: "payables", key: "payables.payment_timing", ruleId: "x", kind: "INSUFFICIENT_EVIDENCE", reason: "BELOW_MINIMUM_SUPPORT", subjectsAffected: 3, have: { min: 1, max: 1 }, need: 5, needSpanDays: null }] });
  ok("GAP AS FACT: a snapshot of gaps produces no recommendation", deriveCandidates(gapsOnly, { pendingDocumentIds: [] }).length === 0);
  const proposed = snap([], { relationships: [{ slot: "rel|proposal|1", type: "SAME_COUNTERPARTY", left: { type: "supplier", id: 1 }, right: { type: "party", id: 2 }, via: { type: "party", id: 2 }, status: "PROPOSED", authority: "MACHINE_PROPOSAL", provenance: [] }] });
  ok("PROPOSED RELATIONSHIP AS PREMISE: a proposal alone produces no recommendation", deriveCandidates(proposed, { pendingDocumentIds: [] }).length === 0);
  const warn = fact("fact|payables-schedule|installment|8", "payables-schedule", { type: "installment", id: 8 }, { category: "WARNING", severity: "MEDIUM" });
  const cInst = deriveCandidates(snap([instFact(7), warn]), { pendingDocumentIds: [] });
  ok("an OVERDUE installment (ACTION_REQUIRED) yields one recommendation; a due-soon WARNING yields none",
    cInst.length === 1 && cInst[0].subject.id === 7 && cInst[0].type === "SETTLE_OVERDUE_INSTALLMENT");

  /* ── Brain linkage: a validated finding is recorded as the source, never as the author ── */
  const vf = (key: string, slots: string[]): ValidatedFinding => ({ findingKey: key, type: "ATTENTION", priority: "HIGH", uncertainty: "SUPPORTED",
    observation: "x", interpretation: null, knowledgeSlots: slots, findingSlots: [], conflictIds: [], gapSlots: [], subjects: [] });
  const brain: BrainLink = { findings: [vf("fk-b", [instFact(7).slot]), vf("fk-a", [instFact(7).slot]), vf("fk-z", ["fact|other"])],
    meta: { contractVersion: "brain.v1", promptVersion: "brain-prompt.v2", contextVersion: "brain-context.v2", model: "m", contextFingerprint: "cfp" } };
  const pBrain = planRecommendations({ asOf: T0, candidates: cInst, stored: [], decisions: [], brain });
  ok("a finding citing the same knowledge becomes the source (smallest findingKey, deterministic)",
    pBrain.issue[0].source.kind === "BRAIN_FINDING" && (pBrain.issue[0].source as { findingKey: string }).findingKey === "fk-a");
  ok("… but the type, subject and targets are the catalogue's, not the model's",
    pBrain.issue[0].candidate.type === "SETTLE_OVERDUE_INSTALLMENT" && pBrain.issue[0].candidate.targets.join() === "7");
  ok("without a finding the source is the knowledge rule",
    planRecommendations({ asOf: T0, candidates: cInst, stored: [], decisions: [], brain: null }).issue[0].source.kind === "KNOWLEDGE_RULE");

  /* ── Memory / dedupe / supersession / suppression ── */
  const r1 = stored(cInst[0], { id: 1 });
  let p = planRecommendations({ asOf: at(1), candidates: cInst, stored: [r1], decisions: [], brain: null });
  ok("DEDUPE: the same situation while ACTIVE issues nothing", p.issue.length === 0 && p.suppressed[0]?.reason === "DEDUPED_ACTIVE");
  const worse = deriveCandidates(snap([instFact(7, "CRITICAL")]), { pendingDocumentIds: [] });
  p = planRecommendations({ asOf: at(2), candidates: worse, stored: [r1], decisions: [], brain: null });
  ok("SUPERSEDED: a material change issues v2 and supersedes v1",
    p.issue.length === 1 && p.issue[0].version === 2 && p.issue[0].supersedesId === 1 && p.close.some((c) => c.id === 1 && c.status === "SUPERSEDED"));
  p = planRecommendations({ asOf: at(20), candidates: cInst, stored: [r1], decisions: [], brain: null });
  ok("STALE: past its validity, an unanswered recommendation EXPIRES — silence is not a decision",
    p.close.some((c) => c.id === 1 && c.status === "EXPIRED") && p.issue.length === 0 && p.suppressed[0].reason === "SUPPRESSED_EXPIRED_COOLDOWN");
  p = planRecommendations({ asOf: at(1), candidates: [], stored: [r1], decisions: [], brain: null });
  ok("the condition gone → RESOLVED", p.close.some((c) => c.id === 1 && c.status === "RESOLVED"));
  const rRej = stored(cInst[0], { id: 2, status: "EXPIRED", closedAt: at(15) });
  p = planRecommendations({ asOf: at(60), candidates: cInst, stored: [rRej], decisions: [decision(2, "REJECT", 3)], brain: null });
  ok("REJECTED: the same situation is never raised again, however long it lasts", p.issue.length === 0 && p.suppressed[0].reason === "SUPPRESSED_REJECTED");
  p = planRecommendations({ asOf: at(60), candidates: worse, stored: [rRej], decisions: [decision(2, "REJECT", 3)], brain: null });
  ok("REJECTED, then materially worse: raised again as a new version", p.issue.length === 1 && p.issue[0].version === 2 && p.issue[0].reason === "MATERIAL_CHANGE");
  const notNow = decision(2, "NOT_NOW", 3, { deferUntil: at(30) });
  ok("NOT_NOW: suppressed until the deferral passes",
    planRecommendations({ asOf: at(20), candidates: cInst, stored: [rRej], decisions: [notNow], brain: null }).issue.length === 0 &&
    planRecommendations({ asOf: at(31), candidates: cInst, stored: [rRej], decisions: [notNow], brain: null }).issue.length === 1);
  ok("the latest decision is the effective one (a change of mind is history, not an overwrite)",
    effectiveDecision([decision(2, "REJECT", 3), decision(2, "ACCEPT", 4)], 2)?.decision === "ACCEPT");

  /* ── Case 1: accepted + completed action + observed outcome ── */
  const rA = stored(cInst[0], { id: 10 });
  const acc = decision(10, "ACCEPT", 1);
  let res = pipeline(at(40), [rA], [acc], truth({ installments: new Map([[7, installment(7, [alloc(501, 3, 3)])]]) }));
  let a = res.assessments[0];
  ok("ACCEPT + payment recorded after + settled: COMPLETED / OBSERVED / OBSERVED_SEQUENCE",
    a.decisionState === "ACCEPT" && a.actionState === "COMPLETED" && a.outcomeState === "OBSERVED" && a.attribution === "OBSERVED_SEQUENCE", a);
  ok("… and its uncertainty says SEQUENCE_NOT_CAUSE", a.uncertainty === "SEQUENCE_NOT_CAUSE");
  ok("the action event links the REAL domain record and the accepting decision",
    res.tracked.actions.some((x) => x.eventType === "PERFORMED" && x.domainStore === "PaymentAllocation" && x.domainRecordId === 501 && x.decisionId === acc.id));
  ok("the settlement observation carries days late, not money", res.tracked.observations.some((o) => o.kind === "INSTALLMENT_SETTLED" && o.unit === "days" && o.valueInt === 13));

  /* ── Case 2: accepted + no action ── */
  a = pipeline(at(40), [rA], [acc], truth({ installments: new Map([[7, installment(7, [])]]) })).assessments[0];
  ok("ACCEPT + nothing done: NOT_STARTED, window closed, NOT_ASSESSABLE / NO_ACTION",
    a.actionState === "NOT_STARTED" && a.outcomeState === "NOT_OBSERVED" && a.attribution === "NOT_ASSESSABLE" && a.uncertainty === "NO_ACTION");

  /* ── Case 3: rejected, and the owner paid anyway ── */
  a = pipeline(at(40), [rA], [decision(10, "REJECT", 1)], truth({ installments: new Map([[7, installment(7, [alloc(502, 5, 5)])]]) })).assessments[0];
  ok("REJECT is preserved as the decision even when the act happened anyway (rejection ≠ wrong; action ≠ acceptance)",
    a.decisionState === "REJECT" && a.actionState === "COMPLETED");

  /* ── Case 4: modified ── */
  const cQueue = cDocs[0];
  const rQ = stored(cQueue, { id: 20 });
  const mod = decision(20, "MODIFY", 1, { modification: { targets: [1, 2] } });
  const docTruth = (reviewed: number[], end: number) => truth({
    documents: new Map([1, 2, 3].map((id) => [id, { documentId: id, status: reviewed.includes(id) ? "approved" : "needs_review",
      firstReview: reviewed.includes(id) ? { id: 900 + id, occurredAt: at(2 + id), reviewerUserId: 5 } : null }])),
    backlogAtWindowEnd: new Map([[20, end]]),
  });
  a = pipeline(at(20), [rQ], [mod], docTruth([1, 2], 1)).assessments[0];
  ok("MODIFY narrows the targets: both kept targets reviewed → COMPLETED (the dropped one is not held against it)",
    a.decisionState === "MODIFY" && a.actionState === "COMPLETED" && a.detail.consideredTargets === 2);
  ok("… backlog 3 → 1 observed after the reviews: DECREASED, OBSERVED_SEQUENCE", a.direction === "DECREASED" && a.attribution === "OBSERVED_SEQUENCE");

  /* ── Conflicting evidence: the act happened, the backlog grew anyway ── */
  a = pipeline(at(20), [rQ], [], docTruth([1, 2, 3], 9)).assessments[0];
  ok("CONFLICTING EVIDENCE: all reviewed but the backlog INCREASED → NO_OUTCOME_OBSERVED, never a success",
    a.actionState === "COMPLETED" && a.direction === "INCREASED" && a.attribution === "NO_OUTCOME_OBSERVED");
  ok("… and with no decision recorded, the decision state is NONE (silence is not acceptance)", a.decisionState === "NONE");

  /* ── Case 5: action failed (payment voided) ── */
  res = pipeline(at(40), [rA], [acc], truth({ installments: new Map([[7, installment(7, [alloc(503, 3, 3, 1000, { voidedDay: 6 })])]]) }));
  a = res.assessments[0];
  ok("a VOIDED payment: PERFORMED and REVERSED are two events; the action is REVERSED and NOT_ASSESSABLE",
    res.tracked.actions.filter((x) => x.domainRecordId === 503).map((x) => x.eventType).sort().join() === "PERFORMED,REVERSED" &&
    a.actionState === "REVERSED" && a.attribution === "NOT_ASSESSABLE" && a.uncertainty === "EVIDENCE_REVERSED");

  /* ── Case 6: outcome pending ── */
  a = pipeline(at(5), [rA], [acc], truth({ installments: new Map([[7, installment(7, [])]]) })).assessments[0];
  ok("PENDING: the window is open → NOT_ASSESSABLE / WINDOW_OPEN", a.outcomeState === "PENDING" && a.uncertainty === "WINDOW_OPEN");

  /* ── Case 7: reversed outcome — settled, then the allocation reversed ── */
  const settledRun = pipeline(at(10), [rA], [acc], truth({ installments: new Map([[7, installment(7, [alloc(504, 3, 3)])]]) }));
  const settledObs = settledRun.tracked.observations.find((o) => o.kind === "INSTALLMENT_SETTLED")!;
  const existing = [{ ...settledObs, recommendationId: 10 }];
  res = pipeline(at(40), [rA], [acc], truth({ installments: new Map([[7, installment(7, [alloc(504, 3, 3, 1000, { reversedDay: 12 })])]]) }), existing);
  a = res.assessments[0];
  const reversal = res.tracked.observations.find((o) => o.kind === "INSTALLMENT_SETTLEMENT_REVERSED");
  ok("REVERSED OUTCOME: a NEW observation names the settlement it reverses (history is not rewritten)",
    reversal?.reversesKey === settledObs.idempotencyKey);
  ok("… and the assessment no longer treats it as observed", a.outcomeState === "REVERSED" && a.attribution !== "OBSERVED_SEQUENCE");
  const rebuilt = pipeline(at(40), [rA], [acc], truth({ installments: new Map([[7, installment(7, [alloc(504, 3, 3, 1000, { reversedDay: 12 })])]]) }), []);
  ok("REBUILD from nothing replays the same settlement AND its reversal (history lives in the ledger, not in memory)",
    rebuilt.tracked.observations.map((o) => o.idempotencyKey).sort().join() === res.tracked.observations.map((o) => o.idempotencyKey).sort().join() &&
    rebuilt.assessments[0].semanticHash === a.semanticHash);

  /* ── Case 8: late event — payment made BEFORE the recommendation, recorded after ── */
  a = pipeline(at(40), [rA], [acc], truth({ installments: new Map([[7, installment(7, [alloc(505, 3, -2)])]]) })).assessments[0];
  ok("LATE EVENT: paid before the recommendation (recorded after) → PRECEDED_RECOMMENDATION, NOT_ASSESSABLE",
    a.actionState === "PRECEDED_RECOMMENDATION" && a.attribution === "NOT_ASSESSABLE");

  /* ── Case 9: duplicate events / replays are idempotent ── */
  const t9 = truth({ installments: new Map([[7, installment(7, [alloc(506, 3, 3)])]]) });
  const once = trackOutcomes({ asOf: at(40), recommendations: [rA], decisions: [acc], truth: t9, existingObservations: [] });
  const twice = trackOutcomes({ asOf: at(41), recommendations: [rA], decisions: [acc], truth: t9, existingObservations: [] });
  ok("DUPLICATE: re-tracking the same ledger yields the same idempotency keys",
    once.actions.map((x) => x.idempotencyKey).join() === twice.actions.map((x) => x.idempotencyKey).join() &&
    once.observations.map((x) => x.idempotencyKey).join() === twice.observations.map((x) => x.idempotencyKey).join());
  ok("DETERMINISTIC: the same inputs give the same assessment hash",
    assessRecommendation({ asOf: at(40), rec: rA, decisions: [acc], actions: once.actions, observations: once.observations }).semanticHash ===
    assessRecommendation({ asOf: at(40), rec: rA, decisions: [acc], actions: twice.actions, observations: twice.observations }).semanticHash);

  /* ── Withdrawn targets ── */
  a = pipeline(at(40), [rA], [], truth({ installments: new Map([[7, installment(7, [], "CANCELLED")]]) })).assessments[0];
  ok("a cancelled installment WITHDRAWS the target: CANCELLED / TARGETS_WITHDRAWN", a.actionState === "CANCELLED" && a.uncertainty === "TARGETS_WITHDRAWN");

  /* ── The attribution vocabulary IS the causal boundary ── */
  ok("the attribution vocabulary has no causal or contribution value",
    ATTRIBUTIONS.join() === "NOT_ASSESSABLE,NO_OUTCOME_OBSERVED,OBSERVED_SEQUENCE" && !ATTRIBUTIONS.some((x) => /CAUS|CONTRIBUT|EFFECT|PROVEN/.test(x)));

  /* ── Learning: thresholds, behaviour only, gaps ── */
  const row = (id: number, dec: string | null, over: Partial<OutcomeLearningRow> = {}): OutcomeLearningRow => ({
    id, recommendationKey: `SETTLE_OVERDUE_INSTALLMENT:installment:${id}`, version: 1, type: "SETTLE_OVERDUE_INSTALLMENT", family: "payables",
    subjectType: "installment", subjectId: id, targetCount: 1, status: "RESOLVED", issuedAt: at(0), closedAt: at(10),
    decisions: dec ? [{ id: id * 10, decision: dec, decidedAt: at(2) }] : [],
    assessment: { id: id * 100, decisionState: dec ?? "NONE", actionState: "COMPLETED", outcomeState: "OBSERVED", direction: "SETTLED",
      attribution: "OBSERVED_SEQUENCE", uncertainty: "SEQUENCE_NOT_CAUSE", detail: { daysToFirstAction: 3 } },
    ...over,
  });
  let learned = learnFromOutcomes(at(20), [row(1, "ACCEPT"), row(2, "REJECT"), row(3, null)]);
  ok("INSUFFICIENT EVIDENCE: below 5 decisions there is no pattern, only a gap with have/need",
    !learned.items.some((i) => i.kind === "DECISION_PATTERN") &&
    learned.gaps.some((g) => g.key === "outcomes.decision_pattern.SETTLE_OVERDUE_INSTALLMENT" && g.have === 2 && g.need === 5));
  ok("the causal question is a standing RULE_BLOCKED gap", learned.gaps.some((g) => g.slot === "gap|outcomes|CAUSAL_ATTRIBUTION" && g.reason === "NO_COMPARISON_DESIGN"));
  ok("memory keeps an unanswered recommendation as NONE, and flags an act without a recorded decision",
    learned.items.some((i) => i.kind === "RECOMMENDATION_MEMORY" && i.value.ownerDecision === "NONE" && i.caveats.includes("ACTION_WITHOUT_RECORDED_DECISION")));
  ok("an OBSERVED_SEQUENCE memory carries the SEQUENCE_IS_NOT_CAUSE caveat",
    learned.items.filter((i) => i.value.systemAttribution === "OBSERVED_SEQUENCE").every((i) => i.caveats.includes("SEQUENCE_IS_NOT_CAUSE")));
  learned = learnFromOutcomes(at(20), [1, 2, 3, 4, 5, 6].map((i) => row(i, i <= 4 ? "ACCEPT" : "REJECT")).concat([row(7, null, { status: "EXPIRED" })]));
  const dp = learned.items.find((i) => i.kind === "DECISION_PATTERN");
  ok("OWNER BEHAVIOUR: at 6 decisions a pattern exists — counts and timing only",
    dp?.value.accepted === 4 && dp?.value.rejected === 2 && dp?.value.expiredUnanswered === 1 && dp.value.medianDaysToDecision === 2);
  ok("… silence is its own column, never folded into rejected", dp?.value.rejected === 2);
  ok("… and nothing in it names a trait, a motive or an intent",
    !Object.keys(dp?.value ?? {}).some((k) => /risk|trait|personality|motive|intent|toleran|prefer/i.test(k)) && dp!.caveats.includes("BEHAVIOUR_ONLY_NOT_INTENT"));
  const op = learned.items.find((i) => i.kind === "OUTCOME_PATTERN");
  ok("OUTCOME PATTERN counts sequences and is caveated as not causal", op?.value.observedSequence === 7 && op.caveats.includes("SEQUENCE_IS_NOT_CAUSE"));
  ok("every learned item is OUTCOME_ASSESSMENT authority, never OWNER_CONFIRMED or domain state",
    learned.items.every((i) => i.authority === "OUTCOME_ASSESSMENT"));

  /* ── Feedback into the Brain context: scalars only, sequence semantics carried ── */
  const memItem = { ...learned.items.find((i) => i.kind === "RECOMMENDATION_MEMORY")!, conflictIds: [] } as KnowledgeItem;
  const s2 = snap([memItem, { ...dp!, conflictIds: [] } as KnowledgeItem]);
  const built = buildBrainContext(s2);
  const k1 = built.context.knowledge.find((k) => k.kind === "RECOMMENDATION_MEMORY");
  ok("the Brain context admits RECOMMENDATION_MEMORY with authority-named scalar fields",
    k1 != null && k1.facts.ownerDecision != null && k1.facts.systemAttribution === "OBSERVED_SEQUENCE" && k1.caveats.includes("SEQUENCE_IS_NOT_CAUSE"));
  ok("… with no ids beyond aliases and no nested objects", Object.values(k1!.facts).every((v) => v === null || typeof v !== "object") && k1!.subject?.startsWith("S"));
  ok("the system prompt states rule 11 (sequence, never effect; behaviour, never motive)",
    /RECOMMENDATION_MEMORY/.test(BRAIN_SYSTEM_PROMPT) && /sequence only/.test(BRAIN_SYSTEM_PROMPT) && /never personality, motive or intent/.test(BRAIN_SYSTEM_PROMPT));

  /* ── Post-action observation phrased as causation is rejected by the M8 validator ── */
  const answer = (observation: string) => JSON.stringify({ contextFingerprint: built.fingerprint, outcome: "FINDINGS", findings: [{
    findingId: "f1", type: "ATTENTION", priority: "LOW", knowledgeRefs: [k1!.ref], findingRefs: [], conflictRefs: [], gapRefs: [],
    observation, interpretation: null, hypothesis: null, causalClaim: false, uncertainty: "SUPPORTED" }] });
  for (const phrase of ["התשלום בוצע בזכות ההמלצה.", "ההמלצה שיפרה את קצב התשלום.", "The reminder improved payment.", "Paying thanks to the suggestion worked."]) {
    const v = validateBrainOutput(answer(phrase), built.fingerprint, built.context, built.aliases, s2);
    ok(`CAUSAL WORDING rejected: "${phrase}"`, v.accepted.length === 0 && v.rejected.some((r) => r.code === "CAUSAL_WORDING"), v.rejected);
  }
  const neutral = validateBrainOutput(answer("לאחר ההמלצה נרשם תשלום."), built.fingerprint, built.context, built.aliases, s2);
  ok("a SEQUENCE sentence ('after the recommendation, a payment was recorded') is accepted", neutral.accepted.length === 1, neutral.rejected);

  /* ── Static: purity and no-AI in the engine; no cross-business aggregation ── */
  const root = join(__dirname);
  const files = readdirSync(root).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const pure = files.filter((f) => f !== "outcome-store.ts" && f !== "outcome.service.ts");
  ok("the engine (contract, recommend, track, assess, learn) never opens a query",
    pure.every((f) => !/tenantTx|@\/lib\/prisma|\btx\./.test(readFileSync(join(root, f), "utf8"))), pure);
  ok("no M9 file calls a model provider",
    files.every((f) => !/openai|OpenAI|brainProvider|\.complete\(/.test(readFileSync(join(root, f), "utf8"))));
  const store = readFileSync(join(root, "outcome-store.ts"), "utf8");
  const wheres = store.match(/where: \{[^}]{0,60}/g) ?? [];
  ok("every store where-clause carries the caller's businessId (no cross-business read or write)",
    wheres.length >= 15 && wheres.every((w) => /\bbusinessId\b/.test(w)), wheres.filter((w) => !/\bbusinessId\b/.test(w)));
  ok("every raw query in the store binds the businessId", (store.match(/\$queryRawUnsafe/g) ?? []).length === (store.match(/"businessId" = \$1/g) ?? []).length - 2);
  ok("the store never deletes", !/\.delete(Many)?\(/.test(store));
  const appRoot = join(__dirname, "..", "..", "..");
  const walk = (d: string, out: string[] = []): string[] => {
    for (const n of readdirSync(d)) {
      if (n === "node_modules" || n.startsWith(".")) continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p, out); else if (/\.tsx?$/.test(n)) out.push(p);
    }
    return out;
  };
  // Closed Loop: the owner sees recommendations ONLY through the feature-gated owner-surface API, called from
  // ONE client module. No UI file imports M9 itself, touches its tables, or names the API elsewhere.
  const uiFiles = [...walk(join(appRoot, "components")), ...walk(join(appRoot, "features")), ...walk(join(appRoot, "app"))]
    .filter((f) => !relative(appRoot, f).split(/[\\/]/).includes("api"));
  const uiM9 = uiFiles.filter((f) => /lib\/knowledge\/outcomes|outcomeRecommendation|OutcomeRecommendation/.test(readFileSync(f, "utf8")));
  ok("OWNER-VISIBLE: no UI file imports M9 or touches its tables", uiM9.length === 0, uiM9.map((f) => relative(appRoot, f)));
  const uiApi = uiFiles.filter((f) => /\/api\/outcomes\/recommendations/.test(readFileSync(f, "utf8"))).map((f) => relative(appRoot, f).replace(/\\/g, "/"));
  ok("OWNER-VISIBLE: only the recommendations client calls the owner-surface API",
    uiApi.length === 1 && uiApi[0] === "features/recommendations/recommendations-client.ts", uiApi);

  if (failed > 0) { console.error(`\nM9 outcome learning: ${failed} FAILED`); process.exit(1); }
  console.log("\nM9 outcome learning: separated, sequence-only, evidence-backed. ✔");
}

main().catch((e) => { console.error(e); process.exit(1); });
