/**
 * M6 · The temporal engine — one series of ONE business's observations in, temporal knowledge out.
 *
 * PURE. No database, no clock, no randomness, no dependence on input order. Same points + same spec +
 * same asOf → the same artifacts, byte for byte.
 *
 * THE WINDOWS, AS OF `asOf`
 *
 *      historyStart ─────────── history ───────────▶ recentStart ── recent ──▶ asOf
 *
 *   The baseline is built from HISTORY ONLY. Recent observations are compared against it and never
 *   feed it — that is what stops one extreme value (or a new regime) from instantly redefining
 *   "normal". A new level becomes the baseline only by ageing into the history window, and the old
 *   baseline row is then SUPERSEDED, not overwritten.
 *
 * THE ORDER OF QUESTIONS
 *   1. Is there enough of this business's own history? If not: BASELINE = INSUFFICIENT_HISTORY with
 *      the exact shortfall, and nothing else — no trend, pattern, change or anomaly without a baseline.
 *   2. BASELINE (robust summary). STALE if the subject has gone quiet.
 *   3. STABLE_PATTERN only if the history is tight relative to its own level.
 *   4. MATERIAL_CHANGE if most of the recent window sits at a different level.
 *   5. ANOMALY for individual recent points far outside the baseline — only when there is NO material
 *      change, because points that together form a new level are a shift, not repeated anomalies.
 *   6. TREND across equal periods, only when every period is dense enough.
 */
import {
  DAY_MS,
  type InsufficientReason,
  type NumericPoint,
  type RatePoint,
  type RobustSummary,
  type TemporalArtifact,
  type TemporalSpec,
} from "./temporal.contract";
import { kendallTau, quantile, r4, rateSummary, robustScale, robustSummary, twoProportionZ } from "./robust";

/** Iglewicz–Hoaglin: a modified z-score of 3.5 is the conventional robust outlier line. */
const ANOMALY_ROBUST_Z = 3.5;
/** A shift must be at least this many robust scales away, on top of the material floor. */
const CHANGE_ROBUST_Z = 1.5;
/** Most of the recent window must sit on the same side for it to be a level, not scatter. */
const CHANGE_SAME_SIDE = 0.75;
/** A trend needs the period levels to agree on a direction (Kendall's tau). */
const TREND_TAU = 0.66;
/** Rate change: two-sided 1% level, AND the material floor on the difference itself. */
const RATE_CHANGE_Z = 2.58;

export type Windows = {
  readonly historyStart: Date;
  readonly recentStart: Date;
  readonly asOf: Date;
};

export function windowsFor(spec: TemporalSpec, asOf: Date): Windows {
  const recentStart = new Date(asOf.getTime() - spec.recentDays * DAY_MS);
  return { historyStart: new Date(recentStart.getTime() - spec.historyDays * DAY_MS), recentStart, asOf };
}

function canonical<T extends { at: Date; recordId: number }>(xs: readonly T[]): T[] {
  return [...xs].sort((a, b) => a.at.getTime() - b.at.getTime() || a.recordId - b.recordId);
}

function split<T extends { at: Date; recordId: number }>(xs: readonly T[], w: Windows) {
  const all = canonical(xs);
  return {
    history: all.filter((p) => p.at >= w.historyStart && p.at < w.recentStart),
    recent: all.filter((p) => p.at >= w.recentStart && p.at <= w.asOf),
  };
}

const days = (a: Date, b: Date) => (b.getTime() - a.getTime()) / DAY_MS;
const refsOf = (xs: readonly { recordId: number; evidenceKind: string }[]) =>
  xs.map((p) => ({ kind: p.evidenceKind, id: p.recordId }));

function sufficiency(
  history: readonly { at: Date }[],
  spec: TemporalSpec,
): InsufficientReason | null {
  if (history.length === 0) return { code: "NO_OBSERVATIONS", have: 0, need: spec.minHistory };
  if (history.length < spec.minHistory) {
    return { code: "TOO_FEW_OBSERVATIONS", have: history.length, need: spec.minHistory };
  }
  const span = days(history[0].at, history[history.length - 1].at);
  if (span < spec.minSpanDays) {
    return {
      code: "TOO_SHORT_HISTORY", have: history.length, need: spec.minHistory,
      spanDays: Math.floor(span), needSpanDays: spec.minSpanDays,
    };
  }
  return null;
}

function base(w: Windows, historyCount: number, recentCount: number) {
  return {
    historyStart: w.historyStart,
    historyEnd: w.recentStart,
    recentStart: w.recentStart,
    recentEnd: w.asOf,
    historyCount,
    recentCount,
  };
}

