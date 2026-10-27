/**
 * Public booking (Milestone C) — the pure rules. No Prisma, no clock of its own, no environment.
 *
 * The owner's decisions, as code:
 *   D3  a pending request holds its time for 12 hours or until the appointment starts, whichever is first; the owner
 *       is reminded every two hours while it waits.
 *   D4  a full name and a phone are required; a note is optional; no email.
 *   D8  a staff member is picked by the least appointments that day (ties: the owner's order, then the oldest), or by
 *       the owner's order alone.
 *   D9  a customer may cancel through their link while the business allows it and the window has not closed.
 *   D11 the platform's ceilings are constants here; a business may only be stricter.
 */
import { createHash, randomBytes } from "node:crypto";

import { normalizeCustomerPhone } from "@/lib/services/integrations/whatsapp/phone";

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

/** D3: how many reminders are due by now (0 before the first two hours). */
export function reminderOrdinal(createdAt: Date, now: Date): number {
  const ms = now.getTime() - createdAt.getTime();
  return ms <= 0 ? 0 : Math.floor(ms / (REMINDER_INTERVAL_HOURS * HOUR_MS));
}

/** The moment reminder `k` becomes due. */
export function reminderDueAt(createdAt: Date, k: number): Date {
  return new Date(createdAt.getTime() + k * REMINDER_INTERVAL_HOURS * HOUR_MS);
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
