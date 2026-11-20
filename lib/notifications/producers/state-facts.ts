/**
 * State producers A–E — the PURE half (owner decisions 2026-11-13). No database, no network, no clock of its own.
 *
 * Each producer turns the REAL current state of one business (read elsewhere, read-only) into:
 *   events   the notify() events to record now (the engine dedupes by key and enforces the catalog cooldown), and
 *   present  the dedupe keys of every fact that is still true — the runner resolves this producer's open rows whose
 *            key is absent, ONLY when the read was complete.
 * A key encodes everything whose change must count as a new fact: the stage of an overdue obligation, the start time
 * of an appointment, the kind of an allocation problem. So a reminder is never re-sent without a reason, a
 * rescheduled appointment follows its new time, and a handled fact simply stops being present (resolved).
 *
 *   A obligations.due              due day + measured overdue stages (1, 3, 7, then weekly); postponed ⇒ not present
 *   B payments.request_failed      terminal FAILED (on a sent link) or expired > 24 h unpaid; never when the money
 *                                  arrived by another path or the owner already re-asked / cancelled
 *   C billing.allocation_failed    FAILED / REJECTED / outcome uncertain / HELD undecided / stuck > 60 min; only
 *                                  with the PRODUCTION integration on (the runner's gate)
 *   D documents.processing_failed  status `failed` (the pipeline never retries by itself), or STUCK: still
 *                                  `processing` more than DOCUMENT_STUCK_MS after the attempt started
 *                                  (Document.statusChangedAt, stamped by the database); never during an attempt
 *   E appointments.upcoming        CONFIRMED; ONE reminder per user per appointment start, at that user's own lead
 *                                  time (NotificationSettings.appointmentReminderMinutes, default 60), owed for the
 *                                  exact moment (nextAttemptAt) so the 5-minute worker — not the sweep — times it;
 *                                  cancelled / moved / lead changed ⇒ absent (resolved)
 *
 * Stored title / summary are generic too (no customer, payee, amount or number); the push uses the catalog's
 * lock-screen text unless the user opted into details.
 */
import type { CategoryKey } from "../catalog";
import type { NotifyEvent } from "../engine/notify";
import { addDaysToKey, localDayKey, localMinuteOfDay, localParts, wallClockToInstant } from "../notification-time";
import { daysBetweenDayKeys } from "@/lib/utils/jerusalem-day";

export type StateFacts = { events: NotifyEvent[]; present: string[] };

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const key = (category: CategoryKey, ...parts: (string | number)[]) => `st:${category}:${parts.join(":")}`;

function event(businessId: number, category: CategoryKey, dedupeKey: string, entity: { type: string; id: number }, title: string, summary: string, href: string, reason: string, now: Date): NotifyEvent {
  return { businessId, category, entity, dedupeKey, title, summary, href, userId: null, reason, now };
}

/* ────────────────────────────────────────────────────────── A. obligations ── */

export type ObligationFact = {
  /** business_obligation (legacy secretary store) or installment (payables ledger). */
  entityType: "business_obligation" | "installment";
  id: number;
  /** OPEN in the real store (obligation-store.prisma / obligation-store.ledger toObligationRecord). */
  state: "OPEN" | "MET" | "RELEASED";
  dueAt: Date;
  followUpAt: Date | null;
  href: string;
};

/**
 * The overdue stage of an obligation `days` calendar days after its due day, or null (not due yet).
 *   0 → "due"; 1–2 → "late1"; 3–6 → "late3"; 7–13 → "late7"; then weekly: "late14", "late21", …
 */
export function obligationStage(days: number): string | null {
  if (!Number.isFinite(days) || days < 0) return null;
  if (days === 0) return "due";
  if (days < 3) return "late1";
  if (days < 7) return "late3";
  return `late${7 * Math.floor(days / 7)}`;
}

