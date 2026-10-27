/**
 * Public booking page (Milestone C, segment 3) — the pure rules of the customer's screens. No React, no fetch.
 *
 * Mirrors what the server decides, never replaces it: every value here is checked again by the server under the
 * business's appointment lock. Hebrew only (owner rule for new screens), Asia/Jerusalem throughout.
 */
import { addCalendarDays, dayKeyToStableInstant, jerusalemDayKey, ISRAEL_TIME_ZONE, type JerusalemDayKey } from "@/lib/utils/jerusalem-day";

export type PriceWire = { mode: "FIXED" | "FROM" | "RANGE" | "QUOTE_REQUIRED" | "NO_PUBLIC_PRICE"; amount: number; max: number | null; currency: string } | null;
export type StaffWire = { id: number; name: string; color: string | null };
export type ServiceWire = { id: number; name: string; durationMinutes: number; approval: "MANUAL" | "AUTO"; price?: PriceWire; staff?: StaffWire[] };
export type ProfileWire = {
  business: { name: string; city?: string | null; address?: string | null; category?: string | null; phone?: string | null };
  staffChoice: "NONE" | "OPTIONAL" | "REQUIRED";
  selfCancel: { enabled: boolean; windowHours: number };
  services: ServiceWire[];
};
export type SlotsWire = { durationMinutes: number; slots: { startsAt: string }[] };
export type SubmitWire = {
  status: "PENDING" | "CONFIRMED";
  replayed: boolean;
  startsAt: string;
  endsAt: string;
  serviceName: string;
  staffName: string | null;
  expiresAt: string | null;
  manageToken: string;
  selfCancelUntil: string | null;
};
export type ManageState = "PENDING" | "CONFIRMED" | "DECLINED" | "EXPIRED" | "CANCELED" | "COMPLETED" | "NO_SHOW";
export type ManageWire = {
  state: ManageState;
  startsAt: string | null;
  serviceName: string;
  staffName: string | null;
  businessName: string;
  expiresAt: string | null;
  canCancel: boolean;
  cancelUntil: string | null;
};

/** The same limits the server applies (booking.core CONTACT_LIMITS). */
export const CONTACT = { nameMin: 2, nameMax: 80, phoneMax: 30, noteMax: 500 } as const;
/** A week of days at a time; the server accepts up to 31 per request. */
export const WEEK = 7;

// ── Steps ────────────────────────────────────────────────────────────────────────────────────

export type Step = "service" | "staff" | "time" | "details";

/** D7/D8: the staff step appears only when the business lets the customer choose and shows who works there. */
export function stepsFor(profile: Pick<ProfileWire, "staffChoice">, service: Pick<ServiceWire, "staff"> | null): Step[] {
  const choose = profile.staffChoice !== "NONE" && (service?.staff?.length ?? 0) > 0;
  return choose ? ["service", "staff", "time", "details"] : ["service", "time", "details"];
}

/** REQUIRED with no staff the customer can see (names hidden by the business) cannot be booked from the link. */
export function serviceBookable(profile: Pick<ProfileWire, "staffChoice">, service: Pick<ServiceWire, "staff">): boolean {
  return profile.staffChoice !== "REQUIRED" || (service.staff?.length ?? 0) > 0;
}

// ── Labels ───────────────────────────────────────────────────────────────────────────────────

export function durationLabel(min: number): string {
  if (min < 60) return `${min} דק׳`;
  const h = Math.floor(min / 60), m = min % 60;
  const hours = h === 1 ? "שעה" : h === 2 ? "שעתיים" : `${h} שעות`;
  if (m === 0) return hours;
  if (m === 30) return `${hours} וחצי`;
  return `${hours} ו־${m} דק׳`;
}

const ils = (n: number) => `₪${Number.isInteger(n) ? n : n.toFixed(2)}`;

