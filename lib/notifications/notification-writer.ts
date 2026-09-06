/**
 * The notification writer — the memory between a snapshot and the owner.
 *
 * WHAT THIS IS AND IS NOT
 *
 * `lib/business-status` recomputes the truth on every read, and
 * `notification-policy.ts` decides which of those facts deserve a channel.
 * Neither can answer "have we already told them?", because neither stores
 * anything. This module is that storage, and nothing more:
 *
 *   business-status fact -> notification policy -> THIS -> Notification rows
 *
 * It contains no business meaning. It never decides whether something matters,
 * never invents a severity, never applies quiet hours — the policy has already
 * done all of that, including downgrading a quiet-hours push to in-app before
 * this module sees the decision. If you find yourself adding a rule here, it
 * belongs in the policy.
 *
 * WHY THE DATABASE, NOT THE APPLICATION, DECIDES
 *
 * "Check whether we already notified, then insert" is wrong under concurrency,
 * and a snapshot can easily be evaluated twice at once (two tabs, a retry, a
 * future scheduler). Both correctness questions are therefore answered by
 * atomic SQL rather than by application discipline:
 *
 *   - identity  -> INSERT .. ON CONFLICT ("businessId","dedupeKey") DO UPDATE.
 *                  The unique index decides who creates; the loser updates.
 *   - the right
 *     to notify -> a conditional UPDATE that sets `lastNotifiedAt` only if the
 *                  cooldown has expired. Exactly one racing caller sees
 *                  rowCount 1, and only that caller writes deliveries.
 *
 * Raw SQL is used deliberately for both. Prisma's `upsert` may or may not
 * compile to a native ON CONFLICT depending on the shape of the call, and a
 * silent fallback to find-then-write would reintroduce the race. A P2002 caught
 * in application code is not an option either: inside a PostgreSQL transaction
 * a failed statement aborts the whole transaction, so "try insert, catch
 * duplicate, update" cannot work here at all.
 *
 * FIELD OWNERSHIP
 *
 *   resolvedAt            — a fact-state field. The fact is in this snapshot, so
 *                           it is not resolved: always cleared on resurface.
 *   readAt, dismissedAt   — owner actions. Cleared ONLY when we re-notify,
 *                           otherwise a snapshot every few minutes would keep
 *                           un-dismissing what the owner deliberately dismissed.
 *   lastNotifiedAt        — the cooldown anchor. Survives a reopen, so a
 *                           flickering condition cannot re-notify each time it
 *                           returns.
 *   lastSurfacedAt        — bumped on every observation, notified or not.
 *
 * No path deletes anything. Resolution is a timestamp, and the only DELETE that
 * can reach these tables is the Business cascade.
 */
import { Prisma } from "@prisma/client";

import type { BusinessStatusItem } from "@/lib/business-status/types";
import { getTenantContextOrThrow } from "@/lib/tenant/context";
import { withTenantTransaction, type TenantTx } from "@/lib/tenant/transaction";

import {
  decideForSnapshot,
  type NotificationChannel,
  type NotificationDecision,
} from "./notification-policy";

/** What the writer did with one fact. Reported, never re-derived downstream. */
export type WriteOutcome = {
  dedupeKey: string;
  notificationId: number;
  /** First time this fact has ever been recorded for this business. */
  created: boolean;
  /** This pass won the right to notify, so delivery rows were written. */
  notified: boolean;
  /** The fact was previously resolved and has come back. */
  reopened: boolean;
  /** Seen again, but still inside the policy's cooldown, so nothing was sent. */
  withinCooldown: boolean;
  channels: NotificationChannel[];
};

const HOUR_MS = 3_600_000;

/**
 * Bind an instant to a `timestamp without time zone` column the same way Prisma
 * does: as the UTC wall clock.
 *
 * Passing a JS Date straight into a raw query does NOT do this. The value is
 * handed to PostgreSQL without a zone and is then read back in the SESSION time
 * zone, so a raw write and a Prisma read of the same column disagree by the
 * session offset. On a UTC database that difference is zero and the bug is
 * invisible; against a session in Asia/Jerusalem it is three hours, which is
 * exactly how it was caught. Cooldown windows are computed from these values,
 * so a silent offset here would suppress or repeat notifications.
 *
 * The explicit cast states the intent and makes the stored value independent of
 * whatever session the writer happens to run in.
 */
