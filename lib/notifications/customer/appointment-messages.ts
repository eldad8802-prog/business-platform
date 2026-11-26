/**
 * The customer's appointment messages — the PRODUCER (G1, appointments completion program, workstream F). SERVER-ONLY.
 *
 * Called by the appointment journal (appointment-journal.ts appendAppointmentEvent) right after every appointment
 * event is written — so it runs INSIDE the same tenant transaction (and, for every writer that takes it, under the
 * same lockBusinessAppointments) as the change itself: the change and its messages commit together, or neither does.
 * Every appointment writer journals its change, so no writer can bypass it.
 *
 * What it owes (only for a CUSTOMER appointment, not erased, with a reachable phone — the public request's phone,
 * else the linked customer card's — and only while the business is entitled: customer-entitlement.ts):
 *   APPOINTMENT_CREATED   CONFIRMED → "confirmed"; PROPOSED from the public link → "received" (pending approval)
 *   APPOINTMENT_CONFIRMED → "confirmed"
 *   APPOINTMENT_RESCHEDULED / SELF_RESCHEDULED → "changed" (a confirmed one, or a pending public request)
 *   APPOINTMENT_CANCELED  → "cancelled" (a confirmed one, or a pending public request — the customer heard of it)
 *   and, while CONFIRMED with a future start, one REMINDER per BookingSettings.reminderOffsetsMinutes (default 1440):
 *   notBefore = start − offset, expiresAt = start; an offset whose moment has already passed is skipped.
 *
 * Dedupe keys carry the start (and, for notices, the appointment's version): a repeat of the same event is a no-op;
 * a move owes new reminders under new keys. Before owing, every still-owed message of the appointment that no longer
 * fits (a reminder for the old start, a "confirmed" not yet sent when it is cancelled …) is closed SUPERSEDED — on
 * every event, entitled or not, so turning the feature off or erasing the phone never leaves a stale message owed.
 * The lane re-checks the appointment at claim time as a second line (worker leases are not taken over here).
 *
 * The message text is composed at SEND time from the live appointment (business name, service, date, time, the
 * manage link) — nothing about the customer is stored beyond the phone on the delivery row (retention: 30 days).
 */
import type { AppointmentEventType, Prisma } from "@prisma/client";

import { normalizeCustomerPhone } from "@/lib/services/integrations/whatsapp/phone";

import type { CustomerCategoryKey } from "../catalog";
import { getCustomerCategory } from "../catalog";
import { customerMessagesAllowedInTx } from "./customer-entitlement";
import { cancelOwedCustomerMessages, E164, notifyCustomer } from "./notify-customer";

type Tx = Prisma.TransactionClient;
type Scalar = string | number | boolean | null;

export type AppointmentJournalFact = {
  businessId: number;
  appointmentId: number;
  eventType: AppointmentEventType;
  payload?: Record<string, Scalar | Scalar[]>;
  now?: Date;
};

const HANDLED: ReadonlySet<string> = new Set([
  "APPOINTMENT_CREATED", "APPOINTMENT_CONFIRMED", "APPOINTMENT_RESCHEDULED", "SELF_RESCHEDULED",
  "APPOINTMENT_CANCELED", "APPOINTMENT_COMPLETED", "APPOINTMENT_NO_SHOW", "APPOINTMENT_DETAILS_CHANGED",
  "CUSTOMER_CHANGED", "STATUS_CORRECTED", "ARRIVED",
]);

export const DEFAULT_REMINDER_OFFSETS = [1440] as const;

/**
 * D2 (owner decision 2026-11-26) — WHO controls customer messages, with an EXISTING setting (no schema change):
 * BookingSettings.reminderOffsetsMinutes, the business's own "reminder times" (0–3 values, 30..10080 minutes; the
 * booking settings screen — Calendar → booking settings).
 *   - An appointment the business ENTERED ITSELF (no public request): messages only when the business has booking
 *     settings AND at least one reminder time. An empty list (or no settings at all) = no WhatsApp to the customers of
 *     appointments the business enters — no confirmation, no change, no cancellation, no reminder.
 *   - A booking made through the public link: the customer started it, so its received / confirmed / changed /
 *     cancelled answers always go (the link itself is the business's choice); reminders follow the same list (empty =
 *     none).
 * On top of this sit the subscription entitlement and the stops (customer-entitlement.ts, platform-transport.ts).
 */
