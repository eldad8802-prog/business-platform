/**
 * M4 · Shapes that recur across rules, factored once.
 *
 * Three shapes account for every rule in this milestone, and writing each of them twelve times would
 * be twelve chances to get the window boundary or the ordering subtly different:
 *
 *   CADENCE   how regularly does a thing happen (gaps between consecutive events)
 *   LATENCY   how long does the gap between a promise and its fulfilment tend to be
 *   SHARE     what fraction of a population has some property
 *
 * This is NOT the generic rule engine the milestone forbids. Nothing here decides what counts as
 * evidence, what a rule means, or when it should speak — each rule still states all of that itself.
 * These are statistics with the window arithmetic already agreed on, and they are pure.
 *
 * CALENDAR DAYS, NOT ELAPSED MILLISECONDS. Every duration here goes through the Jerusalem day keys,
 * for the reason that module exists: Israel changes its clocks twice a year, and `30 * 86_400_000`
 * lands an hour off the wall clock it started from. A habit measured in days must be measured in the
 * days the owner actually lived.
 */
import {
  daysBetweenDayKeys,
  jerusalemDayKey,
} from "@/lib/utils/jerusalem-day";
import {
  measureFingerprint,
  median,
  trendFromWindows,
  type MeasureEvidenceRef,
  type MeasureResult,
  type MeasureStatus,
  type MeasureTrend,
  type MeasureUnit,
} from "./measure.contract";
import { insufficientDetail, round2, DAY_MS } from "./rule.contract";

/** Whole calendar days from `from` to `to`, as the business in Israel experienced them. */
export function calendarDays(from: Date, to: Date): number {
  return daysBetweenDayKeys(jerusalemDayKey(from), jerusalemDayKey(to));
}

/** One evidence-bearing event on a timeline. `at` is what the window and the ordering use. */
export type TimelinePoint = {
  readonly recordId: number;
  readonly businessId: number;
  readonly at: Date;
};

/**
 * Canonical ordering, applied before anything is measured or fingerprinted.
 *
 * Two runs over the same rows must produce the same fingerprint, so the order can never depend on how
 * the database felt like returning them. `at` then `recordId` is total: no two rows can tie.
 */
export function canonicalOrder<T extends TimelinePoint>(points: readonly T[]): T[] {
  return [...points].sort(
    (a, b) => a.at.getTime() - b.at.getTime() || a.recordId - b.recordId,
  );
}

export function windowBounds(now: Date, windowDays: number): { windowStart: Date; midpoint: Date } {
  return {
    windowStart: new Date(now.getTime() - windowDays * DAY_MS),
    midpoint: new Date(now.getTime() - (windowDays / 2) * DAY_MS),
  };
}

export function withinWindow<T extends TimelinePoint>(
  points: readonly T[],
  windowStart: Date,
  now: Date,
): T[] {
  return canonicalOrder(points.filter((p) => p.at >= windowStart && p.at <= now));
}

function refsOf(points: readonly TimelinePoint[], kind: string): MeasureEvidenceRef[] {
  return points.map((p) => ({ kind, businessId: p.businessId, recordId: p.recordId }));
}

/** What every builder below needs in order to produce a fully-formed `MeasureResult`. */
export type MeasureFrame = {
  readonly measureKey: string;
  readonly entityType: string | null;
  readonly entityId: number | null;
  readonly valueUnit: MeasureUnit;
  readonly evidenceKind: string;
  readonly minSupport: number;
  readonly windowDays: number;
  /** How much movement in the value is worth calling a trend. Omit to compute no trend at all. */
  readonly trendMinDelta?: number;
};

function assemble(
  frame: MeasureFrame,
  inWindow: readonly TimelinePoint[],
  windowStart: Date,
  now: Date,
  businessId: number,
  status: MeasureStatus,
  valueNumeric: number | null,
  trend: MeasureTrend | null,
  detail: Record<string, unknown>,
): MeasureResult {
  const refs = refsOf(inWindow, frame.evidenceKind);
  return {
    measureKey: frame.measureKey,
    entityType: frame.entityType,
    entityId: frame.entityId,
    status,
    valueNumeric,
    valueUnit: frame.valueUnit,
    detail,
    observationCount: inWindow.length,
    windowStart,
    windowEnd: now,
    trend,
    evidenceSet: { businessId, refs, fingerprint: measureFingerprint(refs) },
  };
}

/**
 * A trend across the two halves of the window, computed only when BOTH halves can support one.
 *
 * `Math.ceil(minSupport / 2)` per half is the same bar DOC-04 set, and it is the point of the whole
 * exercise: a "worsening" computed from two observations is an accusation rather than a finding.
 */