function utc(instant: Date) {
  return Prisma.sql`${instant.toISOString()}::timestamptz AT TIME ZONE 'UTC'`;
}

/**
 * Persist one snapshot's worth of facts.
 *
 * `now` is injected so the policy, the cooldown arithmetic and the stored
 * timestamps all agree on a single instant — a snapshot evaluated across a
 * clock tick would otherwise be able to disagree with itself.
 */
export async function persistSnapshotNotifications(
  businessId: number,
  items: BusinessStatusItem[],
  now: Date,
): Promise<WriteOutcome[]> {
  const decided = decideForSnapshot(businessId, items, now);
  if (decided.length === 0) return [];

  return withTenantTransaction(async (tx) => {
    assertTenantMatches(businessId);
    const out: WriteOutcome[] = [];
    for (const { item, decision } of decided) {
      out.push(await persistOne(tx, businessId, item, decision, now));
    }
    return out;
  });
}

/**
 * The caller names a business and the tenant transaction binds to another: that
 * is a cross-tenant write, and it is refused before any statement runs rather
 * than left for row-level security to catch under a runtime that may still be
 * privileged.
 */
function assertTenantMatches(businessId: number): void {
  const ctx = getTenantContextOrThrow();
  if (ctx.businessId !== businessId) {
    throw new Error(
      `notification writer: refusing to write for business ${businessId} inside tenant context ${ctx.businessId}`,
    );
  }
}

async function persistOne(
  tx: TenantTx,
  businessId: number,
  item: BusinessStatusItem,
  decision: NotificationDecision,
  now: Date,
): Promise<WriteOutcome> {
  const channels = decision.channels;

  // `lastNotifiedAt` is left NULL on insert rather than set to `now`, so that a
  // brand-new row and an expired-cooldown row reach the claim below in exactly
  // the same state. One path, one proof.
  const upserted = await tx.$queryRaw<
    Array<{ id: number; inserted: boolean; reopened: boolean | null }>
  >`
    -- The prev CTE is evaluated against the snapshot the statement began with,
    -- which
    -- is the only place the PRE-update state is still visible: RETURNING on an
    -- ON CONFLICT DO UPDATE reports the NEW row, where "resolvedAt" has already
    -- been cleared, so it can never tell us whether this was a reopen.
    WITH prev AS (
      SELECT "resolvedAt"
        FROM "Notification"
       WHERE "businessId" = ${businessId} AND "dedupeKey" = ${decision.dedupeKey}
    )
    INSERT INTO "Notification" (
      "businessId", "dedupeKey", "domain", "semanticCategory", "severity",
      "entityType", "entityId", "title", "summary", "href",
      "intendedChannels", "reason", "cooldownHours",
      "firstSurfacedAt", "lastSurfacedAt", "lastNotifiedAt", "createdAt", "updatedAt"
    ) VALUES (
      ${businessId}, ${decision.dedupeKey}, ${item.domain}, ${item.semanticCategory}, ${item.severity},
      ${item.entityRef.type}, ${item.entityRef.id}, ${item.title}, ${item.summary}, ${item.primaryAction.href},
      ${channels}::text[]::"NotificationChannel"[], ${decision.reason}, ${decision.cooldownHours},
      ${utc(now)}, ${utc(now)}, NULL, ${utc(now)}, ${utc(now)}
    )
    ON CONFLICT ("businessId", "dedupeKey") DO UPDATE SET
      -- The render payload is re-snapshotted: the stored copy must describe the
      -- situation as it is now, not as it was when first seen.
      "domain"           = EXCLUDED."domain",
      "semanticCategory" = EXCLUDED."semanticCategory",
      "severity"         = EXCLUDED."severity",
      "entityType"       = EXCLUDED."entityType",
      "entityId"         = EXCLUDED."entityId",
      "title"            = EXCLUDED."title",
      "summary"          = EXCLUDED."summary",
      "href"             = EXCLUDED."href",
      "intendedChannels" = EXCLUDED."intendedChannels",
      "reason"           = EXCLUDED."reason",
      "cooldownHours"    = EXCLUDED."cooldownHours",
      "lastSurfacedAt"   = EXCLUDED."lastSurfacedAt",
      -- Present in the snapshot means not resolved. Read/dismiss are the
      -- owner's and are deliberately untouched here.
      "resolvedAt"       = NULL,
      "updatedAt"        = EXCLUDED."updatedAt"
    RETURNING
      "id",
      -- xmax is 0 on a genuine INSERT and carries the locking transaction id
      -- when ON CONFLICT turned the row into an UPDATE.
      (xmax = 0) AS "inserted",
      (SELECT "resolvedAt" IS NOT NULL FROM prev) AS "reopened"
  `;

  const row = upserted[0];
  if (!row) {
    // ON CONFLICT DO UPDATE always returns its row; an empty result would mean
    // the statement did not do what this module is built on.
    throw new Error(`notification writer: upsert returned no row for ${decision.dedupeKey}`);
  }

  const cutoff = new Date(now.getTime() - decision.cooldownHours * HOUR_MS);

  // The atomic claim. Whoever flips `lastNotifiedAt` owns the notification for
  // this cooldown window; everyone else gets rowCount 0 and writes nothing.
  // Clearing read/dismissed here — and only here — is what makes a genuine
  // re-notification show up as news again.
  const claimed = await tx.$executeRaw`
    UPDATE "Notification"
       SET "lastNotifiedAt" = ${utc(now)},
           "readAt"         = NULL,
           "dismissedAt"    = NULL,
           "updatedAt"      = ${utc(now)}
     WHERE "id" = ${row.id}
       AND "businessId" = ${businessId}
       AND ("lastNotifiedAt" IS NULL OR "lastNotifiedAt" <= ${utc(cutoff)})
  `;

  const notified = claimed === 1;

  if (notified && channels.length > 0) {
    await tx.notificationDelivery.createMany({
      data: channels.map((channel) => ({
        businessId,
        notificationId: row.id,
        channel,
        // IN_APP is delivered by the row existing: the list reads Notification
        // directly, so there is no later act to wait for. PUSH is owed an
        // external attempt that nothing in this phase performs, so it stays
        // PENDING — this module never sends anything.
        status: channel === "IN_APP" ? "SENT" : "PENDING",
        attemptedAt: now,
        createdAt: now,
      })),
    });
  }

  return {
    dedupeKey: decision.dedupeKey,
    notificationId: row.id,
    created: row.inserted,
    notified,
    // NULL when there was no prior row at all, which is a creation, not a reopen.
    reopened: row.reopened === true,
    withinCooldown: !notified,
    channels,
  };
}

