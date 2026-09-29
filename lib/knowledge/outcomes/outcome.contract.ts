/**
 * M9 · The outcome-learning contract.
 *
 *   ValidatedFinding (M8, optional) ─┐
 *   governed knowledge (bks.v1) ─────┴→ Recommendation → OwnerDecision → Action → OutcomeObservation
 *                                        → OutcomeAssessment → learning artifacts → bks.v1 → Brain
 *
 * Each arrow is a different claim with a different author, and none of them is allowed to stand in for
 * another:
 *
 *   Recommendation ≠ Decision      the system suggested; only the owner decides
 *   Decision ≠ Action              accepting is not doing; doing is read from the domain ledger
 *   Action ≠ Outcome               a review or a payment is an act; what followed is observed separately
 *   Outcome ≠ Effect               "after X, Y was observed" is a SEQUENCE. No design in the product can
 *                                  establish that X caused Y, so no value in this contract says it did
 *   No response ≠ Rejection        silence is recorded as NONE, never as a decision
 *   Rejection ≠ Wrong              a rejection is the owner's authority about THIS business, not a verdict
 *                                  on the recommendation's truth; acceptance is not a verdict either
 *
 * Everything here is per business. There is no cross-business rate, baseline or ranking.
 */

export const OUTCOME_CONTRACT_VERSION = "outcomes.v1";
export const GENERATOR_VERSION = "rec-generator.v1";
export const ASSESSOR_VERSION = "outcome-assessor.v1";

/* ── Recommendation catalogue ─────────────────────────────────────────────────────────────── */

/**
 * The first two outcome families, chosen by the M9 audit for evidence quality:
 *   documents  a review is an immutable, human, transactional act (ReviewEvent) with no reversal path
 *   payables   a payment's `paidAt` is owner-entered business time; voids and allocation reversals are
 *              proper tombstones the ledger already records
 * Not chosen: collections (reminder→payment has no invoice link and refunds are not netted), inventory
 * (POS held-sale stock defect), leads (no lead→payment link), supplier POs (unreachable states).
 */
export const RECOMMENDATION_TYPES = {
  REVIEW_PENDING_DOCUMENTS: {
    family: "documents",
    actionKind: "DOCUMENT_REVIEWED",
    /** Minimum waiting documents before a backlog is worth a recommendation. */
    minTargets: 3,
    validityDays: 14,
    outcomeWindowDays: 14,
  },
  SETTLE_OVERDUE_INSTALLMENT: {
    family: "payables",
    actionKind: "PAYMENT_RECORDED",
    minTargets: 1,
    validityDays: 14,
    outcomeWindowDays: 30,
  },
} as const;
export type RecommendationType = keyof typeof RECOMMENDATION_TYPES;

export type RecommendationSource =
  | { kind: "KNOWLEDGE_RULE" }
  | { kind: "BRAIN_FINDING"; findingKey: string; contractVersion: string; promptVersion: string; contextVersion: string; model: string; contextFingerprint: string };

/** A candidate the generator derives from knowledge + the targets the domain currently shows. */
export type RecommendationCandidate = {
  readonly type: RecommendationType;
  readonly recommendationKey: string;
  readonly subject: { readonly type: string; readonly id: number };
  /** Sorted, unique domain ids the recommendation is about (documents, installments). */
  readonly targets: readonly number[];
  /** Snapshot slots that support it — every one must exist in the snapshot it was derived from. */
  readonly supportingSlots: readonly string[];
  readonly severity: string | null;
  readonly evidenceFingerprint: string;
};

export type StoredRecommendation = {
  readonly id: number;
  readonly recommendationKey: string;
  readonly version: number;
  readonly type: RecommendationType;
  readonly subjectType: string;
  readonly subjectId: number;
  readonly targets: readonly number[];
  readonly severity: string | null;
  readonly evidenceFingerprint: string;
  readonly issuedAt: Date;
  readonly validUntil: Date;
  readonly outcomeWindowEnd: Date;
  readonly status: "ACTIVE" | "SUPERSEDED" | "RESOLVED" | "EXPIRED";
  readonly closedAt: Date | null;
};

/* ── Owner decisions ──────────────────────────────────────────────────────────────────────── */

export type DecisionKind = "ACCEPT" | "REJECT" | "MODIFY" | "NOT_NOW";

