/**
 * The selected day, as Home renders it.
 *
 * The server answers in Israeli calendar days (`/api/home/day`); this turns
 * that answer into what the screen needs — a label, a set of 24 numbers, and
 * the honest load state around them.
 *
 * TRUTH RULES, all of them load-bearing:
 *   - a failed read is `failed`, never a zero day;
 *   - a real zero day is `ready` with a total of 0, and says so in words;
 *   - `elapsedHours` is only set for TODAY, so a quiet evening can be drawn as
 *     "not yet" rather than as "nothing came in";
 *   - the future does not exist: the navigation cannot move past today.
 */

import { jerusalemDayKey, jerusalemHour } from "@/lib/utils/jerusalem-day";

export type HomeDayView =
  | { state: "loading" }
  | { state: "failed" }
  | {
      state: "ready";
      /** ₪ in each Israeli hour of the selected day. */
      hours: number[];
      total: number;
      count: number;
      /** The month this day sits in — null when it was not requested. */
      month: { amount: number; count: number; changePct: number | null } | null;
      /** Today's activity — null when it was not requested. */
      activity: { invoicesIssued: number; newLeads: number } | null;
      /** The last Israeli hour that has happened, or null when not today. */
      elapsedHours: number | null;
    };

export type DayNavigation = {
  /** 0 = today, −1 = yesterday. Never positive. */
  offset: number;
  goEarlier: () => void;
  goLater: () => void;
  goToday: () => void;
};

/** The wire shape of `GET /api/home/day`. */
export type HomeDayWire = {
  timezone: string;
  date: string;
  isToday: boolean;
  day: { hours: string[]; total: string; count: number; complete: boolean };
  month: {
    key: string;
    amount: string;
    count: number;
    previousAmount: string;
    previousCount: number;
    changePct: number | null;
  } | null;
  activity: { invoicesIssued: number; newLeads: number } | null;
};

export function dayViewFrom(wire: HomeDayWire, now = new Date()): HomeDayView {
  return {
    state: "ready",
    hours: wire.day.hours.map(Number),
    total: Number(wire.day.total),
    count: wire.day.count,
    month: wire.month
      ? {
          amount: Number(wire.month.amount),
          count: wire.month.count,
          changePct: wire.month.changePct,
        }
      : null,
    activity: wire.activity,
    elapsedHours: wire.isToday ? jerusalemHour(now) : null,
  };
}

/**
 * Carries the month and activity from the full read across a day change.
 *
 * Day navigation asks for the day alone, because the month context and today's
 * activity did not change when the owner looked at yesterday. Without this the
 * two figures would blink out and back — which would read as "they changed".
 */
export function withCarriedContext(next: HomeDayView, previous: HomeDayView): HomeDayView {
  if (next.state !== "ready" || previous.state !== "ready") return next;
  return {
    ...next,
    month: next.month ?? previous.month,
    activity: next.activity ?? previous.activity,
  };
}

export type DayLabel = { title: string; short: string };

/**
 * "היום" · "אתמול" · a real Hebrew date. Never a guessed range, and never a
 * relative phrase like "לפני 3 ימים" that the owner would have to decode.
 */
export function dayLabel(offset: number, now = new Date()): DayLabel {
  if (offset === 0) return { title: "נגבה דרך Dubiz היום", short: "היום" };
  if (offset === -1) return { title: "נגבה דרך Dubiz אתמול", short: "אתמול" };
  const date = new Date(now);
  date.setDate(date.getDate() + offset);
  const text = date.toLocaleDateString("he-IL", { day: "numeric", month: "long" });
  const weekday = date.toLocaleDateString("he-IL", { weekday: "long" });
  return { title: `נגבה דרך Dubiz ב${text}`, short: `${weekday}, ${text}` };
}

/** The Israeli day key `offset` days before today. */
export function dayKeyForOffset(offset: number, now = new Date()): string {
  const date = new Date(now);
  date.setDate(date.getDate() + offset);
  return jerusalemDayKey(date);
}
