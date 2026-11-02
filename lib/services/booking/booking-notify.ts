/**
 * Public booking — what the owner is told (D3, D12). SERVER-ONLY.
 *
 * One notification per request in the existing bell (Notification, dedupeKey booking-request:<id>), written inside
 * the request's own transaction so a request never exists without it:
 *   - a new pending request: in the bell at once (no push — D3 pushes only once it has waited two hours);
 *   - an automatically confirmed one: in the bell, asking the owner to link the customer (D6);
 *   - a customer's cancellation: in the bell.
 * The reminders (D3) reuse that row: two hours after its last notice while the request still waits — held from 22:00
 * to 08:00 in the business's time zone and then sent once at 08:00 (quiet hours) — a CLAIM moves its lastNotifiedAt
 * from the value read to now (one winner among concurrent sweeps), marks it unread again and records the push,
 * which is sent AFTER commit through the same Web Push path the task reminders use (PushSubscription +
 * sendWebPush; 404 / 410 revokes the subscription). Deciding, expiring or withdrawing resolves the row: no reminder
 * is ever sent for a request that is no longer pending. Nothing here reaches the customer.
 */
import type { Prisma } from "@prisma/client";

import { sendWebPush, type PushPayload } from "@/lib/push/web-push-sender";
import { tenantTx } from "@/lib/tenant/tenant-tx";

import { cancelNoticeTitle } from "./booking.core";

type Tx = Prisma.TransactionClient;

export const BOOKING_DOMAIN = "appointments";
export const BOOKING_ENTITY = "booking_request";
export const requestDedupeKey = (requestId: number) => `booking-request:${requestId}`;
export const requestHref = (requestId: number) => `/calendar?view=requests&request=${requestId}`;

export type RequestFacts = { requestId: number; contactName: string; serviceName: string; when: string };

async function upsertRequestNotification(tx: Tx, businessId: number, f: RequestFacts, title: string, summary: string, now: Date): Promise<number> {
  const dedupeKey = requestDedupeKey(f.requestId);
  const row = await tx.notification.upsert({
    where: { businessId_dedupeKey: { businessId, dedupeKey } },
    create: {
      businessId, dedupeKey, domain: BOOKING_DOMAIN, semanticCategory: "ACTION_REQUIRED", severity: "HIGH",
      entityType: BOOKING_ENTITY, entityId: f.requestId, title, summary, href: requestHref(f.requestId),
      intendedChannels: ["IN_APP", "PUSH"], reason: "public_booking_request", cooldownHours: 0,
      firstSurfacedAt: now, lastSurfacedAt: now, lastNotifiedAt: now,
    },
    update: { title, summary, lastSurfacedAt: now, readAt: null, resolvedAt: null },
    select: { id: true },
  });
  await tx.notificationDelivery.create({
    data: { businessId, notificationId: row.id, channel: "IN_APP", status: "SENT", attemptedAt: now, createdAt: now },
  });
  return row.id;
}

/** A new request that waits for the owner (in the bell at once). */
export function notifyPending(tx: Tx, businessId: number, f: RequestFacts, now: Date) {
  return upsertRequestNotification(tx, businessId, f, `בקשה לתור: ${f.contactName}`, `${f.serviceName} · ${f.when} · ממתינה לאישור שלך`, now);
}

/** A request the business confirms automatically: the customer is still to be linked by the owner (D6). */
export function notifyAutoConfirmed(tx: Tx, businessId: number, f: RequestFacts, now: Date) {
  return upsertRequestNotification(tx, businessId, f, `תור חדש נקבע מהקישור: ${f.contactName}`, `${f.serviceName} · ${f.when} · לקשר לכרטיס לקוח?`, now);
}

/** The customer cancelled through their link (`wasPending`: the request had not been decided yet). */
export function notifyCustomerCancelled(tx: Tx, businessId: number, f: RequestFacts, now: Date, wasPending = false) {
  return upsertRequestNotification(tx, businessId, f, cancelNoticeTitle(f.contactName, wasPending), `${f.serviceName} · ${f.when}`, now);
}

