/**
 * Calendar daily use (G7, G8) — the pure rules behind the closure ranges and the appointment search. No I/O.
 *
 *   expandDayRange       from–to (whole Israeli days, inclusive) → each day, capped at MAX_CLOSURE_DAYS;
 *   normalizeSearchQuery what the owner typed → a name fragment, or the phone digits to look for (min 2 characters).
 */
import { addCalendarDays } from "@/lib/utils/jerusalem-day";

import { invalid } from "./appointment-errors";
import { isDayKey } from "./availability.core";
import { resolveHolidayId, type HolidayDay } from "./israeli-holidays";

/** The longest closure one request may write (one row per day, one transaction). */
export const MAX_CLOSURE_DAYS = 62;

/** Each day from `fromDay` to `toDay` inclusive; null when the range is not valid or longer than `cap` days. */
export function expandDayRange(fromDay: unknown, toDay: unknown, cap = MAX_CLOSURE_DAYS): string[] | null {
  if (!isDayKey(fromDay) || !isDayKey(toDay) || toDay < fromDay) return null;
  const days: string[] = [];
  for (let d = fromDay as string; d <= (toDay as string); d = addCalendarDays(d, 1)) {
    days.push(d);
    if (days.length > cap) return null;
  }
  return days;
}

export const SEARCH_MIN_CHARS = 2;
export const SEARCH_MAX_CHARS = 60;
export const SEARCH_MAX_RESULTS = 30;

export type SearchQuery = { text: string; digits: string | null };

/**
 * The query as the search uses it, or null when it is too short / too long. A query made only of phone characters
 * (digits, spaces, + - ( ) .) searches phones by their digits, in the stored canonical form (972…): a leading 00 is
 * dropped, and a leading local 0 is dropped so "050…" finds "97250…". Any query also searches names (as typed).
 */
export function normalizeSearchQuery(raw: unknown): SearchQuery | null {
  if (typeof raw !== "string") return null;
  const text = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  if (text.length < SEARCH_MIN_CHARS || text.length > SEARCH_MAX_CHARS) return null;
  let digits: string | null = null;
  if (/^[\d\s+().-]+$/.test(text)) {
    let d = text.replace(/\D/g, "");
    if (d.startsWith("00")) d = d.slice(2);
    else if (d.startsWith("0")) d = d.slice(1);
    digits = d.length >= SEARCH_MIN_CHARS ? d : null;
    if (digits === null) return null;
  }
  return { text, digits };
}

/** One closure to write: a whole day (no minutes) or closed from `startMinute` to the end of the day (an eve). */
export type ClosurePlan = { dayKey: string; startMinute: number | null; endMinute: number | null; label: string | null };

/** The closures a holiday selection means: holidays all day, eves from the closing time; past days are left out. */
export function holidayPlans(ids: unknown, eveClosingMinute: unknown, today: string): ClosurePlan[] {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 80) throw invalid("holidays");
  if (typeof eveClosingMinute !== "number" || !Number.isInteger(eveClosingMinute) || eveClosingMinute < 360 || eveClosingMinute > 1380) throw invalid("eveClosingMinute");
  const chosen: HolidayDay[] = [];
  for (const id of ids) {
    const h = resolveHolidayId(id);
    if (!h) throw invalid("holidays");
    if (!chosen.some((c) => c.id === h.id)) chosen.push(h);
  }
  const plans = chosen
    .filter((h) => h.dayKey >= today)
    .sort((a, b) => a.dayKey.localeCompare(b.dayKey))
    .map((h) => ({ dayKey: h.dayKey, startMinute: h.eve ? eveClosingMinute : null, endMinute: h.eve ? 1440 : null, label: h.name }));
  if (plans.length > MAX_CLOSURE_DAYS) throw invalid("holidays");
  return plans;
}
