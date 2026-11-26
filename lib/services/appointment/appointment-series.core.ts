/**
 * Recurring appointments (G5) — the PURE rule: which days a series occupies. No DB, no clock, no network.
 *
 * Owner decisions 2026-11-24:
 *   - owner-created only; WEEKLY or BIWEEKLY;
 *   - a series ENDS: after N occurrences (1..104) or on an until-date (at most 730 days after its first day) — exactly
 *     one of the two. There is NO open-ended series (the database refuses one: AppointmentSeries_end).
 * The weekday is the first day's own weekday; the wall-clock minute is kept on every day, so an occurrence on the far
 * side of a clock change starts at the same LOCAL time (instantOf reads Asia/Jerusalem for that day).
 */
import { addCalendarDays, daysBetweenDayKeys, type JerusalemDayKey } from "@/lib/utils/jerusalem-day";

import { invalid } from "./appointment-errors";
import { instantOf, isDayKey, weekdayOf } from "./availability.core";

export type SeriesFrequency = "WEEKLY" | "BIWEEKLY";
export const SERIES_FREQUENCIES: readonly SeriesFrequency[] = ["WEEKLY", "BIWEEKLY"];
/** The database's bounds (AppointmentSeries_end), repeated so a request is refused before any write. */
export const MAX_OCCURRENCES = 104;
export const MAX_SERIES_SPAN_DAYS = 730;

export type SeriesEnd = { occurrenceCount: number; endsOn?: undefined } | { endsOn: JerusalemDayKey; occurrenceCount?: undefined };

export type SeriesRule = {
  frequency: SeriesFrequency;
  startsOn: JerusalemDayKey;
  startMinute: number;
  durationMinutes: number;
  end: SeriesEnd;
};

export type PlannedOccurrence = { index: number; dayKey: JerusalemDayKey; startsAt: Date; endsAt: Date };

export const stepDays = (frequency: SeriesFrequency): number => (frequency === "BIWEEKLY" ? 14 : 7);

/** Parses the end of a series from a request: exactly one of `occurrenceCount` / `endsOn`, inside the bounds. */
export function parseSeriesEnd(startsOn: JerusalemDayKey, occurrenceCount: unknown, endsOn: unknown): SeriesEnd {
  const hasCount = occurrenceCount !== undefined && occurrenceCount !== null;
  const hasUntil = endsOn !== undefined && endsOn !== null && endsOn !== "";
  if (hasCount === hasUntil) throw invalid("seriesEnd");
  if (hasCount) {
    if (typeof occurrenceCount !== "number" || !Number.isInteger(occurrenceCount) || occurrenceCount < 1 || occurrenceCount > MAX_OCCURRENCES) {
      throw invalid("occurrenceCount");
    }
    return { occurrenceCount };
  }
  if (!isDayKey(endsOn)) throw invalid("endsOn");
  const span = daysBetweenDayKeys(startsOn, endsOn);
  if (span < 0 || span > MAX_SERIES_SPAN_DAYS) throw invalid("endsOn");
  return { endsOn };
}

/**
 * Every day of the series, in order. Never more than MAX_OCCURRENCES: an until-date that would give more (two weekly
 * years = 105 days) is refused, not silently cut.
 */
export function seriesDays(frequency: SeriesFrequency, startsOn: JerusalemDayKey, end: SeriesEnd): JerusalemDayKey[] {
  const step = stepDays(frequency);
  const out: JerusalemDayKey[] = [];
  for (let i = 0; ; i++) {
    if (out.length > MAX_OCCURRENCES) throw invalid("endsOn");
    const day = addCalendarDays(startsOn, i * step);
    if (end.occurrenceCount !== undefined) {
      if (i >= end.occurrenceCount) break;
    } else if (day > end.endsOn) {
      break;
    }
    out.push(day);
  }
  return out;
}

/** The occurrences of a rule as instants (Asia/Jerusalem wall clock of each day). */
export function planOccurrences(rule: SeriesRule): PlannedOccurrence[] {
  return seriesDays(rule.frequency, rule.startsOn, rule.end).map((dayKey, index) => {
    const startsAt = instantOf(dayKey, rule.startMinute);
    return { index, dayKey, startsAt, endsAt: new Date(startsAt.getTime() + rule.durationMinutes * 60_000) };
  });
}

/** The weekday the database stores (0 = Sunday … 6 = Saturday): the first day's own. */
export const seriesWeekday = (startsOn: JerusalemDayKey): number => weekdayOf(startsOn);

/**
 * Ending a series BEFORE one of its days ("this and following" cancelled or split off): the last kept day is the
 * day before. Null when nothing would be left (the day is the series' first) — the series is then cancelled whole.
 */
export function endBefore(startsOn: JerusalemDayKey, dayKey: JerusalemDayKey): JerusalemDayKey | null {
  const last = addCalendarDays(dayKey, -1);
  return last < startsOn ? null : last;
}

/** Why an occurrence was not booked: its time is taken, or the lane is closed that day. */
export type SkipReason = "CONFLICT" | "CLOSED";
export type SkippedOccurrence = { index: number; dayKey: JerusalemDayKey; reason: SkipReason; conflictingAppointmentIds?: number[] };