/* ----------------------------------------------------------- lifecycle -- */

/**
 * Owner actions. Each is a timestamp write scoped by both id and business, so
 * a guessed id from another tenant updates nothing rather than something.
 *
 * `updateMany` rather than `update` on purpose: `update` throws when its
 * where-clause matches nothing, which would turn a cross-tenant attempt into an
 * exception that reads like a bug. Returning "0 rows changed" is the honest
 * answer, and it is what the tenant tests assert on.
 */
export async function markNotificationRead(
  businessId: number,
  notificationId: number,
  now: Date,
): Promise<boolean> {
  return setLifecycleField(businessId, notificationId, { readAt: now }, now);
}

export async function dismissNotification(
  businessId: number,
  notificationId: number,
  now: Date,
): Promise<boolean> {
  return setLifecycleField(businessId, notificationId, { dismissedAt: now }, now);
}

/**
 * Marks the underlying condition gone. Not an owner action — callers are domain
 * code observing that the fact no longer holds. `lastNotifiedAt` is untouched:
 * it is the cooldown anchor and must survive so a flickering condition cannot
 * re-notify every time it returns.
 */
export async function resolveNotification(
  businessId: number,
  notificationId: number,
  now: Date,
): Promise<boolean> {
  return setLifecycleField(businessId, notificationId, { resolvedAt: now }, now);
}

async function setLifecycleField(
  businessId: number,
  notificationId: number,
  data: Prisma.NotificationUpdateManyMutationInput,
  now: Date,
): Promise<boolean> {
  return withTenantTransaction(async (tx) => {
    assertTenantMatches(businessId);
    const res = await tx.notification.updateMany({
      where: { id: notificationId, businessId },
      data: { ...data, updatedAt: now },
    });
    return res.count === 1;
  });
}