export function ownerControlAllows(publicRequest: boolean, settings: { reminderOffsetsMinutes: readonly number[] } | null): boolean {
  if (publicRequest) return true;
  return settings !== null && reminderOffsets(settings.reminderOffsetsMinutes).length > 0;
}

/** A stored phone (Customer.phone / BookingRequest.contactPhone: 972…) as E.164, or null. */
export function toE164(raw: string | null | undefined): string | null {
  const digits = normalizeCustomerPhone(raw ?? null);
  if (!digits) return null;
  const e = `+${digits}`;
  return E164.test(e) ? e : null;
}

/** Offsets as the settings hold them (0–3 values, 30..10080) — anything else is ignored, never trusted. */
export function reminderOffsets(raw: readonly number[] | null | undefined): number[] {
  const list = raw ?? DEFAULT_REMINDER_OFFSETS;
  return [...new Set(list.filter((m) => Number.isInteger(m) && m >= 30 && m <= 10080))].slice(0, 3);
}

export const reminderKey = (appointmentId: number, startsAt: Date, offset: number) =>
  `wa:reminder:a${appointmentId}:${startsAt.toISOString()}:o${offset}`;
export const noticeKey = (kind: string, appointmentId: number, startsAt: Date, version: number) =>
  `wa:${kind}:a${appointmentId}:${startsAt.toISOString()}:v${version}`;

/** Parse the start an owed message was made for (the lane's staleness check). */
export function startOfKey(dedupeKey: string): Date | null {
  const m = /^wa:[a-z]+:a\d+:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z):[ov]\d+$/.exec(dedupeKey);
  if (!m) return null;
  const d = new Date(m[1]);
  return Number.isNaN(d.getTime()) ? null : d;
}

type Plan = {
  notice: { category: CustomerCategoryKey; kind: string } | null;
  reminders: boolean;
};

/** Pure: which notice this event owes, and whether reminders are owed after it. */
export function planFor(
  eventType: string,
  appt: { status: string; startsAt: Date | null },
  ctx: { publicRequest: boolean; from: string | null; now: Date },
): Plan {
  const future = appt.startsAt !== null && appt.startsAt.getTime() > ctx.now.getTime();
  const reminders = appt.status === "CONFIRMED" && future;
  if (!future) return { notice: null, reminders: false };
  const live = appt.status === "CONFIRMED" || (appt.status === "PROPOSED" && ctx.publicRequest);
  switch (eventType) {
    case "APPOINTMENT_CREATED":
      if (appt.status === "CONFIRMED") return { notice: { category: "appointments.customer_confirmed", kind: "confirmed" }, reminders };
      if (appt.status === "PROPOSED" && ctx.publicRequest) return { notice: { category: "appointments.customer_received", kind: "received" }, reminders };
      return { notice: null, reminders };
    case "APPOINTMENT_CONFIRMED":
      return { notice: appt.status === "CONFIRMED" ? { category: "appointments.customer_confirmed", kind: "confirmed" } : null, reminders };
    case "APPOINTMENT_RESCHEDULED":
    case "SELF_RESCHEDULED":
      return { notice: live ? { category: "appointments.customer_changed", kind: "changed" } : null, reminders };
    case "APPOINTMENT_CANCELED": {
      const heard = ctx.from === "CONFIRMED" || (ctx.from === "PROPOSED" && ctx.publicRequest);
      return { notice: appt.status === "CANCELED" && heard ? { category: "appointments.customer_cancelled", kind: "cancelled" } : null, reminders: false };
    }
    default:
      return { notice: null, reminders };
  }
}

export type ProducerOutcome = { cancelled: number; created: number; revived: number };

