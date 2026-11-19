/**
 * notify(tx, event) — how a producer records a notification for the engine (notifications track spec, 2026-11-12).
 * SERVER-ONLY.
 *
 * Runs INSIDE the producer's own tenant transaction, so a fact and its notification commit together. It never sends
 * anything: it
 *   1. upserts the Notification by (businessId, dedupeKey) and claims the right to notify with the cooldown — the
 *      same atomic SQL the snapshot writer uses (one winner under a race; within the cooldown nothing is written);
 *   2. on a win, records the in-app delivery (SENT — the row existing IS the in-app delivery) and, when the category
 *      may push, ONE owed PUSH delivery: PENDING, userId = the target user (NULL = the whole business), expiresAt =
 *      now + the category's TTL. The worker (push-worker.ts) does the rest.
 *
 * The engine's rows carry the catalog key in `semanticCategory` and the catalog domain in `domain`, so the
 * classifier reads them back exactly; severity is derived from the category's importance.
 */
import { Prisma } from "@prisma/client";

import { categoryMayPush, getCategory, safeHref, severityOf, type CategoryKey } from "../catalog";

type Tx = Prisma.TransactionClient;

export type NotifyEvent = {
  businessId: number;
  category: CategoryKey;
  entity: { type: string; id: number };
  /** Identity of the fact. Default `n:<category>:<entityType>:<entityId>` (+ `:u<userId>` for a user-targeted one). */
  dedupeKey?: string;
  title: string;
  summary?: string | null;
  /** Internal path under the category's allowed prefixes (refused otherwise). */
  href: string;
  /** NULL / absent = every user of the business. */
  userId?: number | null;
  /** Default: the category's cooldown. */
  cooldownHours?: number;
  reason?: string;
  now: Date;
};

export type NotifyOutcome = {
  notificationId: number;
  created: boolean;
  /** This call won the right to notify (outside the cooldown): deliveries were written. */
  notified: boolean;
  /** The owed push row, when one was written. */
  owedDeliveryId: number | null;
};

export class NotifyRefusedError extends Error {
  constructor(readonly code: "UNKNOWN_CATEGORY" | "INVALID_HREF" | "INVALID_EVENT") {
    super(`notify refused: ${code}`);
    this.name = "NotifyRefusedError";
  }
}

const HOUR_MS = 3_600_000;
/** Bind an instant to a timestamp(3) column as its UTC wall clock (see notification-writer.ts `utc`). */
const utc = (instant: Date) => Prisma.sql`${instant.toISOString()}::timestamptz AT TIME ZONE 'UTC'`;

export function defaultDedupeKey(e: Pick<NotifyEvent, "category" | "entity" | "userId">): string {
  return `n:${e.category}:${e.entity.type}:${e.entity.id}${e.userId != null ? `:u${e.userId}` : ""}`;
}

export async function notify(tx: Tx, event: NotifyEvent): Promise<NotifyOutcome> {
  const cat = getCategory(event.category);
  if (!cat) throw new NotifyRefusedError("UNKNOWN_CATEGORY");
  if (!Number.isInteger(event.businessId) || event.businessId <= 0 || !Number.isInteger(event.entity.id)) {
    throw new NotifyRefusedError("INVALID_EVENT");
  }
  const href = safeHref(event.href, cat.hrefPrefixes);
  if (href === null) throw new NotifyRefusedError("INVALID_HREF");
  const now = event.now;
  const userId = event.userId ?? null;
  const dedupeKey = event.dedupeKey ?? defaultDedupeKey(event);
  const cooldownHours = event.cooldownHours ?? cat.cooldownHours;
  const mayPush = categoryMayPush(cat);
  const channels = mayPush ? ["IN_APP", "PUSH"] : ["IN_APP"];
  const title = event.title.slice(0, 200);
  const summary = event.summary == null ? null : event.summary.slice(0, 500);

  const rows = await tx.$queryRaw<Array<{ id: number; inserted: boolean }>>`
    INSERT INTO "Notification" (
      "businessId", "dedupeKey", "domain", "semanticCategory", "severity",
      "entityType", "entityId", "title", "summary", "href", "userId",
      "intendedChannels", "reason", "cooldownHours",
      "firstSurfacedAt", "lastSurfacedAt", "lastNotifiedAt", "createdAt", "updatedAt"
    ) VALUES (
      ${event.businessId}, ${dedupeKey}, ${cat.domain}, ${cat.key}, ${severityOf(cat.importance)},
      ${event.entity.type}, ${event.entity.id}, ${title}, ${summary}, ${href}, ${userId},
      ${channels}::text[]::"NotificationChannel"[], ${event.reason ?? cat.key}, ${cooldownHours},
      ${utc(now)}, ${utc(now)}, NULL, ${utc(now)}, ${utc(now)}
    )
    ON CONFLICT ("businessId", "dedupeKey") DO UPDATE SET
      "title"            = EXCLUDED."title",
      "summary"          = EXCLUDED."summary",
      "href"             = EXCLUDED."href",
      "intendedChannels" = EXCLUDED."intendedChannels",
      "cooldownHours"    = EXCLUDED."cooldownHours",
      "lastSurfacedAt"   = EXCLUDED."lastSurfacedAt",
      "resolvedAt"       = NULL,
      "updatedAt"        = EXCLUDED."updatedAt"
    RETURNING "id", (xmax = 0) AS "inserted"
  `;
  const row = rows[0];
  if (!row) throw new Error("notify: upsert returned no row");

  const cutoff = new Date(now.getTime() - cooldownHours * HOUR_MS);
  const claimed = await tx.$executeRaw`
    UPDATE "Notification"
       SET "lastNotifiedAt" = ${utc(now)}, "readAt" = NULL, "dismissedAt" = NULL, "updatedAt" = ${utc(now)}
     WHERE "id" = ${row.id} AND "businessId" = ${event.businessId}
       AND ("lastNotifiedAt" IS NULL OR "lastNotifiedAt" <= ${utc(cutoff)})
  `;
  if (claimed !== 1) return { notificationId: row.id, created: row.inserted, notified: false, owedDeliveryId: null };

  await tx.notificationDelivery.create({
    data: { businessId: event.businessId, notificationId: row.id, channel: "IN_APP", status: "SENT", userId, attemptedAt: now, createdAt: now },
    select: { id: true },
  });
  let owedDeliveryId: number | null = null;
  if (mayPush) {
    const owed = await tx.notificationDelivery.create({
      data: {
        businessId: event.businessId,
        notificationId: row.id,
        channel: "PUSH",
        status: "PENDING",
        userId,
        attempts: 0,
        expiresAt: new Date(now.getTime() + cat.ttlMinutes * 60_000),
        attemptedAt: now,
        createdAt: now,
      },
      select: { id: true },
    });
    owedDeliveryId = owed.id;
  }
  return { notificationId: row.id, created: row.inserted, notified: true, owedDeliveryId };
}
