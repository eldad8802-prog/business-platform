/**
 * M2 · The MEASURE contract — quantitative derived knowledge.
 *
 * Pure types and pure helpers. Zero imports: no Prisma, no clock, no env. A rule that needs any of
 * those is doing something other than deriving, and the boundary is easier to keep than to restore.
 *
 * The shape mirrors the Claim contract's discipline and diverges only where the semantics genuinely
 * differ: a measure carries a NUMBER, an observation count and a WINDOW, and it has no notion of
 * conflicting candidates, because two windows disagreeing is not a conflict — it is a trend.
 *
 * There is no `confidence` field, for the same reason there is none on a Claim. `observationCount` and
 * the window are facts about the derivation; 0.87 would be a decoration.
 */

/** Whether the knowledge may be used, and if not, why not. Mirrors the `KnowledgeStatus` enum. */
export type MeasureStatus = "ACTIVE" | "INSUFFICIENT_EVIDENCE" | "STALE" | "SUPERSEDED";

export type MeasureTrend = "IMPROVING" | "STABLE" | "WORSENING";

/** What the headline number means. Governed set — a unit the UI cannot render is a bug, not a value. */
export type MeasureUnit = "days" | "count" | "ratio" | "currency";

/** A logical reference to one canonical evidence record. Never the record itself. */
export type MeasureEvidenceRef = {
  readonly kind: string;
  readonly businessId: number;
  readonly recordId: number;
};

/** The ordered evidence set a measure was derived from, plus its identity. */
export type MeasureEvidenceSet = {
  readonly businessId: number;
  readonly refs: readonly MeasureEvidenceRef[];
  /**
   * Identity-only digest, exactly as the Claim adapter computes it: it changes when the SET changes,
   * not when a row's contents change. Append-only evidence is the precondition that makes that sound,
   * and it is the same precondition Claims already depend on.
   */
  readonly fingerprint: string;
};

/**
 * The output of a rule. `INSUFFICIENT_EVIDENCE` is a first-class, fully-formed result — it carries its
 * window and its observation count so a consumer can explain the silence ("4 of the 5 needed"), rather
 * than an empty value a caller has to guess about.
 */
export type MeasureResult = {
  readonly measureKey: string;
  readonly entityType: string | null;
  readonly entityId: number | null;
  readonly status: MeasureStatus;
  /** Present only when ACTIVE. A number with a status of INSUFFICIENT_EVIDENCE would invite misuse. */
  readonly valueNumeric: number | null;
  readonly valueUnit: MeasureUnit;
  readonly detail: Record<string, unknown> | null;
  readonly observationCount: number;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly trend: MeasureTrend | null;
  readonly evidenceSet: MeasureEvidenceSet;
};

/** Build the evidence-set identity. Ordering is the caller's responsibility and must be canonical. */
export function measureFingerprint(refs: readonly MeasureEvidenceRef[]): string {
  return refs.map((r) => `${r.kind}:${r.businessId}:${r.recordId}`).join("|");
}

/**
 * The median of a sample.
 *
 * Median, not mean, and that is a substantive choice rather than a stylistic one. These samples are
 * small and long-tailed: one invoice filed nine months late would drag a mean into describing a habit
 * nobody has. The median answers the question an owner is actually asking — "what usually happens".
 */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median of an empty sample is undefined");
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Compare two windows into a coarse direction.
 *
 * `minDelta` exists so that noise is not reported as movement. With the observation counts a small
 * business produces, a half-day shift in a median is not a trend, and saying so would be the first
 * piece of false precision in the knowledge layer.
 *
 * Lower is better here (a smaller lag, a shorter delay), which is why IMPROVING means a DECREASE.
 */
export function trendFromWindows(
  recent: number | null,
  previous: number | null,
  minDelta: number,
): MeasureTrend | null {
  if (recent == null || previous == null) return null;
  const delta = recent - previous;
  if (Math.abs(delta) < minDelta) return "STABLE";
  return delta < 0 ? "IMPROVING" : "WORSENING";
}
