/**
 * notifyCustomer(tx, event) — how a producer records a message OWED TO A CUSTOMER (G1, appointments completion
 * program, workstream F). SERVER-ONLY. The customer-side sibling of engine/notify.ts.
 *
 * Runs INSIDE the producer's own tenant transaction (the appointment change and its message commit together). It never
 * sends anything:
 *   1. inserts the Notification by (businessId, dedupeKey) — ON CONFLICT DO NOTHING: one logical message per key, a
 *      repeat of the same event writes nothing (idempotent). The row is never the owner's: written dismissed, resolved
 *      and read, so no list, badge or digest of the owner shows it; its title is generic (no customer name, no phone);
 *   2. on a fresh insert, writes its ONE delivery: recipientKind CUSTOMER, channel WHATSAPP, PENDING, the E.164 phone,
 *      the template, the class, the appointment; nextAttemptAt = notBefore (owed later: reminders), expiresAt (never
 *      sent after it). The database allows exactly one CUSTOMER delivery per notification (partial unique index): a
 *      worker retry updates that row, it never adds one — so a message is sent at most once and metered once;
 *   3. on a repeat of a key whose owed message WE cancelled (SUPPRESSED 'superseded' before any provider id — an
 *      appointment moved away and back), the same row is owed again (revived) instead of a second row.
 *
 * cancelOwedCustomerMessages() closes the still-owed messages of an appointment (moved / cancelled / finished):
 * SUPPRESSED 'superseded', never touching one already handed to the provider or one a worker holds right now.
 */
import { Prisma } from "@prisma/client";

import { getCustomerCategory, type CustomerCategoryKey } from "../catalog";

type Tx = Prisma.TransactionClient;

export type NotifyCustomerEvent = {
  businessId: number;
  category: CustomerCategoryKey;
  entity: { type: string; id: number };
  dedupeKey: string;
  /** E.164 (+9725…). */
  recipientPhone: string;
  templateKey: string;
  appointmentId: number | null;
  now: Date;
  /** Owed for a later moment (reminders): no attempt before it. Absent: due now. */
  notBefore?: Date | null;
  expiresAt: Date;
};

export type NotifyCustomerOutcome =
  | { kind: "created"; notificationId: number; deliveryId: number }
  | { kind: "revived"; notificationId: number; deliveryId: number }
  | { kind: "exists"; notificationId: number; deliveryId: number | null };

export class NotifyCustomerRefusedError extends Error {
  constructor(readonly code: "UNKNOWN_CATEGORY" | "INVALID_EVENT") {
    super(`notifyCustomer refused: ${code}`);
    this.name = "NotifyCustomerRefusedError";
  }
}

export const E164 = /^\+[1-9][0-9]{7,14}$/;
const TEMPLATE_KEY = /^[a-z0-9_]{1,64}$/;
/** The reasons a producer closes an owed message with — only these may be owed again later (revive). */
export const SUPERSEDED = "superseded";
/** Generic, lock-screen-safe, never a name or a number. */
export const CUSTOMER_NOTIFICATION_TITLE = "הודעת WhatsApp ללקוח";

const utc = (instant: Date) => Prisma.sql`${instant.toISOString()}::timestamptz AT TIME ZONE 'UTC'`;