function insufficient(
  w: Windows,
  reason: InsufficientReason,
  historyRefs: readonly { kind: string; id: number }[],
  recentCount: number,
): TemporalArtifact {
  return {
    ...base(w, historyRefs.length, recentCount),
    knowledgeType: "BASELINE",
    status: "INSUFFICIENT_HISTORY",
    baseline: null,
    recent: null,
    finding: null,
    reason,
    evidenceRefs: historyRefs,
  };
}

function floorFor(spec: TemporalSpec, s: RobustSummary): number {
  return spec.materialFloorIsRelative ? spec.materialFloor * Math.abs(s.median) : spec.materialFloor;
}

function summaryOut(s: RobustSummary): Record<string, unknown> {
  return { n: s.n, median: s.median, q1: s.q1, q3: s.q3, iqr: s.iqr, mad: s.mad, min: s.min, max: s.max };
}

/* ═══════════════════════════════════ NUMERIC ═══════════════════════════════════ */

export type NumericOptions = {
  /**
   * CADENCE only: when the most recent occurrence happened. Lets the engine notice an occurrence that
   * is overdue by this entity's own rhythm — "no bill from this vendor for 3× its usual gap" — without
   * saying anything about why.
   */
  readonly lastEventAt?: Date | null;
};

export function assessNumeric(
  points: readonly NumericPoint[],
  spec: TemporalSpec,
  asOf: Date,
  opts: NumericOptions = {},
): TemporalArtifact[] {
  const w = windowsFor(spec, asOf);
  const { history, recent } = split(points, w);
  const historyRefs = refsOf(history);

  const short = sufficiency(history, spec);
  if (short) return [insufficient(w, short, historyRefs, recent.length)];

  const S = robustSummary(history.map((p) => p.value));
  const scale = robustScale(S);
  const floor = floorFor(spec, S);
  const out: TemporalArtifact[] = [];

  // ── BASELINE (ACTIVE, or STALE when the subject has gone quiet) ──
  const lastSeen = [...history, ...recent].reduce((a, p) => (p.at > a ? p.at : a), history[0].at);
  const quietDays = days(opts.lastEventAt && opts.lastEventAt > lastSeen ? opts.lastEventAt : lastSeen, asOf);
  const stale = quietDays > spec.staleAfterDays;
  out.push({
    ...base(w, history.length, recent.length),
    knowledgeType: "BASELINE",
    status: stale ? "STALE" : "ACTIVE",
    baseline: summaryOut(S),
    recent: null,
    finding: stale ? { stale: { daysSinceLastObservation: Math.floor(quietDays), staleAfterDays: spec.staleAfterDays } } : null,
    reason: null,
    evidenceRefs: historyRefs,
  });
  // A stale baseline describes the past. Nothing is inferred about the present from it.
  if (stale) return out;

  // ── STABLE_PATTERN ──
  const stableBand = Math.max(spec.stableRelativeSpread * Math.abs(S.median), floor);
  if (S.iqr <= stableBand) {
    out.push({
      ...base(w, history.length, recent.length),
      knowledgeType: "STABLE_PATTERN",
      status: "ACTIVE",
      baseline: summaryOut(S),
      recent: null,
      finding: { band: [S.q1, S.q3], iqr: S.iqr, allowedSpread: r4(stableBand) },
      reason: null,
      evidenceRefs: historyRefs,
    });
  }

  // ── MATERIAL_CHANGE ──
  let changed = false;
  if (recent.length >= spec.minRecent) {
    const R = robustSummary(recent.map((p) => p.value));
    const diff = R.median - S.median;
    const outsideBand = R.median > S.q3 || R.median < S.q1;
    const sameSide =
      recent.filter((p) => (diff > 0 ? p.value > S.median : p.value < S.median)).length / recent.length;
    const beyondScale = scale === 0 ? true : Math.abs(diff) >= CHANGE_ROBUST_Z * scale;
    if (Math.abs(diff) >= floor && outsideBand && sameSide >= CHANGE_SAME_SIDE && beyondScale) {
      changed = true;
      out.push({
        ...base(w, history.length, recent.length),
        knowledgeType: "MATERIAL_CHANGE",
        status: "ACTIVE",
        baseline: summaryOut(S),
        recent: summaryOut(R),
        finding: {
          direction: diff > 0 ? "UP" : "DOWN",
          shift: r4(diff),
          sameSideShare: r4(sameSide),
          // The recent level is a CANDIDATE baseline once it has as much support as a baseline needs.
          // It becomes the baseline only by ageing into the history window — never by assertion.
          candidateNewBaseline: recent.length >= spec.minHistory,
        },
        reason: null,
        evidenceRefs: [...historyRefs, ...refsOf(recent)],
      });
    }
  }

  // ── ANOMALY ──
  if (!changed) {
    const fenceLo = S.q1 - 1.5 * S.iqr;
    const fenceHi = S.q3 + 1.5 * S.iqr;
    const unusual = recent
      .map((p) => {
        const dev = p.value - S.median;
        const z = scale > 0 ? Math.abs(dev) / scale : Number.POSITIVE_INFINITY;
        return { p, dev, z };
      })
      .filter(({ p, dev, z }) =>
        Math.abs(dev) >= floor && z >= ANOMALY_ROBUST_Z && (p.value > fenceHi || p.value < fenceLo));

    let overdue: Record<string, unknown> | null = null;
    if (spec.valueKind === "cadence" && opts.lastEventAt) {
      const open = days(opts.lastEventAt, asOf);
      const limit = Math.max(S.q3 + 3 * Math.max(S.iqr, floor), 2 * S.median);
      if (open - S.median >= floor && open >= limit) {
        overdue = { daysSinceLast: Math.floor(open), typicalGap: S.median, threshold: r4(limit) };
      }
    }

    if (unusual.length > 0 || overdue) {
      out.push({
        ...base(w, history.length, recent.length),
        knowledgeType: "ANOMALY",
        status: "ACTIVE",
        baseline: summaryOut(S),
        recent: null,
        finding: {
          observations: unusual.map(({ p, dev, z }) => ({
            recordId: p.recordId,
            direction: dev > 0 ? "ABOVE" : "BELOW",
            robustZ: Number.isFinite(z) ? r4(z) : null,
          })),
          // An expected occurrence that has not appeared, judged by this entity's own rhythm only.
          expectedOccurrenceMissing: overdue,
        },
        reason: null,
        evidenceRefs: [...historyRefs, ...refsOf(unusual.map((u) => u.p))],
      });
    }
  }

  // ── TREND ──
  out.push(numericTrend([...history, ...recent], spec, w, floor, history.length, recent.length));
  return out;
}

