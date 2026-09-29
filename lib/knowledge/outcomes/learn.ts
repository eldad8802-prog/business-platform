/**
 * M9 · Outcome learning → governed snapshot knowledge. PURE.
 *
 * The Brain never sees raw outcome history. It sees three compact kinds, each of which names the
 * authority of every field it carries:
 *
 *   RECOMMENDATION_MEMORY  one per recommendation identity (latest version, last 90 days):
 *                          lifecycle, ownerDecision, ledgerAction, observedOutcome, systemAttribution.
 *                          This is what stops amnesia: "already raised / rejected / accepted / done /
 *                          still pending / stale" is knowledge, not something a model must remember.
 *   DECISION_PATTERN       per recommendation type, once MIN_PATTERN_SUPPORT decisions exist: how often
 *                          the owner accepted / rejected / narrowed / deferred / left unanswered, and how
 *                          quickly they answered. Behaviour only — never motive, risk appetite or trait.
 *   OUTCOME_PATTERN        per recommendation type, once MIN_PATTERN_SUPPORT windows have closed: how
 *                          often an act followed and an outcome was observed after it. A SEQUENCE count,
 *                          caveated as such; never a success rate of the recommendation.
 *
 * Below the threshold the answer is a GAP (INSUFFICIENT_EVIDENCE), and the causal question is always a
 * standing gap (RULE_BLOCKED / NO_COMPARISON_DESIGN), so the model is told what it cannot conclude.
 */
import type { AuthorityClass, Freshness, KnowledgeItem, ProvenanceRef } from "../snapshot/snapshot.contract";
import { ASSESSOR_VERSION, GENERATOR_VERSION, MEMORY_LOOKBACK_DAYS, MIN_PATTERN_SUPPORT, RECOMMENDATION_TYPES, type RecommendationType } from "./outcome.contract";

const DAY = 86_400_000;
const MEMORY_FRESH_DAYS = 45;
const PATTERN_FRESH_DAYS = 180;
const ageDays = (asOf: Date, t: Date) => Math.max(0, Math.floor((asOf.getTime() - t.getTime()) / DAY));

export type OutcomeLearningRow = {
  readonly id: number;
  readonly recommendationKey: string;
  readonly version: number;
  readonly type: string;
  readonly family: string;
  readonly subjectType: string;
  readonly subjectId: number;
  readonly targetCount: number;
  readonly status: string;
  readonly issuedAt: Date;
  readonly closedAt: Date | null;
  readonly decisions: readonly { readonly id: number; readonly decision: string; readonly decidedAt: Date }[];
  readonly assessment: {
    readonly id: number;
    readonly decisionState: string;
    readonly actionState: string;
    readonly outcomeState: string;
    readonly direction: string;
    readonly attribution: string;
    readonly uncertainty: string;
    readonly detail: unknown;
  } | null;
};

export type LearningDraft = Omit<KnowledgeItem, "conflictIds">;
export type LearningGap = {
  slot: string; domain: string; key: string; ruleId: string | null;
  kind: "INSUFFICIENT_EVIDENCE" | "RULE_BLOCKED"; reason: string; have: number | null; need: number | null; needSpanDays: number | null;
};

const AUTHORITY: AuthorityClass = "OUTCOME_ASSESSMENT";

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function latestDecision(r: OutcomeLearningRow) {
  return [...r.decisions].sort((a, b) => a.decidedAt.getTime() - b.decidedAt.getTime() || a.id - b.id).at(-1) ?? null;
}

