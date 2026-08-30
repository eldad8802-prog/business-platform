/**
 * Leads W1 — pure domain core.
 *
 * Deliberately dependency-free: no Prisma, no DB, no `Date.now()` hidden inside
 * a decision. Every function here is a total function of its arguments, so the
 * whole of the Leads lifecycle (validation, status transitions, follow-up
 * due/overdue) is testable without a database and is wired into the BLOCKING
 * CI-1 job — the same treatment the IMPL-2 evidence-adapter boundary gets.
 *
 * Follow-up is evaluated at READ time from a single stored timestamp. There is
 * no scheduler, worker, queue or cron behind it — the identical cron-free shape
 * the Payment Secretary already proves in
 * `lib/services/obligations/obligation-core.ts` (`isBreakToday` / `needsAttention`).
 */

import { ValidationError } from "@/lib/errors";

/* ------------------------------------------------------------------ status -- */

/**
 * The EXISTING `LeadStatus` vocabulary, reused verbatim. Nothing is renamed and
 * nothing is added: the enum already expresses a complete small-business
 * pipeline, and renaming a value would be a non-reversible schema change bought
 * for nothing but taste.
 *
 *   NEW        — arrived, nobody has touched it yet
 *   OPEN       — the owner has made contact and is working it
 *   QUALIFIED  — there is a real need and a real budget
 *   QUOTED     — a price has gone out
 *   WON        — closed, we got it
 *   LOST       — closed, we did not get it (competitor, budget, timing)
 *   DROPPED    — closed, it was never a real lead (spam, mistake, wrong number)
 *
 * WON / LOST / DROPPED are TERMINAL. `DROPPED` is kept distinct from `LOST` on
 * purpose: a dropped lead must not sit in the denominator of a conversion rate.
 */
export const LEAD_STATUSES = [
  "NEW",
  "OPEN",
  "QUALIFIED",
  "QUOTED",
  "WON",
  "LOST",
  "DROPPED",
] as const;

export type LeadStatusValue = (typeof LEAD_STATUSES)[number];

/** Terminal statuses. Mirrors the `Lead_open_phone_key` partial-index predicate. */
export const CLOSED_LEAD_STATUSES: readonly LeadStatusValue[] = [
  "WON",
  "LOST",
  "DROPPED",
] as const;

/** Open statuses — the complement of {@link CLOSED_LEAD_STATUSES}. */
export const OPEN_LEAD_STATUSES: readonly LeadStatusValue[] = LEAD_STATUSES.filter(
  (s) => !CLOSED_LEAD_STATUSES.includes(s)
);

export function isLeadStatus(value: unknown): value is LeadStatusValue {
  return (
    typeof value === "string" &&
    (LEAD_STATUSES as readonly string[]).includes(value)
  );
}

export function isClosedLeadStatus(status: LeadStatusValue): boolean {
  return CLOSED_LEAD_STATUSES.includes(status);
}

/** Hebrew display labels — the single source for every Leads surface. */
export const LEAD_STATUS_LABELS: Record<LeadStatusValue, string> = {
  NEW: "חדש",
  OPEN: "בטיפול",
  QUALIFIED: "מתאים",
  QUOTED: "נשלחה הצעה",
  WON: "נסגר בהצלחה",
  LOST: "לא נסגר",
  DROPPED: "לא רלוונטי",
};

export function parseLeadStatus(value: unknown): LeadStatusValue {
  if (!isLeadStatus(value)) {
    throw new ValidationError(
      `status must be one of: ${LEAD_STATUSES.join(", ")}`
    );
  }
  return value;
}

export type LeadStatusTransition = {
  /** True when `from === to` — the caller should treat it as a no-op, not an error. */
  noop: boolean;
  /** True when the lead moves from an open status into a terminal one. */
  closing: boolean;
  /** True when the lead comes back out of a terminal status. */
  reopening: boolean;
};