export function obligationFacts(businessId: number, rows: readonly ObligationFact[], now: Date, timeZone: string): StateFacts {
  const today = localDayKey(now, timeZone);
  const out: StateFacts = { events: [], present: [] };
  for (const o of rows) {
    if (o.state !== "OPEN") continue;
    // Postponed by the owner ("remind me later"): handled for now; the next stage after the postponement ends.
    if (o.followUpAt !== null && o.followUpAt.getTime() > now.getTime()) continue;
    const dueDay = localDayKey(o.dueAt, timeZone);
    const stage = obligationStage(daysBetweenDayKeys(dueDay, today));
    if (stage === null) continue;
    const k = key("obligations.due", o.entityType, o.id, dueDay, stage);
    out.present.push(k);
    out.events.push(event(
      businessId, "obligations.due", k, { type: o.entityType, id: o.id },
      stage === "due" ? "יש תשלום שמגיע היום" : "יש תשלום שעבר מועד הפירעון",
      "אפשר לסמן ששולם, לדחות או לפתוח את הפרטים.",
      o.href, `obligation_${stage}`, now,
    ));
  }
  return out;
}

/* ─────────────────────────────────────────────────────────── B. payments ── */

export type PaymentRequestFact = {
  id: number;
  status: "PENDING" | "PAID" | "FAILED" | "CANCELLED" | "EXPIRED";
  paymentUrl: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  billingDocumentId: number | null;
  customerId: number | null;
  amount: string;
  transactionStatuses: readonly ("PENDING" | "PAID" | "FAILED" | "CANCELLED")[];
};

/** Context read alongside: other requests of the same documents / customers, and receipt allocations. */
export type PaymentContext = {
  /** Every request of the business that shares a billing document or a customer with a candidate. */
  siblings: readonly Pick<PaymentRequestFact, "id" | "status" | "createdAt" | "billingDocumentId" | "customerId" | "amount" | "expiresAt">[];
  /** Billing documents that a receipt allocation covers (money recorded by another path). */
  allocatedDocumentIds: ReadonlySet<number>;
};

/** A derived expiry counts only this long after the link's end (a late provider callback must not race us). */
export const PAYMENT_EXPIRY_GRACE_MS = DAY;
/** Only a request that became terminal this recently is NEW news; an older one is never announced (still resolvable). */
export const PAYMENT_EVENT_RECENCY_MS = 7 * DAY;

export type PaymentVerdict =
  | { kind: "notify"; terminal: "failed" | "expired"; at: Date }
  | { kind: "none"; why: "not_terminal" | "paid" | "paid_elsewhere" | "handled" | "link_never_sent" | "verification_pending" };

export function paymentVerdict(r: PaymentRequestFact, ctx: PaymentContext, now: Date): PaymentVerdict {
  if (r.status === "PAID" || r.transactionStatuses.includes("PAID")) return { kind: "none", why: "paid" };
  if (r.status === "CANCELLED") return { kind: "none", why: "handled" };
  let terminal: "failed" | "expired";
  let at: Date;
  if (r.status === "FAILED") {
    // A FAILED with no link is the link-creation failure the owner saw on screen the moment it happened.
    if (r.paymentUrl === null) return { kind: "none", why: "link_never_sent" };
    terminal = "failed";
    at = r.updatedAt;
  } else if (r.status === "EXPIRED" || (r.status === "PENDING" && r.expiresAt !== null && r.expiresAt.getTime() + PAYMENT_EXPIRY_GRACE_MS < now.getTime())) {
    if (r.transactionStatuses.includes("PENDING")) return { kind: "none", why: "verification_pending" };
    terminal = "expired";
    at = r.expiresAt ?? r.updatedAt;
  } else {
    return { kind: "none", why: "not_terminal" };
  }
  if (r.billingDocumentId !== null) {
    if (ctx.allocatedDocumentIds.has(r.billingDocumentId)) return { kind: "none", why: "paid_elsewhere" };
    const same = ctx.siblings.filter((s) => s.id !== r.id && s.billingDocumentId === r.billingDocumentId);
    if (same.some((s) => s.status === "PAID")) return { kind: "none", why: "paid_elsewhere" };
    // The owner already asked again for the same document.
    if (same.some((s) => s.createdAt.getTime() > r.createdAt.getTime() && s.status === "PENDING")) return { kind: "none", why: "handled" };
  } else if (r.customerId !== null) {
    const same = ctx.siblings.filter((s) => s.id !== r.id && s.billingDocumentId === null && s.customerId === r.customerId && s.amount === r.amount && s.createdAt.getTime() > r.createdAt.getTime());
    if (same.some((s) => s.status === "PAID")) return { kind: "none", why: "paid_elsewhere" };
    if (same.some((s) => s.status === "PENDING")) return { kind: "none", why: "handled" };
  }
  return { kind: "notify", terminal, at };
}