function periodsOf<T extends { at: Date }>(xs: readonly T[], w: Windows, count: number): T[][] {
  const start = w.historyStart.getTime();
  const width = (w.asOf.getTime() - start) / count;
  const buckets: T[][] = Array.from({ length: count }, () => []);
  for (const x of xs) {
    const i = Math.min(count - 1, Math.floor((x.at.getTime() - start) / width));
    if (i >= 0) buckets[i].push(x);
  }
  return buckets;
}

function numericTrend(
  all: readonly NumericPoint[],
  spec: TemporalSpec,
  w: Windows,
  floor: number,
  historyCount: number,
  recentCount: number,
): TemporalArtifact {
  const periods = periodsOf(canonical(all), w, spec.trendPeriods);
  const refs = refsOf(canonical(all));
  const sparse = periods.findIndex((p) => p.length < spec.minPerPeriod);
  if (sparse >= 0) {
    return {
      ...base(w, historyCount, recentCount),
      knowledgeType: "TREND",
      status: "INSUFFICIENT_HISTORY",
      baseline: null, recent: null, finding: null,
      reason: {
        code: "TOO_FEW_OBSERVATIONS", have: periods[sparse].length, need: spec.minPerPeriod,
      },
      evidenceRefs: refs,
    };
  }
  const levels = periods.map((p) => quantile([...p.map((x) => x.value)].sort((a, b) => a - b), 0.5));
  const tau = kendallTau(levels);
  const change = levels[levels.length - 1] - levels[0];
  const range = Math.max(...levels) - Math.min(...levels);
  const direction =
    range < floor ? "FLAT"
      : tau >= TREND_TAU && change >= floor ? "UP"
        : tau <= -TREND_TAU && -change >= floor ? "DOWN"
          : "NONE";
  return {
    ...base(w, historyCount, recentCount),
    knowledgeType: "TREND",
    status: "ACTIVE",
    baseline: null,
    recent: null,
    finding: {
      direction,
      periods: spec.trendPeriods,
      periodLevels: levels.map(r4),
      periodCounts: periods.map((p) => p.length),
      kendallTau: r4(tau),
      firstToLast: r4(change),
    },
    reason: null,
    evidenceRefs: refs,
  };
}

/* ═══════════════════════════════════ RATE ═══════════════════════════════════ */

/**
 * A population of yes/no outcomes. There is no per-observation anomaly for a rate — one corrected
 * document is not unusual, it is a member of the population. Changes in a rate are MATERIAL_CHANGE
 * (recent vs baseline) or TREND (across periods).
 */
