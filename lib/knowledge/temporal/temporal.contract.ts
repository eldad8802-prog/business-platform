/**
 * M6 · The temporal knowledge contract.
 *
 * WHAT THIS LAYER ANSWERS, AND ONLY FOR ONE BUSINESS AT A TIME
 *
 *   BASELINE          what has been normal for THIS business (or this entity of it)
 *   STABLE_PATTERN    that normal is consistent enough to be called a habit
 *   TREND             sustained directional movement across several periods (UP / DOWN / FLAT)
 *   MATERIAL_CHANGE   the recent window sits at a materially different level from the baseline
 *   ANOMALY           a specific recent observation is far outside this business's own baseline
 *   INSUFFICIENT_HISTORY  not enough of this business's own history yet — said explicitly, with why
 *
 * WHAT IT NEVER DOES
 *   - compare a business to any other business, cohort, average or prior. There is no code path that
 *     loads a second tenant's evidence: every series is built from one business's observations.
 *   - explain. A deviation is a deviation; "why" belongs to authoritative evidence, not to arithmetic.
 *   - use a model, an LLM or a confidence percentage. Every threshold here is a stated, deterministic
 *     rule with a reason next to it.
 *   - read the clock. Everything is computed AS OF an explicit instant, so a rebuild is exact.
 */
export type TemporalKnowledgeType =
  | "BASELINE"
  | "STABLE_PATTERN"
  | "TREND"
  | "MATERIAL_CHANGE"
  | "ANOMALY";

export type TemporalStatus = "ACTIVE" | "INSUFFICIENT_HISTORY" | "STALE" | "SUPERSEDED";

/**
 * How a series behaves, which decides which statistics are honest for it.
 *   duration  days between two moments (filing lag, lead time, lateness — may be negative)
 *   amount    money per occurrence
 *   cadence   days BETWEEN consecutive occurrences, plus "time since the last one"
 *   rate      a population of yes/no outcomes
 */
export type TemporalValueKind = "duration" | "amount" | "cadence" | "rate";

/** One observation in a numeric series. `recordId` is the evidence it came from. */
export type NumericPoint = {
  readonly at: Date;
  readonly value: number;
  readonly recordId: number;
  readonly evidenceKind: string;
};

/** One member of a yes/no population. */
export type RatePoint = {
  readonly at: Date;
  readonly hit: boolean;
  readonly recordId: number;
  readonly evidenceKind: string;
};

/**
 * Why a baseline is not available. The reason IS the knowledge: "4 of the 12 needed" and "only 40 days
 * of history, 90 required" are different situations and a consumer may say so.
 */
export type InsufficientReason = {
  readonly code: "TOO_FEW_OBSERVATIONS" | "TOO_SHORT_HISTORY" | "NO_OBSERVATIONS";
  readonly have: number;
  readonly need: number;
  readonly spanDays?: number;
  readonly needSpanDays?: number;
  /**
   * For a sparse CONTEXT slice: the broader baseline of the SAME business a consumer should use
   * instead (e.g. '' = this business overall). Never another business.
   */
  readonly fallbackContextKey?: string;
};

/**
 * The per-rule parameters. Every number here is a decision about THIS measure, stated once, and
 * documented in docs/learning/TEMPORAL_KNOWLEDGE.md. There is no global magic number.
 */
export type TemporalSpec = {
  readonly valueKind: TemporalValueKind;
  readonly unit: string;
  /** The established-history window, ending where the recent window starts. */
  readonly historyDays: number;
  /** The comparison window, ending at asOf. */
  readonly recentDays: number;
  /** Below this many history observations there is no baseline. */
  readonly minHistory: number;
  /** A baseline needs history spread over at least this many days (not one busy week). */
  readonly minSpanDays: number;
  /** A material change needs at least this many recent observations. */
  readonly minRecent: number;
  /**
   * The smallest difference that matters in this unit, below which nothing is called a change, trend
   * or anomaly however "significant" it looks: 1.5 days of filing lag, 10% of a vendor's charge. For
   * amounts this is RELATIVE to the baseline median; otherwise absolute.
   */
  readonly materialFloor: number;
  readonly materialFloorIsRelative?: boolean;
  /** Robust spread (IQR ÷ |median|, floored) at or below which history is called a STABLE_PATTERN. */
  readonly stableRelativeSpread: number;
  /** Trend: the full span is cut into this many equal periods… */
  readonly trendPeriods: number;
  /** …each of which must hold at least this many observations, or no trend is computed. */
  readonly minPerPeriod: number;
  /** A baseline with no observation in this many days is STALE: the subject may have gone quiet. */
  readonly staleAfterDays: number;
};

/** A robust summary of a numeric sample. No mean: outliers are real in this data. */
export type RobustSummary = {
  readonly n: number;
  readonly median: number;
  readonly q1: number;
  readonly q3: number;
  readonly iqr: number;
  readonly mad: number;
  readonly min: number;
  readonly max: number;
};

export type RateSummary = {
  readonly n: number;
  readonly hits: number;
  readonly proportion: number;
};

/** One assessed artifact, ready to persist. The engine produces these; the writer stores them. */
export type TemporalArtifact = {
  readonly knowledgeType: TemporalKnowledgeType;
  readonly status: TemporalStatus;
  readonly historyStart: Date;
  readonly historyEnd: Date;
  readonly recentStart: Date | null;
  readonly recentEnd: Date | null;
  readonly historyCount: number;
  readonly recentCount: number;
  readonly baseline: Record<string, unknown> | null;
  readonly recent: Record<string, unknown> | null;
  readonly finding: Record<string, unknown> | null;
  readonly reason: InsufficientReason | null;
  /** Every observation that contributed, as ids only. */
  readonly evidenceRefs: readonly { kind: string; id: number }[];
};

export const DAY_MS = 86_400_000;
