/**
 * DOC-04 · Paperwork lag — the first real MEASURE.
 *
 * QUESTION
 *   How long does this owner usually take to file a document after its date — and is that changing?
 *
 * WHY THIS ONE FIRST
 *   It is the only rule in the catalogue whose evidence exists in Production at learning-grade volume
 *   today, and it is derived from something the owner genuinely cannot see for themselves: the gap
 *   between when a document happened and when they got round to it. Every other candidate either has
 *   no data (there are zero issued invoices) or needs evidence nobody records yet.
 *
 * EVIDENCE
 *   `FinancialRecord.date` (when the document happened) → `.approvedAt` (when the owner accepted it).
 *   Both are written by the approval transaction, so an observation exists exactly when a real
 *   owner decision happened. No inference, no proxy.
 *
 * This module is PURE: it receives rows and returns a result. No Prisma, no clock, no env — the caller
 * supplies `now`. That is what makes the rule replayable, and replayability is what makes a derived
 * artifact safe to delete.
 */
import {
  measureFingerprint,
  median,
  trendFromWindows,
  type MeasureEvidenceRef,
  type MeasureResult,
} from "../measure.contract";

export const MEASURE_KEY = "documents.paperwork_lag";

/**
 * Five observations before we will call anything a habit.
 *
 * Not a tuning knob: below five, a median is an anecdote with a decimal point. The number is stated
 * here, in the rule, rather than in a config, because changing it changes what the system CLAIMS —
 * and that should require editing the rule and bumping its version, not editing an environment.
 */
export const MIN_SUPPORT = 5;

/** How far back evidence is considered. Older paperwork describes a business that no longer exists. */
export const WINDOW_DAYS = 180;

/** Half the window, for the trend comparison. */
const HALF_WINDOW_DAYS = WINDOW_DAYS / 2;

/** Under half a day of movement in a median is noise, not a change in behaviour. */
const TREND_MIN_DELTA_DAYS = 0.5;

/** One approved document: when it happened, and when the owner accepted it. */
export type PaperworkObservation = {
  readonly recordId: number;
  readonly businessId: number;
  readonly documentDate: Date;
  readonly approvedAt: Date;
};

const DAY_MS = 86_400_000;

/**
 * Lag in whole days. Negative lags are CLAMPED to zero rather than dropped.
 *
 * A document dated in the future — a prepaid invoice, or a typo — is a real approval that really
 * happened, and discarding it would quietly bias the sample toward slower filing. Clamping keeps the
 * observation and refuses to let it claim the owner filed something before it existed.
 */
export function lagDays(o: PaperworkObservation): number {
  return Math.max(0, (o.approvedAt.getTime() - o.documentDate.getTime()) / DAY_MS);
}

/**
 * Derive the measure.
 *
 * Returns `INSUFFICIENT_EVIDENCE` — fully formed, with its real observation count — rather than
 * nothing, so a consumer can say "4 of the 5 needed" instead of going silent for a reason it cannot
 * name. Being able to explain a refusal is the difference between a system that does not know and a
 * system that looks broken.
 */
export function derivePaperworkLag(
  observations: readonly PaperworkObservation[],
  now: Date,
): MeasureResult {
  const windowStart = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
  const midpoint = new Date(now.getTime() - HALF_WINDOW_DAYS * DAY_MS);

  // Canonical order: by approval time, then by id. Two runs over the same rows must produce the same
  // fingerprint, so ordering can never depend on how the database felt like returning them.
  const inWindow = observations
    .filter((o) => o.approvedAt >= windowStart && o.approvedAt <= now)
    .sort((a, b) =>
      a.approvedAt.getTime() - b.approvedAt.getTime() || a.recordId - b.recordId,
    );

  const refs: MeasureEvidenceRef[] = inWindow.map((o) => ({
    kind: "financial-record",
    businessId: o.businessId,
    recordId: o.recordId,
  }));
  const evidenceSet = {
    businessId: observations[0]?.businessId ?? 0,
    refs,
    fingerprint: measureFingerprint(refs),
  };

  const base = {
    measureKey: MEASURE_KEY,
    entityType: null,
    entityId: null,
    valueUnit: "days" as const,
    observationCount: inWindow.length,
    windowStart,
    windowEnd: now,
    evidenceSet,
  };

  if (inWindow.length < MIN_SUPPORT) {
    return {
      ...base,
      status: "INSUFFICIENT_EVIDENCE",
      valueNumeric: null,
      trend: null,
      // The consumer can explain the silence precisely, without re-deriving anything.
      detail: { minSupport: MIN_SUPPORT, have: inWindow.length },
    };
  }

  const lags = inWindow.map(lagDays);
  const overall = median(lags);

  // The trend halves are compared only when BOTH have enough support of their own. A "worsening"
  // computed from two observations would be an accusation, not a finding.
  const recent = inWindow.filter((o) => o.approvedAt >= midpoint).map(lagDays);
  const previous = inWindow.filter((o) => o.approvedAt < midpoint).map(lagDays);
  const enough = (xs: number[]) => (xs.length >= Math.ceil(MIN_SUPPORT / 2) ? median(xs) : null);
  const trend = trendFromWindows(enough(recent), enough(previous), TREND_MIN_DELTA_DAYS);

  return {
    ...base,
    status: "ACTIVE",
    valueNumeric: Math.round(overall * 100) / 100,
    trend,
    detail: {
      fastestDays: Math.round(Math.min(...lags) * 100) / 100,
      slowestDays: Math.round(Math.max(...lags) * 100) / 100,
      recentHalfCount: recent.length,
      previousHalfCount: previous.length,
    },
  };
}