/**
 * Classify a status change.
 *
 * W1 is deliberately PERMISSIVE about direction: a small-business owner does not
 * work a rigid funnel, and refusing "QUOTED back to OPEN" would only teach them
 * to distrust the screen. What the rules DO guarantee is that every move is a
 * known status, that closing stamps `closedAt`, and that reopening clears it —
 * so the derived analytics can never see a lead that is both open and closed.
 *
 * Reopening is allowed here, but it can still be refused downstream by the
 * `Lead_open_phone_key` partial unique index if another OPEN lead already holds
 * that phone. That refusal belongs to the database, not to this function.
 */
export function classifyLeadStatusTransition(
  from: LeadStatusValue,
  to: LeadStatusValue
): LeadStatusTransition {
  if (from === to) {
    return { noop: true, closing: false, reopening: false };
  }
  return {
    noop: false,
    closing: !isClosedLeadStatus(from) && isClosedLeadStatus(to),
    reopening: isClosedLeadStatus(from) && !isClosedLeadStatus(to),
  };
}

/* -------------------------------------------------------------- validation -- */

export const LEAD_NAME_MAX = 200;
export const LEAD_EMAIL_MAX = 200;
export const LEAD_INTENT_MAX = 2000;
export const LEAD_SOURCE_MAX = 60;
export const LEAD_FOLLOWUP_NOTE_MAX = 500;
export const LEAD_LOST_REASON_MAX = 500;

/**
 * Pragmatic single-address email shape: something before an `@`, a dotted
 * domain after it, no whitespace, no second `@`. Deliberately NOT the RFC 5322
 * grammar — the job here is to reject `not-an-email`, which the platform used to
 * store silently, not to litigate exotic-but-legal addresses.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function normalizeLeadName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError("name is required");
  }
  const trimmed = value.trim();
  if (trimmed.length > LEAD_NAME_MAX) {
    throw new ValidationError(`name must be at most ${LEAD_NAME_MAX} characters`);
  }
  return trimmed;
}

/**
 * Optional free text: trims, treats blank/whitespace-only as absent (null), and
 * enforces a length ceiling.
 */
export function normalizeLeadOptionalText(
  value: unknown,
  field: string,
  max: number
): string | null {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new ValidationError(`${field} must be a string or null`);
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) {
    throw new ValidationError(`${field} must be at most ${max} characters`);
  }
  return trimmed;
}

/**
 * Email is either absent or VALID — never silently kept as junk.
 *
 * This is the behavior change the audit asked for: `Customer.email` accepts any
 * string today, so `not-an-email` reaches the database. Leads refuses it at the
 * edge instead of storing a value nobody can ever send mail to.
 */
export function normalizeLeadEmail(value: unknown): string | null {
  const trimmed = normalizeLeadOptionalText(value, "email", LEAD_EMAIL_MAX);
  if (trimmed === null) return null;
  const lowered = trimmed.toLowerCase();
  if (!EMAIL_RE.test(lowered)) {
    throw new ValidationError("email is not a valid address");
  }
  return lowered;
}

/**
 * Parse an ISO-8601 instant for a follow-up. Rejects junk and absurd dates so a
 * typo can never park a reminder in year 9999.
 */
export function parseFollowUpAt(value: unknown, now: Date): Date {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError("followUpAt is required (ISO date string)");
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError("followUpAt must be a valid date");
  }
  const tenYears = 10 * 365 * 24 * 60 * 60 * 1000;
  if (parsed.getTime() > now.getTime() + tenYears) {
    throw new ValidationError("followUpAt is too far in the future");
  }
  return parsed;
}

/* --------------------------------------------------------------- follow-up -- */

/**
 * The business runs on Israel time, so "overdue" is a CALENDAR-DAY question in
 * `Asia/Jerusalem` — not a raw millisecond comparison and not the server's
 * locale. Comparing formatted `YYYY-MM-DD` day keys sidesteps DST arithmetic
 * entirely: two instants are the same day iff their day keys match.
 */
