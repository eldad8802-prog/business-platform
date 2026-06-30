/**
 * Business Obligation — pure operational core (WP1).
 *
 * No database, no UI, no HTTP. Given the obligations and "now", it produces the
 * Morning State verdict, the ordered attention items, and the silent set — and
 * computes recurrence and transition rules. This is the product's spine: the
 * canonical Morning State rules (UX Blueprint §0.2) and first-time-trust posture
 * (§0.3) are encoded here, once, in a fully testable place.
 *
 * Copy/Hebrew wording is NOT here — the core returns structured conclusions; the
 * UI owns the words.
 */

import { ValidationError } from "@/lib/errors";
import {
  DEFAULT_ATTENTION_WINDOW_DAYS,
  DEFAULT_CURRENCY,
  type AttentionReason,
  type Briefing,
  type BriefingConfig,
  type BriefingItem,
  type MorningState,
  type ObligationLifecycleState,
  type ObligationRecord,
  type RecurrenceCadence,
} from "./obligations.types";

const DAY_MS = 24 * 60 * 60 * 1000;

// --- Amount + currency normalization (mirrors the payments convention) -----

/** Normalize an amount to a positive, 2-decimal string. */
export function normalizeAmount(amount: string | number): string {
  const num = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(num) || num <= 0) {
    throw new ValidationError("amount must be a positive number");
  }
  return (Math.round(num * 100) / 100).toFixed(2);
}

export function normalizeCurrency(currency: string | undefined): string {
  const value = (currency ?? DEFAULT_CURRENCY).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(value)) {
    throw new ValidationError("currency must be a 3-letter ISO code");
  }
  return value;
}

// --- Calendar helpers (calendar-day boundaries, matching the app's local
//     "today" convention used elsewhere in the inbox feed) ------------------

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

// --- Recurrence ------------------------------------------------------------

/** Add N months, clamping the day to the target month's length
 * (e.g. Jan 31 + 1 month -> Feb 28/29). */
export function addMonthsClamped(date: Date, months: number): Date {
  const year = date.getFullYear();
  const month = date.getMonth() + months;
  const day = date.getDate();
  const targetYear = year + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  const lastDayOfTargetMonth = new Date(
    targetYear,
    targetMonth + 1,
    0
  ).getDate();
  const clampedDay = Math.min(day, lastDayOfTargetMonth);
  return new Date(
    targetYear,
    targetMonth,
    clampedDay,
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds()
  );
}

/** The due moment of the next instance of a recurring obligation, or null if
 * the obligation does not recur. */
export function nextOccurrence(
  dueAt: Date,
  cadence: RecurrenceCadence
): Date | null {
  switch (cadence) {
    case "WEEKLY":
      return new Date(dueAt.getTime() + 7 * DAY_MS);
    case "MONTHLY":
      return addMonthsClamped(dueAt, 1);
    case "YEARLY":
      return addMonthsClamped(dueAt, 12);
    case "NONE":
    default:
      return null;
  }
}

// --- Lifecycle transitions -------------------------------------------------

export function isTerminalState(state: ObligationLifecycleState): boolean {
  return state === "MET" || state === "RELEASED";
}

export type ObligationAction =
  | "UPDATE"
  | "POSTPONE"
  | "COMPLETE"
  | "RELEASE";

/**
 * Guard a lifecycle transition. Throws ValidationError when the action is not
 * allowed from the current state. Completing an already-MET obligation, or
 * releasing an already-RELEASED one, is treated as idempotent (allowed, no-op)
 * by the caller — see `isIdempotentNoop`.
 */
export function assertTransitionAllowed(
  current: ObligationLifecycleState,
  action: ObligationAction
): void {
  if (current === "OPEN") return;
  // Terminal states: only the matching idempotent close is tolerated.
  if (current === "MET" && action === "COMPLETE") return;
  if (current === "RELEASED" && action === "RELEASE") return;
  throw new ValidationError(
    `Cannot ${action.toLowerCase()} an obligation that is already ${current.toLowerCase()}.`
  );
}

/** True when the action is a no-op repeat of an already-reached terminal state. */
export function isIdempotentNoop(
  current: ObligationLifecycleState,
  action: ObligationAction
): boolean {
  return (
    (current === "MET" && action === "COMPLETE") ||
    (current === "RELEASED" && action === "RELEASE")
  );
}

