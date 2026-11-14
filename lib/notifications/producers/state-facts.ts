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
 *   D documents.processing_failed  status `failed` (the pipeline never retries by itself)
 *   E appointments.upcoming        CONFIRMED, starts within the lead time (60 min); cancelled / moved ⇒ absent
 *
 * Stored title / summary are generic too (no customer, payee, amount or number); the push uses the catalog's
 * lock-screen text unless the user opted into details.
 */
import type { CategoryKey } from "../catalog";
import type { NotifyEvent } from "../engine/notify";
import { localDayKey, localParts } from "../notification-time";
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

export type DocumentFact = { id: number; status: string };

export function documentFacts(businessId: number, rows: readonly DocumentFact[], now: Date): StateFacts {
  const out: StateFacts = { events: [], present: [] };
  for (const d of rows) {
    if (d.status !== "failed") continue;
    const k = key("documents.processing_failed", "document_processing", d.id);
    out.present.push(k);
    out.events.push(event(
      businessId, "documents.processing_failed", k, { type: "document_processing", id: d.id },
      "עיבוד של מסמך לא הצליח", "הקובץ נשמר. אפשר לנסות שוב או להשלים את הפרטים ידנית.",
      `/documents/review/${d.id}`, "document_failed", now,
    ));
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

/** Catalog default lead time: the reminder is due 60 minutes before the start (a per-user lead needs a column). */
export const APPOINTMENT_REMINDER_LEAD_MS = 60 * MIN;

/**
 * The latest moment a reminder may still be CREATED: start − the category TTL (30 min), so the owed push always
 * expires no later than the start — never a reminder for something that already began. A sweep cadence ≤ 30 min
 * therefore never misses a reminder; it arrives between 60 and (60 − cadence) minutes before the start.
 */
export function appointmentCreateWindow(ttlMinutes: number): { fromMs: number; untilMs: number } {
  return { fromMs: APPOINTMENT_REMINDER_LEAD_MS, untilMs: ttlMinutes * MIN };
}

export function appointmentFacts(businessId: number, rows: readonly AppointmentFact[], now: Date, timeZone: string, ttlMinutes: number): StateFacts {
  const out: StateFacts = { events: [], present: [] };
  const win = appointmentCreateWindow(ttlMinutes);
  for (const a of rows) {
    if (a.status !== "CONFIRMED" || a.kind === "BLOCK" || a.erasedAt !== null || a.startsAt === null) continue;
    const until = a.startsAt.getTime() - now.getTime();
    if (until <= 0 || until > win.fromMs) continue;
    const k = key("appointments.upcoming", "appointment", a.id, a.startsAt.toISOString());
    out.present.push(k);
    if (until < win.untilMs) continue;
    const p = localParts(a.startsAt, timeZone);
    const hhmm = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
    out.events.push(event(
      businessId, "appointments.upcoming", k, { type: "appointment", id: a.id },
      "תזכורת: יש לך תור בקרוב", `התור מתחיל ב-${hhmm}.`,
      "/calendar", "appointment_upcoming", now,
    ));
  }
  return out;
}