/** The request is no longer waiting (decided, expired, withdrawn): no further reminder, out of the open list. */
export async function resolveRequestNotification(tx: Tx, businessId: number, requestId: number, now: Date): Promise<void> {
  await tx.notification.updateMany({
    where: { businessId, dedupeKey: requestDedupeKey(requestId), resolvedAt: null },
    data: { resolvedAt: now },
  });
}

export type ReminderClaim = { notificationId: number; subscriptions: { id: number; endpoint: string; p256dh: string; auth: string }[]; payload: PushPayload };

/** The open notice of a request and when it last went out (the anchor of the next reminder). */
export async function requestNoticeState(tx: Tx, businessId: number, requestId: number): Promise<{ lastNotifiedAt: Date | null } | null> {
  return tx.notification.findFirst({ where: { businessId, dedupeKey: requestDedupeKey(requestId), resolvedAt: null }, select: { lastNotifiedAt: true } });
}

/**
 * Claim the next reminder of a still-pending request. Exactly one caller wins: the UPDATE succeeds only while the
 * row's lastNotifiedAt is still the value the caller read (`seen`), and it moves it to now — so a second sweep, or a
 * second pass over the same night, finds a newer anchor and sends nothing.
 */
export async function claimReminder(tx: Tx, businessId: number, f: RequestFacts, seen: Date | null, waited: number, now: Date): Promise<ReminderClaim | null> {
  const claimed = await tx.notification.updateMany({
    where: { businessId, dedupeKey: requestDedupeKey(f.requestId), resolvedAt: null, lastNotifiedAt: seen },
    data: { lastNotifiedAt: now, lastSurfacedAt: now, readAt: null, title: `בקשה לתור ממתינה ${waited} שעות: ${f.contactName}`, summary: `${f.serviceName} · ${f.when}` },
  });
  if (claimed.count !== 1) return null;
  const row = await tx.notification.findFirst({ where: { businessId, dedupeKey: requestDedupeKey(f.requestId) }, select: { id: true } });
  if (!row) return null;
  await tx.notificationDelivery.create({
    data: { businessId, notificationId: row.id, channel: "IN_APP", status: "SENT", attemptedAt: now, createdAt: now },
  });
  const subscriptions = await tx.pushSubscription.findMany({
    where: { businessId, revokedAt: null },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
    take: 20,
  });
  return {
    notificationId: row.id,
    subscriptions,
    payload: {
      title: `בקשה לתור ממתינה ${waited} שעות`,
      body: `${f.contactName} · ${f.serviceName} · ${f.when}`,
      url: requestHref(f.requestId),
      tag: `booking-request-${f.requestId}`,
      kind: "booking",
      requestId: f.requestId,
    } as PushPayload,
  };
}

/** After commit: send the claimed reminder to the business's live subscriptions and record each delivery. */
export async function pushReminder(businessId: number, claim: ReminderClaim, now: Date): Promise<{ pushed: number; failed: number }> {
  if (claim.subscriptions.length === 0) return { pushed: 0, failed: 0 };
  const results = await Promise.all(claim.subscriptions.map(async (s) => ({ s, out: await sendWebPush(s, claim.payload) })));
  await tenantTx(businessId, async (tx) => {
    for (const { s, out } of results) {
      await tx.notificationDelivery.create({
        data: {
          businessId, notificationId: claim.notificationId, channel: "PUSH",
          status: out.ok ? "SENT" : "FAILED", attemptedAt: now, createdAt: now,
          error: out.ok ? null : `push_${out.status ?? "error"}`,
        },
      });
      await tx.pushSubscription.updateMany({
        where: { id: s.id, businessId },
        data: out.ok
          ? { lastSuccessAt: now, failureCount: 0 }
          : { lastFailureAt: now, failureCount: { increment: 1 }, ...(out.gone ? { revokedAt: now } : {}) },
      });
    }
  });
  const pushed = results.filter((r) => r.out.ok).length;
  return { pushed, failed: results.length - pushed };
}
