/**
 * M9 · Outcome derivation for ONE business — recommend, track, assess. Deterministic; no model call.
 *
 *   1. candidates from the governed snapshot (+ the review queue), linked to a validated M8 finding
 *      when one cites the same knowledge
 *   2. the recommendation plan: issue / supersede / resolve / expire / suppress (memory, not wording)
 *   3. action events and observations read from the domain ledger (append-only, idempotent)
 *   4. one assessment per recommendation version (append + supersede; unchanged → confirmed)
 *
 * NOT OWNER-VISIBLE. Nothing here renders, notifies or sends. `OUTCOMES_MODE=off` stops it entirely.
 * It never throws into its caller: a failure is reported with the stage it happened in, and the rest
 * of the derivation — and the product — is untouched.
 *
 * The report is counts, states and codes only: no ids beyond the caller's businessId, no values.
 */
import type { BusinessKnowledgeSnapshot } from "../snapshot/snapshot.contract";
import type { ValidatedBrainResult } from "../brain/brain.contract";
import { ASSESSOR_VERSION, GENERATOR_VERSION, OUTCOME_CONTRACT_VERSION } from "./outcome.contract";
import { deriveCandidates, effectiveDecision, planRecommendations, type BrainLink } from "./recommend";
import { trackOutcomes } from "./track";
import { assessRecommendation } from "./assess";
import { loadDomainTruth, loadOutcomeState, writeRecommendationPlan, writeTracking } from "./outcome-store";

export function outcomesMode(): "off" | "on" {
  return process.env.OUTCOMES_MODE === "off" ? "off" : "on";
}

const tally = <T,>(xs: readonly T[], f: (x: T) => string) =>
  xs.reduce<Record<string, number>>((acc, x) => { const k = f(x); acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});

export type OutcomeReport = {
  mode: "off" | "on";
  versions: { contract: string; generator: string; assessor: string };
  recommendations?: { candidates: number; issued: number; closed: Record<string, number>; suppressed: Record<string, number>; sourceKinds: Record<string, number>; active: number };
  decisions?: Record<string, number>;
  tracking?: { actionsInserted: number; actionsByType: Record<string, number>; observationsInserted: number; observationsByKind: Record<string, number> };
  assessments?: { written: number; confirmed: number; superseded: number; byAttribution: Record<string, number>; byOutcomeState: Record<string, number>; byActionState: Record<string, number>; pending: number };
  durationMs: number;
  failureStage: "tenant_mismatch" | "load" | "plan" | "write_plan" | "track" | "write_tracking" | null;
};

export async function deriveOutcomesForBusiness(
  businessId: number,
  opts: { asOf: Date; snapshot: BusinessKnowledgeSnapshot; brain?: ValidatedBrainResult | null },
): Promise<OutcomeReport> {
  const started = Date.now();
  const versions = { contract: OUTCOME_CONTRACT_VERSION, generator: GENERATOR_VERSION, assessor: ASSESSOR_VERSION };
  if (outcomesMode() === "off") return { mode: "off", versions, durationMs: 0, failureStage: null };
  // One call is one business: knowledge built for another business is refused before any read or write.
  if (opts.snapshot.businessId !== businessId) return { mode: "on", versions, durationMs: 0, failureStage: "tenant_mismatch" };
  const { asOf } = opts;
  let stage: OutcomeReport["failureStage"] = "load";
  const report: OutcomeReport = { mode: "on", versions, durationMs: 0, failureStage: null };
  try {
    const before = await loadOutcomeState(businessId, asOf);

    stage = "plan";
    const brain: BrainLink = opts.brain && opts.brain.businessId === businessId && opts.brain.findings.length > 0
      ? { findings: opts.brain.findings, meta: {
          contractVersion: opts.brain.meta.contractVersion, promptVersion: opts.brain.meta.promptVersion,
          contextVersion: opts.brain.meta.contextVersion, model: opts.brain.meta.model, contextFingerprint: opts.brain.meta.contextFingerprint } }
      : null;
    const candidates = deriveCandidates(opts.snapshot, { pendingDocumentIds: before.pendingDocumentIds });
    const plan = planRecommendations({ asOf, candidates, stored: before.recommendations, decisions: before.decisions, brain });

    stage = "write_plan";
    const written = await writeRecommendationPlan(businessId, asOf, plan, { snapshotFingerprint: opts.snapshot.snapshotFingerprint });

    stage = "track";
    const state = await loadOutcomeState(businessId, asOf);
    const truth = await loadDomainTruth(businessId, asOf, state.recommendations);
    const tracked = trackOutcomes({ asOf, recommendations: state.recommendations, decisions: state.decisions, truth, existingObservations: state.observations });
    const actions = [...new Map([...state.actions, ...tracked.actions].map((a) => [a.idempotencyKey, a])).values()];
    const observations = [...new Map([...state.observations, ...tracked.observations.map((o) => ({ ...o, reversesKey: o.reversesKey }))]
      .map((o) => [o.idempotencyKey, o])).values()];
    const assessments = state.recommendations
      .filter((r) => r.issuedAt.getTime() <= asOf.getTime())
      .map((rec) => assessRecommendation({ asOf, rec, decisions: state.decisions, actions, observations }));

    stage = "write_tracking";
    const w = await writeTracking(businessId, asOf, tracked.actions, tracked.observations, assessments, ASSESSOR_VERSION);

    report.recommendations = {
      candidates: candidates.length, issued: written.issued, closed: written.closed,
      suppressed: tally(plan.suppressed, (s) => s.reason), sourceKinds: tally(plan.issue, (d) => d.source.kind),
      active: state.recommendations.filter((r) => r.status === "ACTIVE").length,
    };
    report.decisions = tally(state.recommendations.map((r) => effectiveDecision(state.decisions, r.id)?.decision ?? "NONE"), (x) => x);
    report.tracking = {
      actionsInserted: w.actionsInserted, actionsByType: tally(tracked.actions, (a) => a.eventType),
      observationsInserted: w.observationsInserted, observationsByKind: tally(tracked.observations, (o) => o.kind),
    };
    report.assessments = {
      written: w.assessmentsWritten, confirmed: w.assessmentsConfirmed, superseded: w.assessmentsSuperseded,
      byAttribution: tally(assessments, (a) => a.attribution), byOutcomeState: tally(assessments, (a) => a.outcomeState),
      byActionState: tally(assessments, (a) => a.actionState),
      pending: assessments.filter((a) => a.outcomeState === "PENDING").length,
    };
    report.durationMs = Date.now() - started;
    return report;
  } catch (e) {
    // Operational code only; the error text can carry values and never leaves the server log.
    console.error("M9 outcome derivation failed", { stage, name: e instanceof Error ? e.name : "unknown" });
    return { ...report, durationMs: Date.now() - started, failureStage: stage };
  }
}