export async function produceAppointmentCustomerMessages(tx: Tx, f: AppointmentJournalFact): Promise<ProducerOutcome> {
  const out: ProducerOutcome = { cancelled: 0, created: 0, revived: 0 };
  if (!HANDLED.has(f.eventType)) return out;
  const now = f.now ?? new Date();
  const appt = await tx.appointment.findFirst({
    where: { id: f.appointmentId, businessId: f.businessId },
    select: { id: true, kind: true, status: true, startsAt: true, version: true, customerId: true, erasedAt: true },
  });
  if (!appt || appt.kind !== "CUSTOMER") return out;

  const request = await tx.bookingRequest.findFirst({
    where: { businessId: f.businessId, appointmentId: appt.id },
    select: { contactPhone: true },
  });
  const publicRequest = request !== null;
  const from = typeof f.payload?.from === "string" ? f.payload.from : null;
  const plan = appt.erasedAt === null ? planFor(f.eventType, appt, { publicRequest, from, now }) : { notice: null, reminders: false };

  let phone: string | null = null;
  let entitled = false;
  if (plan.notice || plan.reminders) {
    phone = toE164(request?.contactPhone ?? null);
    if (!phone && appt.customerId !== null) {
      const c = await tx.customer.findFirst({ where: { id: appt.customerId, businessId: f.businessId }, select: { phone: true } });
      phone = toE164(c?.phone ?? null);
    }
    entitled = phone !== null && (await customerMessagesAllowedInTx(tx, f.businessId));
  }
  // D2 (owner 2026-11-26) — the business's own control, an EXISTING setting: BookingSettings.reminderOffsetsMinutes.
  const settings = entitled
    ? await tx.bookingSettings.findFirst({ where: { businessId: f.businessId }, select: { reminderOffsetsMinutes: true } })
    : null;
  if (entitled && !ownerControlAllows(publicRequest, settings)) entitled = false;

  // The messages this event owes (computed first, so the cancel step keeps exactly them).
  const owed: Array<{ category: CustomerCategoryKey; key: string; notBefore: Date | null; expiresAt: Date }> = [];
  if (entitled && appt.startsAt) {
    const startsAt = appt.startsAt;
    if (plan.notice) {
      const cat = getCustomerCategory(plan.notice.category)!;
      const expiresAt = new Date(Math.min(now.getTime() + cat.ttlMinutes * 60_000, startsAt.getTime()));
      if (expiresAt.getTime() > now.getTime()) {
        owed.push({ category: plan.notice.category, key: noticeKey(plan.notice.kind, appt.id, startsAt, appt.version), notBefore: null, expiresAt });
      }
    }
    if (plan.reminders) {
      for (const offset of reminderOffsets(settings?.reminderOffsetsMinutes)) {
        const at = new Date(startsAt.getTime() - offset * 60_000);
        if (at.getTime() <= now.getTime()) continue; // its moment has passed — never a late "reminder"
        owed.push({ category: "appointments.customer_reminder", key: reminderKey(appt.id, startsAt, offset), notBefore: at, expiresAt: startsAt });
      }
    }
  }

  // Close what no longer fits. Keep: what this event owes, and notices still owed for the CURRENT start of an
  // appointment that is still live (a "confirmed" not yet sent survives a details change).
  const live = appt.erasedAt === null && (appt.status === "CONFIRMED" || appt.status === "PROPOSED");
  const keep = owed.map((o) => o.key);
  if (live && appt.startsAt && f.eventType !== "APPOINTMENT_CANCELED") {
    const current = await tx.notificationDelivery.findMany({
      where: { businessId: f.businessId, appointmentId: appt.id, recipientKind: "CUSTOMER", status: "PENDING" },
      select: { notification: { select: { dedupeKey: true } } },
    });
    const iso = appt.startsAt.toISOString();
    for (const c of current) {
      const k = c.notification.dedupeKey;
      // A reminder for the current start survives only if still owed (it is then in `owed` already); a "received"
      // still owed once the request is confirmed is replaced by the "confirmed" itself.
      if (k.startsWith("wa:reminder:") || (appt.status === "CONFIRMED" && k.startsWith("wa:received:"))) continue;
      if (k.includes(`:${iso}:`)) keep.push(k);
    }
  }
  out.cancelled = await cancelOwedCustomerMessages(tx, { businessId: f.businessId, appointmentId: appt.id, keepKeys: keep, now });

  for (const o of owed) {
    const cat = getCustomerCategory(o.category)!;
    const r = await notifyCustomer(tx, {
      businessId: f.businessId,
      category: o.category,
      entity: { type: "appointment", id: appt.id },
      dedupeKey: o.key,
      recipientPhone: phone!,
      templateKey: publicRequest ? cat.template.withLink : cat.template.noLink,
      appointmentId: appt.id,
      now,
      notBefore: o.notBefore,
      expiresAt: o.expiresAt,
    });
    if (r.kind === "created") out.created += 1;
    else if (r.kind === "revived") out.revived += 1;
  }
  return out;
}