export function paymentFacts(businessId: number, rows: readonly PaymentRequestFact[], ctx: PaymentContext, now: Date): StateFacts {
  const out: StateFacts = { events: [], present: [] };
  for (const r of rows) {
    const v = paymentVerdict(r, ctx, now);
    if (v.kind !== "notify") continue;
    const k = key("payments.request_failed", "payment_request", r.id, v.terminal);
    out.present.push(k);
    if (now.getTime() - v.at.getTime() > PAYMENT_EVENT_RECENCY_MS) continue;
    out.events.push(event(
      businessId, "payments.request_failed", k, { type: "payment_request", id: r.id },
      v.terminal === "failed" ? "תשלום של לקוח לא הצליח" : "בקשת תשלום פגה בלי תשלום",
      "אפשר לשלוח בקשה חדשה או לבדוק מול הלקוח.",
      `/payments/${r.id}`, `payment_${v.terminal}`, now,
    ));
  }
  return out;
}

/* ─────────────────────────────────────────────────── C. allocation numbers ── */

export type AllocationSubmissionFact = {
  id: number;
  billingDocumentId: number;
  status: "NOT_REQUIRED" | "READY" | "PENDING" | "SUBMITTED" | "APPROVED" | "REJECTED" | "FAILED" | "HELD";
  /** isAuthorityOutcomeUncertainErrorCode(errorCode) — computed by the reader with the authority's own predicate. */
  outcomeUncertain: boolean;
  heldDecisionReportedAt: Date | null;
  createdAt: Date;
  submittedAt: Date | null;
  lastAttemptAt: Date | null;
};

/**
 * Stuck threshold: a request still READY / PENDING / SUBMITTED this long after its last movement. The execution
 * service itself calls an in-flight POST "outcome uncertain" after 15 minutes (AUTHORITY_IN_FLIGHT_STALE_MS); four
 * times that keeps a merely slow authority, a retrying network or an issue still completing well clear of an alert.
 */
export const ALLOCATION_STUCK_MS = 60 * MIN;

export type AllocationProblem = "failed" | "rejected" | "uncertain" | "decision" | "stuck";

export function allocationProblem(s: AllocationSubmissionFact, now: Date): AllocationProblem | null {
  switch (s.status) {
    case "FAILED":
      return "failed";
    case "REJECTED":
      return "rejected";
    case "HELD":
      return s.heldDecisionReportedAt === null ? "decision" : null;
    case "READY":
    case "PENDING":
    case "SUBMITTED": {
      if (s.status === "SUBMITTED" && s.outcomeUncertain) return "uncertain";
      const last = Math.max(s.createdAt.getTime(), s.submittedAt?.getTime() ?? 0, s.lastAttemptAt?.getTime() ?? 0);
      return now.getTime() - last > ALLOCATION_STUCK_MS ? "stuck" : null;
    }
    default:
      return null;
  }
}

export function allocationFacts(businessId: number, rows: readonly AllocationSubmissionFact[], now: Date): StateFacts {
  const out: StateFacts = { events: [], present: [] };
  for (const s of rows) {
    const p = allocationProblem(s, now);
    if (p === null) continue;
    const k = key("billing.allocation_failed", "billing_authority_submission", s.id, p);
    out.present.push(k);
    out.events.push(event(
      businessId, "billing.allocation_failed", k, { type: "billing_authority_submission", id: s.id },
      p === "decision" ? "חשבונית ממתינה להחלטה מול רשות המסים" : p === "stuck" ? "בקשת מספר הקצאה מתעכבת" : "בקשת מספר הקצאה לא הושלמה",
      "החשבונית עדיין לא ניתנת למסירה. פתח אותה כדי לראות מה נדרש.",
      `/billing/${s.billingDocumentId}`, `allocation_${p}`, now,
    ));
  }
  return out;
}

/* ───────────────────────────────────────────────────────────── D. documents ── */

