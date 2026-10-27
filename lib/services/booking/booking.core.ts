/**
 * Public booking (Milestone C) — the pure rules. No Prisma, no clock of its own, no environment.
 *
 * The owner's decisions, as code:
 *   D3  a pending request holds its time for 12 hours or until the appointment starts, whichever is first; the owner
 *       is reminded every two hours while it waits — never between 22:00 and 08:00 in its time zone (quiet hours).
 *   D4  a full name and a phone are required; a note is optional; no email.
 *   D8  a staff member is picked by the least appointments that day (ties: the owner's order, then the oldest), or by
 *       the owner's order alone.
 *   D9  a customer may cancel through their link while the business allows it and the window has not closed.
 *   D11 the platform's ceilings are constants here; a business may only be stricter.
 *   Hours (owner decision 2026-10-28): the link offers a time only where the business itself is open — a staff
 *       member's own hours never widen it. The owner's own calendar is not bound by this.
 */
import { createHash, randomBytes } from "node:crypto";

import { insideAvailability, windowsAsIntervals, windowsForDay, type DayException, type WeeklyRule } from "@/lib/services/appointment/availability.core";
import { normalizeCustomerPhone } from "@/lib/services/integrations/whatsapp/phone";
import { jerusalemDayKey } from "@/lib/utils/jerusalem-day";

const HOUR_MS = 60 * 60_000;

/** The platform's security ceilings (D11). A business may lower the per-phone cap; nobody raises these. */
export const PLATFORM_LIMITS = {
  maxOpenRequestsPerPhone: 2,
  submitPerIpPerMinute: 5,
  submitPerIpPerHour: 20,
  submitPerBusinessPerHour: 60,
} as const;

/** D3: the owner is reminded at 2, 4, 6 … hours while a request waits. */
export const REMINDER_INTERVAL_HOURS = 2;
/** D3: a pending request lasts 12 hours at most (BookingSettings.pendingTtlMinutes, 720). */
export const DEFAULT_PENDING_TTL_MINUTES = 720;
/** How long a customer's manage link lives after the appointment starts (to see what happened). */
export const MANAGE_LINK_GRACE_DAYS = 7;

export const PUBLIC_ID = /^[A-Za-z0-9_-]{22,64}$/;
export const MANAGE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** The business's cap, never above the platform's. */
export function effectiveOpenCap(businessCap: number | null | undefined): number {
  const own = Number.isInteger(businessCap) && (businessCap as number) >= 1 ? (businessCap as number) : PLATFORM_LIMITS.maxOpenRequestsPerPhone;
  return Math.min(own, PLATFORM_LIMITS.maxOpenRequestsPerPhone);
}

/** D3: when a pending request lapses — its hold time, or the appointment's start if that is sooner. */
export function requestExpiry(now: Date, startsAt: Date, ttlMinutes: number = DEFAULT_PENDING_TTL_MINUTES): Date {
  return new Date(Math.min(now.getTime() + ttlMinutes * 60_000, startsAt.getTime()));
}

/**
 * Quiet hours (owner decision 2026-10-27): no repeated reminder from 22:00 to 08:00 in the business's time zone. The
 * first notice of a new request is never held (it is the bell, at once); a reminder that falls due in the night waits
 * for 08:00 and goes out once, then the two-hourly rhythm resumes from it. Nothing accumulates and nothing extends the
 * request's expiry.
 */
export const QUIET_HOURS = { startHour: 22, endHour: 8 } as const;
export const DEFAULT_TIME_ZONE = "Asia/Jerusalem";

/** A time zone Intl accepts, else the platform's default. */
export function safeTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return timeZone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number };

function localParts(at: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

/** The instant a wall-clock hour on a local date has in that zone (DST-aware). */
function zonedInstant(year: number, month: number, day: number, hour: number, timeZone: string): Date {
  const wall = Date.UTC(year, month - 1, day, hour);
  let t = wall;
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(t), timeZone);
    const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(t / 60_000) * 60_000;
    t = wall - offset;
  }
  return new Date(t);
}

/** Whether `at` falls in the business's quiet hours (22:00 ≤ local time < 08:00). */
export function isQuietHours(at: Date, timeZone: string): boolean {
  const { hour } = localParts(at, safeTimeZone(timeZone));
  return hour >= QUIET_HOURS.startHour || hour < QUIET_HOURS.endHour;
}

/** The 08:00 that ends the quiet window `at` is in (only meaningful while isQuietHours(at)). */
export function quietHoursEnd(at: Date, timeZone: string): Date {
  const tz = safeTimeZone(timeZone);
  const p = localParts(at, tz);
  const next = p.hour >= QUIET_HOURS.startHour ? new Date(Date.UTC(p.year, p.month - 1, p.day + 1)) : new Date(Date.UTC(p.year, p.month - 1, p.day));
  return zonedInstant(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), QUIET_HOURS.endHour, tz);
}