function halvesTrend(
  values: readonly { at: Date; value: number }[],
  midpoint: Date,
  minSupport: number,
  minDelta: number,
): { trend: MeasureTrend | null; recentCount: number; previousCount: number } {
  const recent = values.filter((v) => v.at >= midpoint).map((v) => v.value);
  const previous = values.filter((v) => v.at < midpoint).map((v) => v.value);
  const floor = Math.ceil(minSupport / 2);
  const enough = (xs: number[]): number | null => (xs.length >= floor ? median(xs) : null);
  return {
    trend: trendFromWindows(enough(recent), enough(previous), minDelta),
    recentCount: recent.length,
    previousCount: previous.length,
  };
}

/**
 * CADENCE — how many days typically pass between one occurrence and the next.
 *
 * Support is counted in GAPS, not events: five purchases produce four gaps, and it is the gaps that
 * are the observations. The evidence set is still the events, because those are the records that can
 * be pointed at — a gap has no id.
 *
 * `minSupport` therefore means "this many gaps", and a rule that wants five gaps must see six events.
 * Stating it this way round is what stops a rule from claiming a rhythm it has seen once.
 */
export function cadenceMeasure(
  frame: MeasureFrame,
  points: readonly TimelinePoint[],
  now: Date,
  businessId: number,
): MeasureResult {
  const { windowStart, midpoint } = windowBounds(now, frame.windowDays);
  const inWindow = withinWindow(points, windowStart, now);

  const gaps: { at: Date; value: number }[] = [];
  for (let i = 1; i < inWindow.length; i += 1) {
    gaps.push({ at: inWindow[i].at, value: calendarDays(inWindow[i - 1].at, inWindow[i].at) });
  }

  if (gaps.length < frame.minSupport) {
    return assemble(frame, inWindow, windowStart, now, businessId, "INSUFFICIENT_EVIDENCE", null, null,
      insufficientDetail(frame.minSupport, gaps.length, { supportUnit: "gaps", events: inWindow.length }));
  }

  const values = gaps.map((g) => g.value);
  const { trend, recentCount, previousCount } =
    frame.trendMinDelta == null
      ? { trend: null, recentCount: 0, previousCount: 0 }
      : halvesTrend(gaps, midpoint, frame.minSupport, frame.trendMinDelta);

  return assemble(frame, inWindow, windowStart, now, businessId, "ACTIVE", round2(median(values)), trend, {
    gapCount: gaps.length,
    shortestDays: round2(Math.min(...values)),
    longestDays: round2(Math.max(...values)),
    recentHalfCount: recentCount,
    previousHalfCount: previousCount,
  });
}

/** One promise and its fulfilment: an expected day, and the day it actually happened. */
export type LatencyPoint = TimelinePoint & { readonly expectedAt: Date };

/**
 * LATENCY — how many days typically separate what was expected from what happened.
 *
 * The value is SIGNED, and that is the whole point: a median of −3 says this owner is usually three
 * days EARLY, which is a different fact about a business than "usually on time" and must not be
 * flattened into a magnitude. Clamping here would turn a punctual payer into an average one.
 */
export function latencyMeasure(
  frame: MeasureFrame,
  points: readonly LatencyPoint[],
  now: Date,
  businessId: number,
): MeasureResult {
  const { windowStart, midpoint } = windowBounds(now, frame.windowDays);
  const inWindow = withinWindow(points, windowStart, now) as LatencyPoint[];

  if (inWindow.length < frame.minSupport) {
    return assemble(frame, inWindow, windowStart, now, businessId, "INSUFFICIENT_EVIDENCE", null, null,
      insufficientDetail(frame.minSupport, inWindow.length));
  }

  const lat = inWindow.map((p) => ({ at: p.at, value: calendarDays(p.expectedAt, p.at) }));
  const values = lat.map((l) => l.value);
  const { trend, recentCount, previousCount } =
    frame.trendMinDelta == null
      ? { trend: null, recentCount: 0, previousCount: 0 }
      : halvesTrend(lat, midpoint, frame.minSupport, frame.trendMinDelta);

  return assemble(frame, inWindow, windowStart, now, businessId, "ACTIVE", round2(median(values)), trend, {
    earliestDays: round2(Math.min(...values)),
    latestDays: round2(Math.max(...values)),
    onTimeOrEarly: values.filter((v) => v <= 0).length,
    recentHalfCount: recentCount,
    previousHalfCount: previousCount,
  });
}

/** One observation carrying a number the rule already computed. */
export type ValuePoint = TimelinePoint & { readonly value: number };