export async function notifyCustomer(tx: Tx, e: NotifyCustomerEvent): Promise<NotifyCustomerOutcome> {
  const cat = getCustomerCategory(e.category);
  if (!cat) throw new NotifyCustomerRefusedError("UNKNOWN_CATEGORY");
  if (
    !Number.isInteger(e.businessId) || e.businessId <= 0 || !Number.isInteger(e.entity.id) ||
    !E164.test(e.recipientPhone) || !TEMPLATE_KEY.test(e.templateKey) ||
    typeof e.dedupeKey !== "string" || e.dedupeKey.length === 0 || e.dedupeKey.length > 255 ||
    !(e.expiresAt.getTime() > (e.notBefore ?? e.now).getTime()) ||
    (e.appointmentId !== null && !Number.isInteger(e.appointmentId))
  ) {
    throw new NotifyCustomerRefusedError("INVALID_EVENT");
  }
  const now = e.now;
  const inserted = await tx.$queryRaw<Array<{ id: number }>>`
    INSERT INTO "Notification" (
      "businessId", "dedupeKey", "domain", "semanticCategory", "severity",
      "entityType", "entityId", "title", "summary", "href", "userId",
      "intendedChannels", "reason", "cooldownHours",
      "firstSurfacedAt", "lastSurfacedAt", "lastNotifiedAt", "readAt", "resolvedAt", "dismissedAt", "createdAt", "updatedAt"
    ) VALUES (
      ${e.businessId}, ${e.dedupeKey}, ${cat.domain}, ${cat.key}, ${"MEDIUM"},
      ${e.entity.type}, ${e.entity.id}, ${CUSTOMER_NOTIFICATION_TITLE}, NULL, ${"/calendar"}, NULL,
      ARRAY['WHATSAPP']::"NotificationChannel"[], ${cat.key}, 0,
      ${utc(now)}, ${utc(now)}, ${utc(now)}, ${utc(now)}, ${utc(now)}, ${utc(now)}, ${utc(now)}, ${utc(now)}
    )
    ON CONFLICT ("businessId", "dedupeKey") DO NOTHING
    RETURNING "id"
  `;
  if (inserted[0]) {
    const notificationId = inserted[0].id;
    const d = await tx.notificationDelivery.create({
      data: {
        businessId: e.businessId,
        notificationId,
        channel: "WHATSAPP",
        status: "PENDING",
        recipientKind: "CUSTOMER",
        recipientPhone: e.recipientPhone,
        templateKey: e.templateKey,
        messageClass: cat.messageClass,
        appointmentId: e.appointmentId,
        attempts: 0,
        nextAttemptAt: e.notBefore ?? null,
        expiresAt: e.expiresAt,
        attemptedAt: now,
        createdAt: now,
      },
      select: { id: true },
    });
    return { kind: "created", notificationId, deliveryId: d.id };
  }

  const existing = await tx.notification.findFirst({ where: { businessId: e.businessId, dedupeKey: e.dedupeKey }, select: { id: true } });
  if (!existing) throw new Error("notifyCustomer: conflict without a row");
  const prior = await tx.notificationDelivery.findFirst({
    where: { businessId: e.businessId, notificationId: existing.id, recipientKind: "CUSTOMER" },
    select: { id: true, status: true, error: true, providerMessageId: true, recipientPhone: true, templateKey: true },
  });
  if (
    prior && prior.status === "SUPPRESSED" && prior.error === SUPERSEDED && prior.providerMessageId === null &&
    prior.recipientPhone === e.recipientPhone && prior.templateKey === e.templateKey
  ) {
    const n = await tx.notificationDelivery.updateMany({
      where: { id: prior.id, businessId: e.businessId, status: "SUPPRESSED", error: SUPERSEDED, providerMessageId: null },
      data: {
        status: "PENDING", error: null, attempts: 0, nextAttemptAt: e.notBefore ?? null, expiresAt: e.expiresAt,
        leaseUntil: null, completedAt: null, attemptedAt: now,
      },
    });
    if (n.count === 1) return { kind: "revived", notificationId: existing.id, deliveryId: prior.id };
  }
  return { kind: "exists", notificationId: existing.id, deliveryId: prior?.id ?? null };
}

/**
 * Close the still-owed customer messages of an appointment, except the keys to keep. Never one already handed to the
 * provider (providerMessageId set) and never one a worker holds under a live lease (in flight: the lane re-checks
 * the appointment when it claims, so a stale one is closed there). Returns how many were closed.
 */
export async function cancelOwedCustomerMessages(
  tx: Tx,
  input: { businessId: number; appointmentId: number; keepKeys: readonly string[]; now: Date },
): Promise<number> {
  const r = await tx.notificationDelivery.updateMany({
    where: {
      businessId: input.businessId,
      appointmentId: input.appointmentId,
      recipientKind: "CUSTOMER",
      status: "PENDING",
      providerMessageId: null,
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: input.now } }],
      ...(input.keepKeys.length > 0 ? { notification: { dedupeKey: { notIn: [...input.keepKeys] } } } : {}),
    },
    data: { status: "SUPPRESSED", error: SUPERSEDED, completedAt: input.now, leaseUntil: null },
  });
  return r.count;
}
