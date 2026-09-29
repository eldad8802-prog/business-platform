/**
 * M9 · Outcome assessment — PURE and deterministic. What is SUPPORTABLE about one recommendation.
 *
 * The assessment keeps the four states apart and says which of them is known:
 *   decisionState   the owner's latest decision on this version — NONE when they never answered
 *   actionState     what the ledger shows was done to the (possibly owner-narrowed) targets
 *   outcomeState    what was observed inside the outcome window
 *   attribution     NOT_ASSESSABLE | NO_OUTCOME_OBSERVED | OBSERVED_SEQUENCE — and nothing stronger
 *
 * OBSERVED_SEQUENCE requires the act to have happened AFTER the recommendation and BEFORE the observed
 * outcome. It still means only "in that order": its uncertainty is always SEQUENCE_NOT_CAUSE, because
 * the backlog may have shrunk and the payment may have been made without any recommendation at all.
 */
import { createHash } from "node:crypto";
import {
  type ActionState,
  type Assessment,
  type Attribution,
  type DecisionState,
  type Direction,
  type OutcomeState,
  type StoredDecision,
  type StoredRecommendation,
  type Uncertainty,
} from "./outcome.contract";
import { effectiveDecision } from "./recommend";

const DAY = 86_400_000;

export type AssessAction = {
  readonly recommendationId: number;
  readonly eventType: "PERFORMED" | "REVERSED" | "WITHDRAWN";
  readonly targetId: number;
  readonly domainStore: string;
  readonly domainRecordId: number;
  readonly occurredAt: Date;
};

export type AssessObservation = {
  readonly recommendationId: number;
  readonly kind: string;
  readonly valueInt: number | null;
  readonly observedAt: Date;
  readonly idempotencyKey: string;
  readonly reversesKey: string | null;
  readonly evidenceStore: string;
  readonly evidenceIds: readonly number[];
};

function stable(v: unknown): string {
  if (v === null || v === undefined || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
}

const wholeDays = (from: Date, to: Date) => Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY));