// --- Attention predicates --------------------------------------------------

/** Break-today: OPEN and due today or overdue. "If you do nothing today,
 * something breaks." Always surfaces (Critical) regardless of postponement. */
export function isBreakToday(o: ObligationRecord, now: Date): boolean {
  return o.state === "OPEN" && o.dueAt.getTime() <= endOfDay(now).getTime();
}

function isDueSoon(o: ObligationRecord, now: Date, windowDays: number): boolean {
  if (o.state !== "OPEN") return false;
  const horizon = endOfDay(now).getTime() + windowDays * DAY_MS;
  return o.dueAt.getTime() <= horizon;
}

/** Postponed and still inside the postponement window. */
function isSuppressed(o: ObligationRecord, now: Date): boolean {
  return o.followUpAt != null && o.followUpAt.getTime() > now.getTime();
}

/**
 * Does this obligation need the owner now? OPEN, due within the near window,
 * and not postponed — except a break-today item always needs the owner
 * (postponement can never hide a today-consequence).
 */
export function needsAttention(
  o: ObligationRecord,
  now: Date,
  windowDays: number
): boolean {
  if (o.state !== "OPEN") return false;
  if (isBreakToday(o, now)) return true;
  return isDueSoon(o, now, windowDays) && !isSuppressed(o, now);
}

function attentionReason(o: ObligationRecord, now: Date): AttentionReason {
  const due = o.dueAt.getTime();
  if (due < startOfDay(now).getTime()) return "OVERDUE";
  if (due <= endOfDay(now).getTime()) return "DUE_TODAY";
  return "DUE_SOON";
}

/** Order most-consequential-first: overdue/sooner-due first, larger amount as
 * tiebreak, then stable by id. */
function compareConsequence(a: ObligationRecord, b: ObligationRecord): number {
  const byDue = a.dueAt.getTime() - b.dueAt.getTime();
  if (byDue !== 0) return byDue;
  const byAmount = Number(b.amount) - Number(a.amount);
  if (byAmount !== 0) return byAmount;
  return a.id - b.id;
}

// --- The verdict -----------------------------------------------------------

/**
 * deriveBriefing — the morning conclusion.
 *
 * Canonical rules (Blueprint §0.2, classify by most severe present):
 *   CRITICAL : ≥1 break-today obligation.
 *   BUSY     : no break-today, and >1 obligation needs the owner in the window.
 *   CALM     : no break-today, and ≤1 thing needs the owner.
 * First-time trust (§0.3): a Calm conclusion is only offered as global Calm once
 *   the business is oriented; otherwise it becomes STILL_SETTLING_IN (scoped,
 *   never a false "you're in control"). Busy/Critical are item-driven and honest
 *   regardless of orientation.
 */
export function deriveBriefing(
  obligations: ObligationRecord[],
  now: Date,
  config: BriefingConfig = {}
): Briefing {
  const windowDays = config.attentionWindowDays ?? DEFAULT_ATTENTION_WINDOW_DAYS;
  const oriented = config.oriented ?? false;

  const open = obligations.filter((o) => o.state === "OPEN");

  const attentionRecords: ObligationRecord[] = [];
  const watching: ObligationRecord[] = [];
  let breakTodayCount = 0;

  for (const o of open) {
    if (isBreakToday(o, now)) breakTodayCount += 1;
    if (needsAttention(o, now, windowDays)) {
      attentionRecords.push(o);
    } else {
      watching.push(o);
    }
  }

  attentionRecords.sort(compareConsequence);
  watching.sort(compareConsequence);

  const attention: BriefingItem[] = attentionRecords.map((o) => ({
    obligation: o,
    reason: attentionReason(o, now),
  }));

  // Items that count toward the Busy/Calm threshold exclude break-today ones
  // (those are already Critical).
  const nonCriticalAttention = attentionRecords.length - breakTodayCount;

  let state: MorningState;
  if (breakTodayCount >= 1) {
    state = "CRITICAL";
  } else if (nonCriticalAttention >= 2) {
    state = "BUSY";
  } else {
    state = oriented ? "CALM" : "STILL_SETTLING_IN";
  }

  return {
    state,
    oriented,
    attention,
    watching,
    counts: {
      open: open.length,
      attention: attention.length,
      breakToday: breakTodayCount,
      watching: watching.length,
    },
    generatedAt: now.toISOString(),
  };
}