export function assessRate(points: readonly RatePoint[], spec: TemporalSpec, asOf: Date): TemporalArtifact[] {
  const w = windowsFor(spec, asOf);
  const { history, recent } = split(points, w);
  const historyRefs = refsOf(history);
  const short = sufficiency(history, spec);
  if (short) return [insufficient(w, short, historyRefs, recent.length)];

  const P = rateSummary(history.map((p) => p.hit));
  const out: TemporalArtifact[] = [];
  const lastSeen = [...history, ...recent].reduce((a, p) => (p.at > a ? p.at : a), history[0].at);
  const quietDays = days(lastSeen, asOf);
  const stale = quietDays > spec.staleAfterDays;
  out.push({
    ...base(w, history.length, recent.length),
    knowledgeType: "BASELINE",
    status: stale ? "STALE" : "ACTIVE",
    baseline: { ...P },
    recent: null,
    finding: stale ? { stale: { daysSinceLastObservation: Math.floor(quietDays), staleAfterDays: spec.staleAfterDays } } : null,
    reason: null,
    evidenceRefs: historyRefs,
  });
  if (stale) return out;

  // STABLE_PATTERN: the history's own thirds agree within the material floor.
  const thirds = periodsOf(history, { historyStart: w.historyStart, recentStart: w.recentStart, asOf: w.recentStart }, 3);
  const minThird = Math.max(5, Math.ceil(spec.minHistory / 4));
  if (thirds.every((t) => t.length >= minThird)) {
    const ps = thirds.map((t) => rateSummary(t.map((x) => x.hit)).proportion);
    const spread = Math.max(...ps) - Math.min(...ps);
    if (spread <= spec.materialFloor) {
      out.push({
        ...base(w, history.length, recent.length),
        knowledgeType: "STABLE_PATTERN",
        status: "ACTIVE",
        baseline: { ...P },
        recent: null,
        finding: { thirdProportions: ps, spread: r4(spread), allowedSpread: spec.materialFloor },
        reason: null,
        evidenceRefs: historyRefs,
      });
    }
  }

  // MATERIAL_CHANGE
  if (recent.length >= spec.minRecent) {
    const Rr = rateSummary(recent.map((p) => p.hit));
    const z = twoProportionZ(P, Rr);
    const diff = Rr.proportion - P.proportion;
    if (Math.abs(diff) >= spec.materialFloor && Math.abs(z) >= RATE_CHANGE_Z) {
      out.push({
        ...base(w, history.length, recent.length),
        knowledgeType: "MATERIAL_CHANGE",
        status: "ACTIVE",
        baseline: { ...P },
        recent: { ...Rr },
        finding: {
          direction: diff > 0 ? "UP" : "DOWN", shift: r4(diff), z: r4(z),
          candidateNewBaseline: recent.length >= spec.minHistory,
        },
        reason: null,
        evidenceRefs: [...historyRefs, ...refsOf(recent)],
      });
    }
  }

  // TREND
  const all = canonical([...history, ...recent]);
  const periods = periodsOf(all, w, spec.trendPeriods);
  const sparse = periods.findIndex((p) => p.length < spec.minPerPeriod);
  if (sparse >= 0) {
    out.push({
      ...base(w, history.length, recent.length),
      knowledgeType: "TREND", status: "INSUFFICIENT_HISTORY",
      baseline: null, recent: null, finding: null,
      reason: { code: "TOO_FEW_OBSERVATIONS", have: periods[sparse].length, need: spec.minPerPeriod },
      evidenceRefs: refsOf(all),
    });
  } else {
    const levels = periods.map((p) => rateSummary(p.map((x) => x.hit)).proportion);
    const tau = kendallTau(levels);
    const change = levels[levels.length - 1] - levels[0];
    const range = Math.max(...levels) - Math.min(...levels);
    const direction =
      range < spec.materialFloor ? "FLAT"
        : tau >= TREND_TAU && change >= spec.materialFloor ? "UP"
          : tau <= -TREND_TAU && -change >= spec.materialFloor ? "DOWN"
            : "NONE";
    out.push({
      ...base(w, history.length, recent.length),
      knowledgeType: "TREND", status: "ACTIVE",
      baseline: null, recent: null,
      finding: {
        direction, periods: spec.trendPeriods, periodLevels: levels.map(r4),
        periodCounts: periods.map((p) => p.length), kendallTau: r4(tau), firstToLast: r4(change),
      },
      reason: null,
      evidenceRefs: refsOf(all),
    });
  }
  return out;
}