export function assessRecommendation(input: {
  asOf: Date;
  rec: StoredRecommendation;
  decisions: readonly StoredDecision[];
  actions: readonly AssessAction[];
  observations: readonly AssessObservation[];
}): Assessment {
  const { asOf, rec } = input;
  const decision = effectiveDecision(input.decisions, rec.id);
  const decisionState: DecisionState = decision?.decision ?? "NONE";

  // The owner may narrow the recommendation. Only then are the targets fewer; silence narrows nothing.
  const considered = decision?.decision === "MODIFY" && decision.modification
    ? rec.targets.filter((t) => decision.modification!.targets.includes(t))
    : [...rec.targets];

  const mine = input.actions.filter((a) => a.recommendationId === rec.id && considered.includes(a.targetId));
  const withdrawn = new Set(mine.filter((a) => a.eventType === "WITHDRAWN").map((a) => a.targetId));
  const reversedRecords = new Set(mine.filter((a) => a.eventType === "REVERSED").map((a) => `${a.domainStore}:${a.domainRecordId}`));
  const performed = mine.filter((a) => a.eventType === "PERFORMED");
  const livePerformed = performed.filter((a) => !reversedRecords.has(`${a.domainStore}:${a.domainRecordId}`));
  const relevant = considered.filter((t) => !withdrawn.has(t) || livePerformed.some((a) => a.targetId === t));
  const doneTargets = new Set(livePerformed.map((a) => a.targetId));
  const firstAct = [...livePerformed].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())[0] ?? null;

  let actionState: ActionState;
  if (relevant.length === 0) actionState = "CANCELLED";
  else if (livePerformed.length > 0 && livePerformed.every((a) => a.occurredAt.getTime() < rec.issuedAt.getTime())) actionState = "PRECEDED_RECOMMENDATION";
  else if (doneTargets.size === 0) actionState = performed.length > 0 ? "REVERSED" : "NOT_STARTED";
  else if (relevant.every((t) => doneTargets.has(t))) actionState = "COMPLETED";
  else actionState = "PARTIALLY_COMPLETED";

  // Outcome, inside the window.
  const obs = input.observations.filter((o) => o.recommendationId === rec.id);
  const reversedObs = new Set(obs.filter((o) => o.reversesKey).map((o) => o.reversesKey!));
  const windowClosed = asOf.getTime() >= rec.outcomeWindowEnd.getTime();
  let outcomeState: OutcomeState = windowClosed ? "NOT_OBSERVED" : "PENDING";
  let direction: Direction = "NOT_MEASURABLE";
  let outcomeAt: Date | null = null;
  const detail: Record<string, number | string | null> = {
    targets: rec.targets.length, consideredTargets: considered.length, relevantTargets: relevant.length,
    performedTargets: doneTargets.size, withdrawnTargets: withdrawn.size,
    daysToFirstAction: firstAct && firstAct.occurredAt >= rec.issuedAt ? wholeDays(rec.issuedAt, firstAct.occurredAt) : null,
    daysToDecision: decision ? wholeDays(rec.issuedAt, decision.decidedAt) : null,
  };

  if (rec.type === "REVIEW_PENDING_DOCUMENTS") {
    const atIssue = obs.find((o) => o.kind === "REVIEW_BACKLOG_AT_ISSUE")?.valueInt ?? rec.targets.length;
    const atEnd = obs.find((o) => o.kind === "REVIEW_BACKLOG_AT_WINDOW_END");
    detail.backlogAtIssue = atIssue;
    detail.backlogAtWindowEnd = atEnd?.valueInt ?? null;
    if (atEnd && atEnd.valueInt != null) {
      outcomeState = "OBSERVED";
      outcomeAt = atEnd.observedAt;
      direction = atEnd.valueInt < atIssue ? "DECREASED" : atEnd.valueInt > atIssue ? "INCREASED" : "UNCHANGED";
    }
  } else {
    const settled = obs.filter((o) => o.kind === "INSTALLMENT_SETTLED" && o.observedAt.getTime() <= rec.outcomeWindowEnd.getTime())
      .sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
    const live = settled.filter((o) => !reversedObs.has(o.idempotencyKey));
    if (live.length > 0) {
      outcomeState = "OBSERVED"; direction = "SETTLED"; outcomeAt = live[0].observedAt;
      detail.daysLate = live[0].valueInt;
    } else if (settled.length > 0) {
      outcomeState = "REVERSED";
    }
  }

  let attribution: Attribution;
  let uncertainty: Uncertainty;
  if (actionState === "CANCELLED") { attribution = "NOT_ASSESSABLE"; uncertainty = "TARGETS_WITHDRAWN"; }
  else if (actionState === "PRECEDED_RECOMMENDATION") { attribution = "NOT_ASSESSABLE"; uncertainty = "ACTION_PRECEDED_RECOMMENDATION"; }
  else if (actionState === "REVERSED") { attribution = "NOT_ASSESSABLE"; uncertainty = "EVIDENCE_REVERSED"; }
  else if (actionState === "NOT_STARTED") { attribution = "NOT_ASSESSABLE"; uncertainty = outcomeState === "PENDING" ? "WINDOW_OPEN" : "NO_ACTION"; }
  else if (outcomeState === "PENDING") { attribution = "NOT_ASSESSABLE"; uncertainty = "WINDOW_OPEN"; }
  else if (outcomeState === "REVERSED") { attribution = "NO_OUTCOME_OBSERVED"; uncertainty = "EVIDENCE_REVERSED"; }
  else if (
    outcomeState === "OBSERVED" && (direction === "DECREASED" || direction === "SETTLED") &&
    firstAct != null && outcomeAt != null && firstAct.occurredAt.getTime() <= outcomeAt.getTime()
  ) { attribution = "OBSERVED_SEQUENCE"; uncertainty = "SEQUENCE_NOT_CAUSE"; }
  else { attribution = "NO_OUTCOME_OBSERVED"; uncertainty = "SEQUENCE_NOT_CAUSE"; }

  const evidenceRefs = [
    ...livePerformed.map((a) => ({ store: a.domainStore, id: a.domainRecordId })),
    ...obs.flatMap((o) => o.evidenceIds.map((id) => ({ store: o.evidenceStore, id }))),
  ].sort((a, b) => a.store.localeCompare(b.store) || a.id - b.id)
    .filter((r, i, xs) => i === 0 || r.store !== xs[i - 1].store || r.id !== xs[i - 1].id);

  const body = {
    recommendationId: rec.id, decisionState, actionState, outcomeState, direction, attribution, uncertainty,
    windowStart: rec.issuedAt, windowEnd: rec.outcomeWindowEnd, observationCount: obs.length, evidenceRefs, detail,
  };
  return { ...body, semanticHash: createHash("sha256").update(stable(body)).digest("hex") };
}