export function learnFromOutcomes(asOf: Date, rows: readonly OutcomeLearningRow[]): { items: LearningDraft[]; gaps: LearningGap[] } {
  const items: LearningDraft[] = [];
  const gaps: LearningGap[] = [];
  if (rows.length === 0) return { items, gaps };

  /* ── memory: latest version per identity, recent or still live ── */
  const latest = new Map<string, OutcomeLearningRow>();
  for (const r of rows) {
    const cur = latest.get(r.recommendationKey);
    if (!cur || r.version > cur.version) latest.set(r.recommendationKey, r);
  }
  for (const r of [...latest.values()].sort((a, b) => a.recommendationKey.localeCompare(b.recommendationKey))) {
    const last = r.closedAt ?? r.issuedAt;
    if (r.status !== "ACTIVE" && ageDays(asOf, last) > MEMORY_LOOKBACK_DAYS) continue;
    const d = latestDecision(r);
    const a = r.assessment;
    const age = ageDays(asOf, last);
    const freshness: Freshness = { ageDays: age, fresh: age <= MEMORY_FRESH_DAYS };
    const caveats: string[] = [];
    if (a?.attribution === "OBSERVED_SEQUENCE") caveats.push("SEQUENCE_IS_NOT_CAUSE");
    if (!d && a && ["COMPLETED", "PARTIALLY_COMPLETED"].includes(a.actionState)) caveats.push("ACTION_WITHOUT_RECORDED_DECISION");
    const provenance: ProvenanceRef[] = [{ store: "OutcomeRecommendation", id: r.id }];
    if (a) provenance.push({ store: "OutcomeAssessment", id: a.id });
    items.push({
      slot: `outcome|memory|${r.recommendationKey}`, kind: "RECOMMENDATION_MEMORY", domain: r.family,
      subject: { type: r.subjectType, id: r.subjectId }, key: r.type, ruleId: GENERATOR_VERSION, ruleVersion: ASSESSOR_VERSION,
      authority: AUTHORITY,
      value: {
        recommendationType: r.type, version: r.version, lifecycle: r.status, targets: r.targetCount,
        daysSinceIssued: ageDays(asOf, r.issuedAt),
        ownerDecision: d?.decision ?? "NONE",
        ledgerAction: a?.actionState ?? "NOT_ASSESSED",
        observedOutcome: a?.outcomeState ?? "NOT_ASSESSED",
        direction: a?.direction ?? "NOT_MEASURABLE",
        systemAttribution: a?.attribution ?? "NOT_ASSESSABLE",
        uncertainty: a?.uncertainty ?? "WINDOW_OPEN",
      },
      observationCount: null, window: null, status: "ACTIVE", freshness,
      evidence: { fingerprint: null, refCount: null }, caveats, provenance,
    });
  }

  /* ── patterns per type, over every version ── */
  const types = [...new Set(rows.map((r) => r.type))].sort();
  for (const type of types) {
    const ofType = rows.filter((r) => r.type === type);
    const family = RECOMMENDATION_TYPES[type as RecommendationType]?.family ?? "outcomes";
    const latestInput = ofType.map((r) => r.closedAt ?? r.issuedAt).sort((a, b) => b.getTime() - a.getTime())[0];
    const pAge = ageDays(asOf, latestInput);
    const freshness: Freshness = { ageDays: pAge, fresh: pAge <= PATTERN_FRESH_DAYS };

    // Owner behaviour: versions the owner answered, plus those that expired unanswered (silence counted
    // as silence — its own column, never folded into "rejected").
    const decided = ofType.map((r) => ({ r, d: latestDecision(r) })).filter((x) => x.d != null);
    const unanswered = ofType.filter((r) => r.decisions.length === 0 && r.status === "EXPIRED").length;
    const key = `outcomes.decision_pattern.${type}`;
    if (decided.length >= MIN_PATTERN_SUPPORT) {
      const count = (k: string) => decided.filter((x) => x.d!.decision === k).length;
      items.push({
        slot: `outcome|decision_pattern|${type}`, kind: "DECISION_PATTERN", domain: family, subject: null, key,
        ruleId: ASSESSOR_VERSION, ruleVersion: ASSESSOR_VERSION, authority: AUTHORITY,
        value: {
          recommendationType: type, decided: decided.length, accepted: count("ACCEPT"), rejected: count("REJECT"),
          modified: count("MODIFY"), deferred: count("NOT_NOW"), expiredUnanswered: unanswered,
          medianDaysToDecision: median(decided.map((x) => Math.max(0, Math.floor((x.d!.decidedAt.getTime() - x.r.issuedAt.getTime()) / DAY)))),
        },
        observationCount: decided.length, window: null, status: "ACTIVE", freshness,
        evidence: { fingerprint: null, refCount: decided.length }, caveats: ["BEHAVIOUR_ONLY_NOT_INTENT"],
        provenance: decided.map((x) => ({ store: "OutcomeRecommendation" as const, id: x.r.id })).sort((a, b) => Number(a.id) - Number(b.id)),
      });
    } else {
      gaps.push({ slot: `gap|${key}|INSUFFICIENT_EVIDENCE`, domain: family, key, ruleId: ASSESSOR_VERSION,
        kind: "INSUFFICIENT_EVIDENCE", reason: "BELOW_MINIMUM_SUPPORT", have: decided.length, need: MIN_PATTERN_SUPPORT, needSpanDays: null });
    }

    // Outcomes: only versions whose window has closed (an open window is not evidence of anything).
    const closed = ofType.filter((r) => r.assessment && r.assessment.outcomeState !== "PENDING");
    const okey = `outcomes.outcome_pattern.${type}`;
    if (closed.length >= MIN_PATTERN_SUPPORT) {
      const by = (f: (a: NonNullable<OutcomeLearningRow["assessment"]>) => boolean) => closed.filter((r) => f(r.assessment!)).length;
      const toAct = closed.map((r) => (r.assessment!.detail as { daysToFirstAction?: number | null })?.daysToFirstAction)
        .filter((x): x is number => typeof x === "number");
      items.push({
        slot: `outcome|outcome_pattern|${type}`, kind: "OUTCOME_PATTERN", domain: family, subject: null, key: okey,
        ruleId: ASSESSOR_VERSION, ruleVersion: ASSESSOR_VERSION, authority: AUTHORITY,
        value: {
          recommendationType: type, windowsClosed: closed.length,
          actionCompleted: by((a) => a.actionState === "COMPLETED"),
          actionPartial: by((a) => a.actionState === "PARTIALLY_COMPLETED"),
          actionNotStarted: by((a) => a.actionState === "NOT_STARTED"),
          observedSequence: by((a) => a.attribution === "OBSERVED_SEQUENCE"),
          noOutcomeObserved: by((a) => a.attribution === "NO_OUTCOME_OBSERVED"),
          notAssessable: by((a) => a.attribution === "NOT_ASSESSABLE"),
          medianDaysToFirstAction: median(toAct),
        },
        observationCount: closed.length, window: null, status: "ACTIVE", freshness,
        evidence: { fingerprint: null, refCount: closed.length }, caveats: ["SEQUENCE_IS_NOT_CAUSE"],
        provenance: closed.map((r) => ({ store: "OutcomeAssessment" as const, id: r.assessment!.id })).sort((a, b) => Number(a.id) - Number(b.id)),
      });
    } else {
      gaps.push({ slot: `gap|${okey}|INSUFFICIENT_EVIDENCE`, domain: family, key: okey, ruleId: ASSESSOR_VERSION,
        kind: "INSUFFICIENT_EVIDENCE", reason: "BELOW_MINIMUM_SUPPORT", have: closed.length, need: MIN_PATTERN_SUPPORT, needSpanDays: null });
    }
  }

  // What can never be concluded from this data, stated rather than left to inference.
  gaps.push({ slot: "gap|outcomes|CAUSAL_ATTRIBUTION", domain: "outcomes", key: "outcomes.causal_attribution", ruleId: ASSESSOR_VERSION,
    kind: "RULE_BLOCKED", reason: "NO_COMPARISON_DESIGN", have: null, need: null, needSpanDays: null });
  return { items, gaps };
}