/** D3 + quiet hours: when the next reminder is due — two hours after the last notice, or at 08:00 if that is night. */
export function nextReminderAt(lastNotifiedAt: Date, timeZone: string): Date {
  const due = new Date(lastNotifiedAt.getTime() + REMINDER_INTERVAL_HOURS * HOUR_MS);
  return isQuietHours(due, timeZone) ? quietHoursEnd(due, timeZone) : due;
}

/**
 * Whether a still-pending request's reminder goes out now: never once it lapsed, never in the night, and only once its
 * next moment came. The anchor is the last notice actually sent, so a night skipped yields one reminder, not many.
 */
export function reminderDue(r: { lastNotifiedAt: Date; expiresAt: Date; now: Date; timeZone: string }): boolean {
  if (r.now.getTime() >= r.expiresAt.getTime()) return false;
  if (isQuietHours(r.now, r.timeZone)) return false;
  return r.now.getTime() >= nextReminderAt(r.lastNotifiedAt, r.timeZone).getTime();
}

/** Whole hours a request has waited (the reminder's wording). */
export function hoursWaiting(createdAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / HOUR_MS));
}

export type AssignmentMode = "BALANCED" | "PRIORITY";
export type StaffCandidate = { id: number; sortOrder: number; dayLoad: number };

/**
 * D8: which free staff member takes the request. Stable: the same inputs always pick the same person.
 *   BALANCED — the fewest active appointments that day; ties by the owner's order, then the lower id;
 *   PRIORITY — the owner's order, then the lower id.
 */
export function chooseStaff(candidates: StaffCandidate[], mode: AssignmentMode): number | null {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) =>
    (mode === "BALANCED" ? a.dayLoad - b.dayLoad : 0) || a.sortOrder - b.sortOrder || a.id - b.id);
  return sorted[0].id;
}

/**
 * Public booking only: is the whole appointment — start to end — inside the business's own open windows that day
 * (its weekly hours, special opening hours and closures)? A staff member's own hours are applied before this and may
 * only narrow the time; a business with no hours at all offers nothing on the link.
 */
export function withinBusinessHours(slot: { startsAt: Date; endsAt: Date }, business: { rules: WeeklyRule[]; exceptions: DayException[] }): boolean {
  const day = jerusalemDayKey(slot.startsAt);
  return insideAvailability(slot.startsAt, slot.endsAt, windowsAsIntervals(day, windowsForDay(day, business.rules, business.exceptions)));
}

/** D9: whether the customer may still cancel, and until when. */
export function selfCancel(policy: { enabled: boolean; windowHours: number }, startsAt: Date, now: Date): { allowed: boolean; until: Date | null } {
  if (!policy.enabled) return { allowed: false, until: null };
  const until = new Date(startsAt.getTime() - policy.windowHours * HOUR_MS);
  return { allowed: now.getTime() <= until.getTime(), until };
}

export type ContactInput = { name?: unknown; phone?: unknown; note?: unknown };
export type Contact = { name: string; phone: string; note: string | null };
export const CONTACT_LIMITS = { nameMin: 2, nameMax: 80, phoneMax: 30, noteMax: 500 } as const;

/** D4: a full name and a phone, an optional note. The phone is stored normalized (972…), as Customer.phone is. */
export function parseContact(input: ContactInput): { ok: true; contact: Contact } | { ok: false; field: "name" | "phone" | "note" } {
  const name = typeof input.name === "string" ? input.name.replace(/\s+/g, " ").trim() : "";
  if (name.length < CONTACT_LIMITS.nameMin || name.length > CONTACT_LIMITS.nameMax || /[<>]/.test(name)) return { ok: false, field: "name" };
  if (typeof input.phone !== "string" || input.phone.length > CONTACT_LIMITS.phoneMax || !/^[\d\s()+.-]+$/.test(input.phone)) return { ok: false, field: "phone" };
  const phone = normalizeCustomerPhone(input.phone);
  if (!phone || phone.length > 15) return { ok: false, field: "phone" };
  let note: string | null = null;
  if (input.note !== undefined && input.note !== null) {
    if (typeof input.note !== "string" || input.note.length > CONTACT_LIMITS.noteMax) return { ok: false, field: "note" };
    note = input.note.trim() || null;
  }
  return { ok: true, contact: { name, phone, note } };
}

/** An opaque booking link id: 24 url-safe characters (18 random bytes) — never derived from the business. */
export function newPublicId(): string {
  return randomBytes(18).toString("base64url");
}

/** A customer's manage token: 32 random bytes (43 url-safe characters). Only its sha256 is stored. */
export function newManageToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** The request's fingerprint (unique per business): the business and the submission's own idempotency key. */
export function requestFingerprint(businessId: number, idempotencyKey: string): string {
  return sha256Hex(`booking:${businessId}:${idempotencyKey}`);
}

/** How long a manage link lives: a week past the start (to see the outcome), within the table's 400-day bound. */
export function manageLinkExpiry(now: Date, startsAt: Date): Date {
  const want = startsAt.getTime() + MANAGE_LINK_GRACE_DAYS * 24 * HOUR_MS;
  const max = now.getTime() + 399 * 24 * HOUR_MS;
  return new Date(Math.max(now.getTime() + HOUR_MS, Math.min(want, max)));
}