/**
 * A document still `processing` this long after its attempt started is STUCK. The attempt's real window: the pipeline
 * runs inside the serverless invocation that started it — `after()` of the upload route or the retry route
 * (app/api/documents/upload, app/api/documents/[id]/process: maxDuration 60 s) or of the bulk documents import
 * (app/api/data-transfer/documents/execute: maxDuration 300 s); OCR itself times out at 60 s (OCR_TIMEOUT_MS). The
 * pipeline never throws and never retries by itself: it ends in `needs_review` or `failed` — unless the platform
 * killed the invocation at maxDuration (or the final status write failed), which leaves the row in `processing` for
 * good. 30 minutes = 6 × the longest window (300 s): an attempt still inside its window is never flagged, and a
 * document the platform abandoned is surfaced at the latest one sweep interval after that.
 */
export const DOCUMENT_STUCK_MS = 30 * MIN;

export type DocumentFact = {
  id: number;
  status: string;
  /** When the current status began (the database trigger's stamp). NULL = older than the stamp: never stuck. */
  statusChangedAt: Date | null;
};

/** Pure: is this document stuck in processing at `now`? */
export function documentStuck(d: DocumentFact, now: Date): boolean {
  return d.status === "processing" && d.statusChangedAt !== null && now.getTime() - d.statusChangedAt.getTime() > DOCUMENT_STUCK_MS;
}

export function documentFacts(businessId: number, rows: readonly DocumentFact[], now: Date): StateFacts {
  const out: StateFacts = { events: [], present: [] };
  for (const d of rows) {
    if (d.status === "failed") {
      const k = key("documents.processing_failed", "document_processing", d.id);
      out.present.push(k);
      out.events.push(event(
        businessId, "documents.processing_failed", k, { type: "document_processing", id: d.id },
        "עיבוד של מסמך לא הצליח", "הקובץ נשמר. אפשר לנסות שוב או להשלים את הפרטים ידנית.",
        `/documents/review/${d.id}`, "document_failed", now,
      ));
    } else if (documentStuck(d, now)) {
      // The attempt's start is part of the fact: a retry that gets stuck again is a new fact, a finished one is gone.
      const k = key("documents.processing_failed", "document_processing", d.id, "stuck", d.statusChangedAt!.toISOString());
      out.present.push(k);
      out.events.push(event(
        businessId, "documents.processing_failed", k, { type: "document_processing", id: d.id },
        "עיבוד של מסמך לא הסתיים", "הקובץ נשמר. אפשר לנסות שוב או להשלים את הפרטים ידנית.",
        `/documents/review/${d.id}`, "document_stuck", now,
      ));
    }
  }
  return out;
}

/* ────────────────────────────────────────────────────────── E. appointments ── */

export type AppointmentFact = {
  id: number;
  status: "PROPOSED" | "CONFIRMED" | "COMPLETED" | "NO_SHOW" | "CANCELED";
  kind: "CUSTOMER" | "INTERNAL" | "BLOCK";
  startsAt: Date | null;
  erasedAt: Date | null;
};

/** A user who receives appointment reminders and the lead time they chose (effectiveSettings: default 60). */
export type ReminderRecipient = { userId: number; leadMinutes: number };

/**
 * The cadence the status sweep is planned to run at (owner: every 15 minutes; the sweep is not scheduled by this code).
 * A reminder is CREATED by the first sweep pass inside [moment − SWEEP_INTERVAL, moment + grace]: up to one interval
 * ahead, so the bell is never filled days ahead, and its owed push carries nextAttemptAt = the moment, so the 5-minute
 * worker delivers it within ~5 minutes of the moment — the sweep's cadence never decides the timing. A slower sweep
 * still creates it (late, by the grace); none slower than the grace creates it at all.
 */
export const APPOINTMENT_SWEEP_INTERVAL_MS = 15 * MIN;

/** The longest lead (a day — 25 h across a clock change) + one interval: how far ahead the reader must look. */
export const APPOINTMENT_READ_HORIZON_MS = 25 * HOUR + APPOINTMENT_SWEEP_INTERVAL_MS;

/**
 * The moment a reminder is due. 30 / 60 / 120: that many REAL minutes before the start (a clock change in between
 * does not stretch it). 1440 ("the day before"): the SAME LOCAL TIME on the previous calendar day in the business
 * time zone — 23 or 25 real hours across a clock change (notification-time.ts wallClockToInstant: a skipped wall time
 * moves forward, an ambiguous one takes the earlier instant).
 */