export const LEAD_TIME_ZONE = "Asia/Jerusalem";

const DAY_KEY_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: LEAD_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** `YYYY-MM-DD` for an instant, as seen in Israel. */
export function leadDayKey(instant: Date): string {
  return DAY_KEY_FORMATTER.format(instant);
}

/** Whole calendar days from `a` to `b` (negative when `b` is earlier). */
function dayKeyDelta(a: string, b: string): number {
  const toUtc = (key: string) => {
    const [y, m, d] = key.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

const OFFSET_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: LEAD_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Israel's UTC offset in ms at a given instant (+2h winter, +3h summer). */
function leadTimeZoneOffsetMs(instant: Date): number {
  const parts = OFFSET_FORMATTER.formatToParts(instant);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asIfUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second")
  );
  return asIfUtc - instant.getTime();
}

/**
 * The last instant of TODAY in Israel, as a UTC `Date` — the exact boundary a
 * "is this follow-up due?" SQL filter needs, so the database can do the
 * filtering (and therefore paginate correctly) instead of the caller
 * over-fetching and trimming in JS.
 *
 * Two-pass offset resolution: the offset is sampled once at `now` to guess the
 * boundary, then re-sampled AT that guess. A DST change moves the clock at most
 * once in the window, so the second pass always lands on the true boundary.
 */
export function endOfLeadDayUtc(now: Date): Date {
  const [y, m, d] = leadDayKey(now).split("-").map(Number);
  const nextLocalMidnightUtcFields = Date.UTC(y, m - 1, d + 1);
  let instant = nextLocalMidnightUtcFields - leadTimeZoneOffsetMs(now);
  instant =
    nextLocalMidnightUtcFields - leadTimeZoneOffsetMs(new Date(instant));
  return new Date(instant - 1);
}

export type LeadFollowUpState =
  | { kind: "none" }
  | { kind: "scheduled"; at: string; inDays: number }
  | { kind: "due_today"; at: string }
  | { kind: "overdue"; at: string; overdueDays: number };

/**
 * Derive the follow-up state from the single stored timestamp.
 *
 * Nothing here is persisted: `due_today` and `overdue` exist only for as long as
 * the read that produced them. That is what makes duplicate reminders
 * structurally impossible — there is no reminder record to fire twice.
 */
export function evaluateLeadFollowUp(
  nextFollowUpAt: Date | null | undefined,
  now: Date
): LeadFollowUpState {
  if (!nextFollowUpAt) return { kind: "none" };

  const at = nextFollowUpAt.toISOString();
  const delta = dayKeyDelta(leadDayKey(now), leadDayKey(nextFollowUpAt));

  if (delta < 0) return { kind: "overdue", at, overdueDays: -delta };
  if (delta === 0) return { kind: "due_today", at };
  return { kind: "scheduled", at, inDays: delta };
}

/**
 * Does this lead want the owner right now? True for a follow-up that is due
 * today or already overdue — and only while the lead is still open, because a
 * closed lead can never need chasing.
 */
export function leadNeedsAttention(
  input: { status: LeadStatusValue; nextFollowUpAt: Date | null | undefined },
  now: Date
): boolean {
  if (isClosedLeadStatus(input.status)) return false;
  const state = evaluateLeadFollowUp(input.nextFollowUpAt, now);
  return state.kind === "due_today" || state.kind === "overdue";
}

/** Short Hebrew phrase for the follow-up chip. Empty string when there is none. */
export function leadFollowUpLabel(state: LeadFollowUpState): string {
  switch (state.kind) {
    case "none":
      return "";
    case "due_today":
      return "מעקב היום";
    case "overdue":
      return state.overdueDays === 1
        ? "מעקב באיחור יום"
        : `מעקב באיחור ${state.overdueDays} ימים`;
    case "scheduled":
      return state.inDays === 1 ? "מעקב מחר" : `מעקב בעוד ${state.inDays} ימים`;
  }
}
