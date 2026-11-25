/**
 * Public booking — what the owner is told (D3, D12). SERVER-ONLY.
 *
 * G13 (appointments completion 2026-11-25): written through the notification ENGINE (notify(), category
 * booking.request_waiting) instead of the legacy web-push loop. One notification per request in the bell (dedupeKey
 * booking-request:<id>), written inside the request's own transaction so a request never exists without it:
 *   - a new pending request: in the bell at once, no push (D3 pushes only once it has waited two hours);
 *   - an automatically confirmed one: in the bell, asking the owner to link the customer (D6);
 *   - a customer's cancellation: in the bell.
 * The reminders (D3) reuse that row: two hours after its last notice while the request still waits — held from 22:00
 * to 08:00 in the business's time zone and then sent once at 08:00 — notify()'s claim (cooldown 2 hours: one winner
 * among concurrent sweeps) marks it unread again and owes ONE push (expiring when the request lapses). The engine's
 * worker then delivers it: each user's preferences and quiet hours, Android (FCM) and web push, live sessions only,
 * retries with backoff, and the GENERIC lock-screen text — never the customer's name (the category is
 * lockScreenGenericOnly). Deciding, expiring or withdrawing resolves the row: an owed reminder of a request that is no
 * longer pending is suppressed ('resolved'). Entitled under `appointments` (Basic). Nothing here reaches the customer.
 */
import type { Prisma } from "@prisma/client";

import { notify } from "@/lib/notifications/engine/notify";

import { cancelNoticeTitle } from "./booking.core";

type Tx = Prisma.TransactionClient;

export const BOOKING_DOMAIN = "appointments";
export const BOOKING_ENTITY = "booking_request";
export const BOOKING_CATEGORY = "booking.request_waiting";
/** D3: a reminder at most every two hours — also notify()'s claim window (one winner). */
export const REMINDER_COOLDOWN_HOURS = 2;
export const requestDedupeKey = (requestId: number) => `booking-request:${requestId}`;
export const requestHref = (requestId: number) => `/calendar?view=requests&request=${requestId}`;

export type RequestFacts = { requestId: number; contactName: string; serviceName: string; when: string };

async function inBell(tx: Tx, businessId: number, f: RequestFacts, title: string, summary: string, now: Date): Promise<number> {
  const r = await notify(tx, {
    businessId,
    category: BOOKING_CATEGORY,
    entity: { type: BOOKING_ENTITY, id: f.requestId },
    dedupeKey: requestDedupeKey(f.requestId),
    title,
    summary,
    href: requestHref(f.requestId),
    cooldownHours: 0,
    reason: "public_booking_request",
    now,
    inAppOnly: true,
  });
  return r.notificationId;
}

/** A new request that waits for the owner (in the bell at once). */
export function notifyPending(tx: Tx, businessId: number, f: RequestFacts, now: Date) {
  return inBell(tx, businessId, f, `בקשה לתור: ${f.contactName}`, `${f.serviceName} · ${f.when} · ממתינה לאישור שלך`, now);
}

/** A request the business confirms automatically: the customer is still to be linked by the owner (D6). */
export function notifyAutoConfirmed(tx: Tx, businessId: number, f: RequestFacts, now: Date) {
  return inBell(tx, businessId, f, `תור חדש נקבע מהקישור: ${f.contactName}`, `${f.serviceName} · ${f.when} · לקשר לכרטיס לקוח?`, now);
}

/** The customer cancelled through their link (`wasPending`: the request had not been decided yet). */
export function notifyCustomerCancelled(tx: Tx, businessId: number, f: RequestFacts, now: Date, wasPending = false) {
  return inBell(tx, businessId, f, cancelNoticeTitle(f.contactName, wasPending), `${f.serviceName} · ${f.when}`, now);
}

/** The request is no longer waiting (decided, expired, withdrawn): no further reminder, out of the open list. */
export async function resolveRequestNotification(tx: Tx, businessId: number, requestId: number, now: Date): Promise<void> {
  await tx.notification.updateMany({
    where: { businessId, dedupeKey: requestDedupeKey(requestId), resolvedAt: null },
    data: { resolvedAt: now },
  });
}

/** The open notice of a request and when it last went out (the anchor of the next reminder). */
export async function requestNoticeState(tx: Tx, businessId: number, requestId: number): Promise<{ lastNotifiedAt: Date | null } | null> {
  return tx.notification.findFirst({ where: { businessId, dedupeKey: requestDedupeKey(requestId), resolvedAt: null }, select: { lastNotifiedAt: true } });
}

/**
 * The next reminder of a still-pending request, through the engine: notify()'s claim (cooldown two hours) — exactly
 * one caller wins — marks the notice unread again and owes ONE whole-business push due now and expiring when the
 * request lapses. Returns the owed push row (the caller kicks the worker for it after commit), or null when another
 * sweep already reminded.
 */
export async function remindPendingRequest(
  tx: Tx, businessId: number, f: RequestFacts, waited: number, requestExpiresAt: Date, now: Date,
): Promise<number | null> {
  if (requestExpiresAt.getTime() <= now.getTime()) return null;
  const r = await notify(tx, {
    businessId,
    category: BOOKING_CATEGORY,
    entity: { type: BOOKING_ENTITY, id: f.requestId },
    dedupeKey: requestDedupeKey(f.requestId),
    title: `בקשה לתור ממתינה ${waited} שעות: ${f.contactName}`,
    summary: `${f.serviceName} · ${f.when}`,
    href: requestHref(f.requestId),
    cooldownHours: REMINDER_COOLDOWN_HOURS,
    reason: "public_booking_reminder",
    now,
    push: { notBefore: now, expiresAt: requestExpiresAt },
  });
  return r.notified ? r.owedDeliveryId : null;
}