/** Structured, owner-selected reasons. There is deliberately no free-text field. */
export const REASON_CODES = [
  "ALREADY_HANDLED",
  "NOT_RELEVANT",
  "WRONG_TIMING",
  "DISAGREE",
  "WILL_HANDLE_DIFFERENTLY",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/** MODIFY: the owner narrows the recommendation to a subset of its targets. */
export type Modification = { readonly targets: readonly number[] };

export type StoredDecision = {
  readonly id: number;
  readonly recommendationId: number;
  readonly recommendationVersion: number;
  readonly decision: DecisionKind;
  readonly modification: Modification | null;
  readonly deferUntil: Date | null;
  readonly decidedAt: Date;
  readonly supersedesDecisionId: number | null;
};

export const NOT_NOW_DEFAULT_DAYS = 7;
export const NOT_NOW_MAX_DAYS = 90;
/** After a recommendation expired unanswered, how long before the same situation may be raised again. */
export const EXPIRED_COOLDOWN_DAYS = 30;

/* ── Actions and observations (read from the domain ledger, never claimed) ───────────────── */

export type ActionEventType = "PERFORMED" | "REVERSED" | "WITHDRAWN";

export type ActionEventDraft = {
  readonly recommendationId: number;
  readonly decisionId: number | null;
  readonly actionKind: string;
  readonly eventType: ActionEventType;
  readonly targetType: string;
  readonly targetId: number;
  readonly domainStore: "ReviewEvent" | "PaymentAllocation" | "Document" | "Installment";
  readonly domainRecordId: number;
  readonly actorUserId: number | null;
  /** Business time of the act itself (review time; the payment's own `paidAt`). */
  readonly occurredAt: Date;
  readonly idempotencyKey: string;
};

export type ObservationKind =
  | "REVIEW_BACKLOG_AT_ISSUE"
  | "REVIEW_BACKLOG_AT_WINDOW_END"
  | "INSTALLMENT_SETTLED"
  | "INSTALLMENT_SETTLEMENT_REVERSED";

export type ObservationDraft = {
  readonly recommendationId: number;
  /** Idempotency key of the action event it follows, if any (resolved to an id by the writer). */
  readonly actionEventKey: string | null;
  readonly kind: ObservationKind;
  readonly targetType: string | null;
  readonly targetId: number | null;
  /** Days or counts only — never money. */
  readonly valueInt: number | null;
  readonly unit: "days" | "count" | null;
  readonly evidenceStore: string;
  readonly evidenceIds: readonly number[];
  readonly observedAt: Date;
  readonly reversesKey: string | null;
  readonly idempotencyKey: string;
};

/* ── Assessment ───────────────────────────────────────────────────────────────────────────── */

export type DecisionState = "NONE" | DecisionKind;
export type ActionState = "NOT_STARTED" | "PARTIALLY_COMPLETED" | "COMPLETED" | "REVERSED" | "CANCELLED" | "PRECEDED_RECOMMENDATION";
export type OutcomeState = "PENDING" | "OBSERVED" | "NOT_OBSERVED" | "REVERSED";
export type Direction = "DECREASED" | "UNCHANGED" | "INCREASED" | "SETTLED" | "NOT_MEASURABLE";

/**
 * THE ATTRIBUTION VOCABULARY. Exactly what the product can support, and no more:
 *   NOT_ASSESSABLE       the window is open, nothing was done, or the act came before the advice
 *   NO_OUTCOME_OBSERVED  something was done and the window closed without the outcome
 *   OBSERVED_SEQUENCE    something was done, then the outcome was observed — in that order
 * ASSOCIATED, SUPPORTED_CONTRIBUTION and anything causal would need a comparison design (a control,
 * a counterfactual) that does not exist. They are not in this type, and the database CHECK refuses them.
 */
export const ATTRIBUTIONS = ["NOT_ASSESSABLE", "NO_OUTCOME_OBSERVED", "OBSERVED_SEQUENCE"] as const;
export type Attribution = (typeof ATTRIBUTIONS)[number];

export type Uncertainty =
  | "WINDOW_OPEN"
  | "NO_ACTION"
  | "ACTION_PRECEDED_RECOMMENDATION"
  | "TARGETS_WITHDRAWN"
  | "EVIDENCE_REVERSED"
  | "SEQUENCE_NOT_CAUSE";

export type Assessment = {
  readonly recommendationId: number;
  readonly decisionState: DecisionState;
  readonly actionState: ActionState;
  readonly outcomeState: OutcomeState;
  readonly direction: Direction;
  readonly attribution: Attribution;
  readonly uncertainty: Uncertainty;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly observationCount: number;
  readonly evidenceRefs: readonly { readonly store: string; readonly id: number }[];
  /** Counts and durations only. */
  readonly detail: Record<string, number | string | null>;
  readonly semanticHash: string;
};

/* ── Learning thresholds ──────────────────────────────────────────────────────────────────── */

/** Owner-behaviour and outcome patterns need at least this many decided / closed recommendations. */
export const MIN_PATTERN_SUPPORT = 5;
/** How far back recommendation memory reaches into the snapshot. */
export const MEMORY_LOOKBACK_DAYS = 90;