/** D10: shown only when the business shows prices; a price it keeps private reads as nothing. */
export function priceLabel(p: PriceWire | undefined): string | null {
  if (!p) return null;
  switch (p.mode) {
    case "FIXED": return p.amount === 0 ? "ללא עלות" : ils(p.amount);
    case "FROM": return `החל מ־${ils(p.amount)}`;
    case "RANGE": return p.max !== null ? `${ils(p.amount)}–${ils(p.max)}` : `החל מ־${ils(p.amount)}`;
    case "QUOTE_REQUIRED": return "המחיר נקבע בעסק";
    default: return null;
  }
}

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("he-IL", { timeZone: ISRAEL_TIME_ZONE, ...opts });
const CLOCK = fmt({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const WEEKDAY = fmt({ weekday: "short" });
const DAYNUM = fmt({ day: "numeric" });
const LONGDAY = fmt({ weekday: "long", day: "numeric", month: "long" });
const SHORTDATE = fmt({ weekday: "short", day: "numeric", month: "numeric" });

export const clock = (iso: string) => CLOCK.format(new Date(iso));
export const longDay = (day: JerusalemDayKey) => LONGDAY.format(dayKeyToStableInstant(day));
/** "יום ג׳ 3.11 · 10:30" */
export const whenShort = (iso: string) => `${SHORTDATE.format(new Date(iso))} · ${clock(iso)}`;
/** "יום שלישי, 3 בנובמבר · 10:30–11:15" */
export function whenLong(startIso: string, endIso?: string | null): string {
  const d = new Date(startIso);
  return `${LONGDAY.format(d)} · ${clock(startIso)}${endIso ? `–${clock(endIso)}` : ""}`;
}

export type DayCell = { day: JerusalemDayKey; weekday: string; num: string; count: number; today: boolean };

/** The day strip: `WEEK` days from `start`, with how many free starts each holds. */
export function weekDays(start: JerusalemDayKey, slots: SlotsWire["slots"], now: Date): DayCell[] {
  const byDay = slotsByDay(slots);
  const today = jerusalemDayKey(now);
  return Array.from({ length: WEEK }, (_, i) => {
    const day = addCalendarDays(start, i);
    const at = dayKeyToStableInstant(day);
    return { day, weekday: WEEKDAY.format(at), num: DAYNUM.format(at), count: byDay.get(day)?.length ?? 0, today: day === today };
  });
}

export function slotsByDay(slots: SlotsWire["slots"]): Map<JerusalemDayKey, string[]> {
  const out = new Map<JerusalemDayKey, string[]>();
  for (const s of slots) {
    const d = jerusalemDayKey(new Date(s.startsAt));
    out.set(d, [...(out.get(d) ?? []), s.startsAt]);
  }
  for (const v of out.values()) v.sort();
  return out;
}

/** The first day of the week that has a free start, else null. */
export function firstOpenDay(cells: DayCell[]): JerusalemDayKey | null {
  return cells.find((c) => c.count > 0)?.day ?? null;
}

/** A time taken while the customer was filling in: the `n` free starts nearest to it (same service and staff). */
export function nearestAlternatives(slots: SlotsWire["slots"], takenIso: string, n = 3): string[] {
  const t = new Date(takenIso).getTime();
  return slots
    .map((s) => s.startsAt)
    .filter((s) => s !== takenIso)
    .sort((a, b) => Math.abs(new Date(a).getTime() - t) - Math.abs(new Date(b).getTime() - t) || a.localeCompare(b))
    .slice(0, n)
    .sort();
}

// ── The customer's details (D4) ─────────────────────────────────────────────────────────────

export type ContactErrors = Partial<Record<"name" | "phone" | "note", string>>;

/** The form's own check, before anything is sent. The server decides again (and normalizes the phone). */
export function checkContact(name: string, phone: string, note: string): ContactErrors {
  const errs: ContactErrors = {};
  const n = name.replace(/\s+/g, " ").trim();
  if (n.length < CONTACT.nameMin) errs.name = "צריך שם מלא (לפחות שתי אותיות).";
  else if (n.length > CONTACT.nameMax) errs.name = `השם ארוך מדי (עד ${CONTACT.nameMax} תווים).`;
  else if (/[<>]/.test(n)) errs.name = "השם מכיל תווים שאי אפשר להשתמש בהם.";
  const digits = phone.replace(/\D/g, "");
  if (!phone.trim()) errs.phone = "צריך מספר טלפון.";
  else if (phone.length > CONTACT.phoneMax || !/^[\d\s()+.-]+$/.test(phone) || digits.length < 9 || digits.length > 15) errs.phone = "מספר הטלפון לא נראה תקין.";
  if (note.length > CONTACT.noteMax) errs.note = `ההערה ארוכה מדי (עד ${CONTACT.noteMax} תווים).`;
  return errs;
}

// ── Answers ──────────────────────────────────────────────────────────────────────────────────

export type ErrorKind = "unavailable" | "taken" | "limit" | "busy" | "field" | "closed" | "generic";

/** What a refusal means to the customer; the server's own Hebrew message wins when it sent one. */
export function classify(status: number, code: string | undefined): ErrorKind {
  if (status === 404 || code === "NOT_FOUND") return "unavailable";
  if (code === "SLOT_UNAVAILABLE") return "taken";
  if (code === "REQUEST_LIMIT") return "limit";
  if (status === 429 || status === 503 || code === "rate_limit_unavailable" || code === "rate_limited") return "busy";
  if (code === "SELF_CANCEL_CLOSED") return "closed";
  if (code === "INVALID_INPUT") return "field";
  return "generic";
}

const FALLBACK: Record<ErrorKind, string> = {
  unavailable: "הקישור אינו זמין.",
  taken: "השעה הזו כבר לא פנויה. אפשר לבחור שעה אחרת.",
  limit: "יש כבר בקשות פתוחות מהמספר הזה. אפשר לחכות לתשובת העסק.",
  busy: "השירות עמוס כרגע. אפשר לנסות שוב בעוד רגע.",
  field: "חלק מהפרטים לא תקינים. כדאי לבדוק ולנסות שוב.",
  closed: "כבר אי אפשר לבטל דרך הקישור. אפשר לפנות לעסק ישירות.",
  generic: "משהו השתבש. אפשר לנסות שוב בעוד רגע.",
};

export function errorText(kind: ErrorKind, serverMessage?: unknown): string {
  return typeof serverMessage === "string" && serverMessage.trim() ? serverMessage : FALLBACK[kind];
}

/** The details form's field the server named (INVALID_INPUT details.field), in the form's terms. */
export function fieldOf(details: unknown): "name" | "phone" | "note" | null {
  const f = (details as { field?: unknown } | null)?.field;
  return f === "name" || f === "phone" || f === "note" ? f : null;
}

// ── The customer's own link (D9, D12) ───────────────────────────────────────────────────────

export const MANAGE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** The token travels in the URL fragment, which a browser never sends to a server. */
export const manageUrl = (origin: string, token: string) => `${origin}/book/manage#${token}`;

export function tokenFromHash(hash: string): string | null {
  const t = hash.replace(/^#/, "").replace(/^t=/, "");
  return MANAGE_TOKEN.test(t) ? t : null;
}

export const STATE_LABEL: Record<ManageState, string> = {
  PENDING: "ממתינה לאישור העסק",
  CONFIRMED: "התור נקבע",
  DECLINED: "העסק לא אישר את הבקשה",
  EXPIRED: "הבקשה פגה בלי תשובה",
  CANCELED: "התור בוטל",
  COMPLETED: "התור התקיים",
  NO_SHOW: "התור הסתיים",
};

export type Tone = "wait" | "ok" | "off";
export const STATE_TONE: Record<ManageState, Tone> = {
  PENDING: "wait", CONFIRMED: "ok", DECLINED: "off", EXPIRED: "off", CANCELED: "off", COMPLETED: "ok", NO_SHOW: "off",
};

// ── The request's idempotency key ───────────────────────────────────────────────────────────

/** A UUIDv7 (time-ordered): one per attempt, reused if the same attempt is sent again (a double tap, a retry). */
export function newRequestKey(nowMs = Date.now(), rnd: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const b = rnd(16);
  let ms = nowMs;
  for (let i = 5; i >= 0; i -= 1) { b[i] = ms % 256; ms = Math.floor(ms / 256); }
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
