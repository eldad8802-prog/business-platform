/**
 * Business Brain · temporal INTERPRETATION — from the engine's artifacts to one state per series.
 *
 * The M6 engine already decides, with its own thresholds, whether a series of ONE business has a
 * baseline, a stable pattern, a material change, a trend or an anomaly. This file adds NO statistics and
 * NO thresholds. It answers one question per series, using only what the engine proved:
 *
 *   "What is the state of this behaviour now, relative to this business's own past?"
 *
 *   INSUFFICIENT_HISTORY  not enough of this business's own history to say anything
 *   NEW_BEHAVIOR          no observations at all in the history window, enough in the recent window, AND
 *                         this business demonstrably HAS recorded history for the same key (another subject
 *                         of the same rule has a baseline) — so "new" means the business started doing it,
 *                         not that Dubiz only started recording the business. Otherwise INSUFFICIENT_HISTORY.
 *   GONE_QUIET            a baseline exists but the subject has stopped producing observations (STALE)
 *   IMPROVING / DETERIORATING  a material level shift or a period trend, in a direction this rule
 *                         declares favourable / unfavourable for the business (polarity is declared per
 *                         rule, only where it is unambiguous; otherwise SHIFTED / TRENDING)
 *   SHIFTED / TRENDING    a level shift / trend in a direction with no declared business polarity
 *   ONE_OFF_ANOMALY       individual recent observations far outside a still-valid baseline, with no
 *                         level shift (several unusual points that form a new level are a SHIFT instead)
 *   STABLE_PATTERN        a tight, reliable baseline and nothing unusual recently
 *   NORMAL                a baseline exists and the recent window is consistent with it
 *
 * Precedence follows the engine's own order of questions: sufficiency → staleness → level shift →
 * trend → anomaly → stability → normal. The state names never imply a cause; "improving" means the
 * measured level moved in the favourable direction, not that anything made it move.
 */

export type TemporalStateName =
  | "INSUFFICIENT_HISTORY" | "NEW_BEHAVIOR" | "GONE_QUIET"
  | "IMPROVING" | "DETERIORATING" | "SHIFTED" | "TRENDING"
  | "ONE_OFF_ANOMALY" | "STABLE_PATTERN" | "NORMAL";

/** Which direction of the measured value is better for the business. Declared per rule; absent = neutral. */
export type Polarity = "LOWER_IS_FAVORABLE" | "HIGHER_IS_FAVORABLE";

/** The stored temporal rows of ONE series (same business, key, subject and context), as the snapshot reads them. */
export type SeriesRow = {
  readonly id: number;
  readonly knowledgeType: "BASELINE" | "STABLE_PATTERN" | "TREND" | "MATERIAL_CHANGE" | "ANOMALY";
  readonly status: "ACTIVE" | "INSUFFICIENT_HISTORY" | "STALE";
  readonly historyCount: number;
  readonly recentCount: number;
  readonly historyStart: Date;
  readonly finding: unknown;
};

export type TemporalState = {
  readonly state: TemporalStateName;
  /** UP / DOWN of the measured value when a shift or trend was proven; null otherwise. */
  readonly direction: "UP" | "DOWN" | null;
  readonly changeKind: "LEVEL_SHIFT" | "TREND" | null;
  readonly polarity: Polarity | null;
  /** How long the baseline ("normal") was established over — observations and since when. */
  readonly normalSince: string | null;
  readonly historyObservations: number;
  readonly recentObservations: number;
  /** The rows this state was read from — its provenance. */
  readonly basedOn: readonly number[];
};

const dirOf = (finding: unknown): "UP" | "DOWN" | null => {
  const d = (finding as { direction?: unknown } | null)?.direction;
  return d === "UP" || d === "DOWN" ? d : null;
};

function directional(direction: "UP" | "DOWN", polarity: Polarity | null, neutral: TemporalStateName): TemporalStateName {
  if (polarity === null) return neutral;
  const favorable = polarity === "LOWER_IS_FAVORABLE" ? "DOWN" : "UP";
  return direction === favorable ? "IMPROVING" : "DETERIORATING";
}

/**
 * One state for one series. `minRecent` is the rule's own spec value (the same number the engine uses
 * to call a recent window meaningful), so NEW_BEHAVIOR needs no threshold of its own.
 */
export function interpretSeries(
  rows: readonly SeriesRow[],
  polarity: Polarity | null,
  minRecent: number,
  /** True only when another subject of the SAME rule has an established baseline in this business. */
  keyHasEstablishedHistory: boolean,
): TemporalState | null {
  const baseline = rows.find((r) => r.knowledgeType === "BASELINE");
  if (!baseline) return null;
  const active = (t: SeriesRow["knowledgeType"]) => rows.find((r) => r.knowledgeType === t && r.status === "ACTIVE");
  const common = {
    polarity,
    historyObservations: baseline.historyCount,
    recentObservations: baseline.recentCount,
  };
  const state = (s: TemporalStateName, used: readonly SeriesRow[], direction: "UP" | "DOWN" | null = null,
    changeKind: TemporalState["changeKind"] = null): TemporalState => ({
    state: s, direction, changeKind, ...common,
    normalSince: baseline.status === "INSUFFICIENT_HISTORY" ? null : baseline.historyStart.toISOString(),
    basedOn: [...new Set(used.map((r) => r.id))].sort((a, b) => a - b),
  });

  if (baseline.status === "INSUFFICIENT_HISTORY") {
    return baseline.historyCount === 0 && baseline.recentCount >= minRecent && keyHasEstablishedHistory
      ? state("NEW_BEHAVIOR", [baseline])
      : state("INSUFFICIENT_HISTORY", [baseline]);
  }
  if (baseline.status === "STALE") return state("GONE_QUIET", [baseline]);

  const shift = active("MATERIAL_CHANGE");
  const sd = shift ? dirOf(shift.finding) : null;
  if (shift && sd) return state(directional(sd, polarity, "SHIFTED"), [baseline, shift], sd, "LEVEL_SHIFT");

  const trend = active("TREND");
  const td = trend ? dirOf(trend.finding) : null; // FLAT and NONE are not trends
  if (trend && td) return state(directional(td, polarity, "TRENDING"), [baseline, trend], td, "TREND");

  const anomaly = active("ANOMALY");
  if (anomaly) return state("ONE_OFF_ANOMALY", [baseline, anomaly]);

  const stable = active("STABLE_PATTERN");
  if (stable) return state("STABLE_PATTERN", [baseline, stable]);

  return state("NORMAL", [baseline]);
}