/**
 * VALUE — the typical size of something, with how far it ranges.
 *
 * The most general of the shapes: the rule supplies the number, this supplies the window, the median,
 * the trend and the spread. `relativeSpread` is (max − min) ÷ |median|, and it is the field that
 * stops the headline being read as a promise: a median of ₪500 with a spread of 0.1 is a standing
 * charge, the same median with a spread of 6 is an average of things that have nothing in common.
 *
 * A median of zero yields a null spread rather than an infinity, because "the typical value is zero"
 * is a statement and "the spread is ∞" is a division nobody asked for.
 */
export function valueMeasure(
  frame: MeasureFrame,
  points: readonly ValuePoint[],
  now: Date,
  businessId: number,
): MeasureResult {
  const { windowStart, midpoint } = windowBounds(now, frame.windowDays);
  const inWindow = withinWindow(points, windowStart, now) as ValuePoint[];

  if (inWindow.length < frame.minSupport) {
    return assemble(frame, inWindow, windowStart, now, businessId, "INSUFFICIENT_EVIDENCE", null, null,
      insufficientDetail(frame.minSupport, inWindow.length));
  }

  const values = inWindow.map((p) => p.value);
  const centre = median(values);
  const { trend, recentCount, previousCount } =
    frame.trendMinDelta == null
      ? { trend: null, recentCount: 0, previousCount: 0 }
      : halvesTrend(inWindow, midpoint, frame.minSupport, frame.trendMinDelta);

  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return assemble(frame, inWindow, windowStart, now, businessId, "ACTIVE", round2(centre), trend, {
    lowest: round2(lo),
    highest: round2(hi),
    relativeSpread: centre === 0 ? null : round2((hi - lo) / Math.abs(centre)),
    recentHalfCount: recentCount,
    previousHalfCount: previousCount,
  });
}

/** One member of a population, and whether it has the property being counted. */
export type SharePoint = TimelinePoint & { readonly hit: boolean };

/**
 * SHARE — what fraction of the population has the property.
 *
 * No trend. A ratio's two halves would each need their own minimum support to mean anything, and at
 * the volumes a small business produces that bar is almost never cleared; reporting a direction
 * anyway would be the first piece of false precision in the layer. A rule that genuinely needs a
 * ratio trend can compute one explicitly and justify it there.
 */
export function shareMeasure(
  frame: MeasureFrame,
  points: readonly SharePoint[],
  now: Date,
  businessId: number,
): MeasureResult {
  const { windowStart } = windowBounds(now, frame.windowDays);
  const inWindow = withinWindow(points, windowStart, now) as SharePoint[];

  if (inWindow.length < frame.minSupport) {
    return assemble(frame, inWindow, windowStart, now, businessId, "INSUFFICIENT_EVIDENCE", null, null,
      insufficientDetail(frame.minSupport, inWindow.length));
  }

  const hits = inWindow.filter((p) => p.hit).length;
  return assemble(frame, inWindow, windowStart, now, businessId, "ACTIVE",
    round2(hits / inWindow.length), null, {
      hits,
      population: inWindow.length,
    });
}

/**
 * COUNT — how many times something happened in the window.
 *
 * The only shape with no minimum support, because the count IS the observation: "this item hit its
 * threshold twice" is a complete statement, and demanding five before saying it would suppress the
 * exact signal the measure exists for. `minSupport` is still honoured as a floor on the count itself,
 * which is how a rule expresses "fewer than this is not worth mentioning".
 */
export function countMeasure(
  frame: MeasureFrame,
  points: readonly TimelinePoint[],
  now: Date,
  businessId: number,
): MeasureResult {
  const { windowStart } = windowBounds(now, frame.windowDays);
  const inWindow = withinWindow(points, windowStart, now);

  if (inWindow.length < frame.minSupport) {
    return assemble(frame, inWindow, windowStart, now, businessId, "INSUFFICIENT_EVIDENCE", null, null,
      insufficientDetail(frame.minSupport, inWindow.length));
  }
  return assemble(frame, inWindow, windowStart, now, businessId, "ACTIVE", inWindow.length, null, {
    firstAt: inWindow[0].at.toISOString(),
    lastAt: inWindow[inWindow.length - 1].at.toISOString(),
  });
}

/**
 * Split a flat observation list into one group per entity, in a canonical order.
 *
 * Entity-level rules must emit their measures in a deterministic sequence, or a rebuild would write
 * the same rows in a different order and any comparison over the SET would be reading noise. Sorting
 * by entity id is the cheapest total order that exists for every entity kind here.
 */
export function groupByEntity<T>(rows: readonly T[], entityIdOf: (row: T) => number): Map<number, T[]> {
  const grouped = new Map<number, T[]>();
  for (const row of rows) {
    const key = entityIdOf(row);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(row);
    else grouped.set(key, [row]);
  }
  return new Map([...grouped.entries()].sort((a, b) => a[0] - b[0]));
}