export function appointmentReminderMoment(startsAt: Date, leadMinutes: number, timeZone: string): Date {
  if (leadMinutes === 1440) {
    const day = addDaysToKey(localDayKey(startsAt, timeZone), -1);
    return wallClockToInstant(day, localMinuteOfDay(startsAt, timeZone), timeZone);
  }
  return new Date(startsAt.getTime() - leadMinutes * MIN);
}

/**
 * How late a reminder may still be created after its moment (a sweep that did not run, an appointment confirmed
 * inside the lead): half the lead. Later than that it is no longer the reminder the user chose — none is created.
 */
export function appointmentLateGraceMs(leadMinutes: number): number {
  return (leadMinutes * MIN) / 2;
}

export type ReminderPlan =
  | { kind: "too_early" }
  | { kind: "too_late" }
  | { kind: "create"; moment: Date; notBefore: Date; expiresAt: Date };

/** Pure: what the sweep does at `now` about one user's reminder for one appointment start. */
export function appointmentReminderPlan(startsAt: Date, leadMinutes: number, now: Date, timeZone: string): ReminderPlan {
  const moment = appointmentReminderMoment(startsAt, leadMinutes, timeZone);
  const t = now.getTime();
  if (t >= startsAt.getTime()) return { kind: "too_late" };
  if (t < moment.getTime() - APPOINTMENT_SWEEP_INTERVAL_MS) return { kind: "too_early" };
  if (t > moment.getTime() + appointmentLateGraceMs(leadMinutes)) return { kind: "too_late" };
  // Never sent after the start: the owed push expires at the start (the worker closes it 'expired' or 'quiet').
  return { kind: "create", moment, notBefore: new Date(Math.max(moment.getTime(), t)), expiresAt: startsAt };
}

/** The dedupe key: the start time (a move is a new fact), the user (one per user) and the lead (a change re-plans). */
export function appointmentReminderKey(appointmentId: number, startsAt: Date, userId: number, leadMinutes: number): string {
  return key("appointments.upcoming", "appointment", appointmentId, startsAt.toISOString(), `u${userId}`, `l${leadMinutes}`);
}

function eligibleAppointment(a: AppointmentFact, now: Date): a is AppointmentFact & { startsAt: Date } {
  return a.status === "CONFIRMED" && a.kind !== "BLOCK" && a.erasedAt === null && a.startsAt !== null && a.startsAt.getTime() > now.getTime();
}

/**
 * Every eligible appointment × every recipient. PRESENT (kept unresolved) while the appointment is confirmed, not
 * started, with that start, and the user still has that lead — independent of the window, so a reminder created
 * ahead is never resolved before its moment. An EVENT only inside the create window (appointmentReminderPlan).
 */
export function appointmentFacts(
  businessId: number,
  rows: readonly AppointmentFact[],
  recipients: readonly ReminderRecipient[],
  now: Date,
  timeZone: string,
): StateFacts {
  const out: StateFacts = { events: [], present: [] };
  for (const a of rows) {
    if (!eligibleAppointment(a, now)) continue;
    const p = localParts(a.startsAt, timeZone);
    const hhmm = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
    const dm = `${p.day}.${p.month}`;
    for (const r of recipients) {
      const k = appointmentReminderKey(a.id, a.startsAt, r.userId, r.leadMinutes);
      out.present.push(k);
      const plan = appointmentReminderPlan(a.startsAt, r.leadMinutes, now, timeZone);
      if (plan.kind !== "create") continue;
      const dayBefore = r.leadMinutes === 1440;
      out.events.push({
        ...event(
          businessId, "appointments.upcoming", k, { type: "appointment", id: a.id },
          // The day-before reminder names the date (a quiet-hours deferral can move it to the appointment's own day).
          dayBefore ? "תזכורת לתור" : "תזכורת: יש לך תור בקרוב",
          dayBefore ? `התור ב-${dm} בשעה ${hhmm}.` : `התור מתחיל ב-${hhmm}.`,
          "/calendar", `appointment_upcoming_${r.leadMinutes}`, now,
        ),
        userId: r.userId,
        push: { notBefore: plan.notBefore, expiresAt: plan.expiresAt },
      });
    }
  }
  return out;
}
