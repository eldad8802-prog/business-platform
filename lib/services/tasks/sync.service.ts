/**
 * Daily Tasks — TaskSyncService: the ONLY write path of system observations (Daily Tasks spec 8.6–8.7). SERVER-ONLY.
 *
 * POST /api/tasks/sync, called by the task centre and the secretary's "היום שלי" after the agenda loads:
 *   1. takes the business's lease — at most one run every 2 minutes; a second caller gets IN_PROGRESS + retryAfter
 *      (T-Y5). A failed run releases it, so the client's retries (5s / 30s / 2m) may run;
 *   2. runs the adapters;
 *   3. records new cycles (`firstSeenAt`) with ON CONFLICT DO NOTHING;
 *   4. writes SOURCE_CLOSED_OBSERVED for open cycles that vanished from a COMPLETE (OK) result only — a FAILED or
 *      CAPPED source closes nothing (T-C8). Once per cycle: the row guard `closedObservedAt IS NULL` under the row
 *      lock, and a deterministic journal key (T-C4, T-C7);
 *   5. repairs an active series without an open occurrence (task.service.repairSeries, under the series lock);
 *   6. bumps `syncVersion` when it wrote anything, stamps `lastSyncAt` (or `lastSyncFailedAt` on failure).
 *
 * Idempotent by construction: every write is guarded by a unique key or a row guard, so a retry with the same
 * Idempotency-Key (or a parallel run) ends in the same rows and the same events.
 */
import { Prisma } from "@prisma/client";

import { tenantTx } from "@/lib/tenant/tenant-tx";
import { jerusalemDayKey } from "@/lib/utils/jerusalem-day";

import { PAYLOAD_TOKEN } from "./task-core";
import { runAllAdapters } from "./sources";
import { repairSeries } from "./task.service";
import { utcTs } from "./task.store";

export const SYNC_LEASE_MS = 2 * 60 * 1000;

export type SyncOutcome =
  | { status: "OK"; syncVersion: number; changed: boolean; newCycles: number; closed: number; repaired: number; sources: { kind: string; status: string }[] }
  | { status: "IN_PROGRESS"; syncVersion: number; retryAfterSeconds: number };

async function takeLease(businessId: number, now: Date): Promise<{ ok: true } | { ok: false; syncVersion: number; until: Date }> {
  return tenantTx(businessId, async (tx) => {
    await tx.$executeRaw`
      INSERT INTO "TaskPreferences" ("businessId", "updatedAt") VALUES (${businessId}, ${utcTs(now)})
      ON CONFLICT ("businessId") DO NOTHING`;
    const until = new Date(now.getTime() + SYNC_LEASE_MS);
    const got = await tx.$executeRaw`
      UPDATE "TaskPreferences" SET "syncLeaseUntil" = ${utcTs(until)}, "updatedAt" = ${utcTs(now)}
       WHERE "businessId" = ${businessId} AND ("syncLeaseUntil" IS NULL OR "syncLeaseUntil" <= ${utcTs(now)})`;
    if (got === 1) return { ok: true as const };
    const p = await tx.taskPreferences.findUniqueOrThrow({ where: { businessId }, select: { syncVersion: true, syncLeaseUntil: true } });
    return { ok: false as const, syncVersion: p.syncVersion, until: p.syncLeaseUntil ?? until };
  });
}

/** `runAdapters` is the adapters (tests inject a failing or capped source to prove T-C8). */
export async function runSync(businessId: number, now: Date = new Date(), runAdapters: typeof runAllAdapters = runAllAdapters): Promise<SyncOutcome> {
  const lease = await takeLease(businessId, now);
  if (!lease.ok) {
    return { status: "IN_PROGRESS", syncVersion: lease.syncVersion, retryAfterSeconds: Math.max(1, Math.ceil((lease.until.getTime() - now.getTime()) / 1000)) };
  }

  try {
    const prefs = await tenantTx(businessId, (tx) => tx.taskPreferences.findUnique({ where: { businessId }, select: { disabledSources: true } }));
    const results = await runAdapters({ businessId, now, today: jerusalemDayKey(now) }, new Set(prefs?.disabledSources ?? []));

    return await tenantTx(businessId, async (tx) => {
      let newCycles = 0;
      let closed = 0;
      let repaired = 0;

      // 3. New cycles — any item a source showed is evidence that its cycle exists, even from a partial result.
      for (const r of results) {
        if (r.status === "FAILED" || r.status === "DISABLED") continue;
        for (const i of r.items) {
          newCycles += await tx.$executeRaw`
            INSERT INTO "TaskSourceState" ("businessId", "sourceKind", "dedupeKey", "cycleKey", "evidenceVersion", "firstSeenAt", "updatedAt")
            VALUES (${businessId}, ${i.sourceKind}, ${i.dedupeKey}, ${i.cycleKey}, ${i.evidenceVersion}, ${utcTs(now)}, ${utcTs(now)})
            ON CONFLICT ("businessId", "dedupeKey", "cycleKey") DO NOTHING`;
        }
      }

      // 4. Closures — only from a complete result; absence from a partial one proves nothing.
      for (const r of results) {
        if (r.status !== "OK") continue;
        // Keys are [A-Za-z0-9:_.-] only (resolveSourceItem), so "|" cannot occur inside either part.
        const present = r.items.map((i) => `${i.dedupeKey}|${i.cycleKey}`);
        const vanished = await tx.$queryRaw<{ id: number; dedupeKey: string; cycleKey: string; evidenceVersion: string }[]>`
          UPDATE "TaskSourceState" SET "closedObservedAt" = ${utcTs(now)}, "updatedAt" = ${utcTs(now)}
           WHERE "businessId" = ${businessId} AND "sourceKind" = ${r.kind} AND "closedObservedAt" IS NULL
             AND NOT ("dedupeKey" || '|' || "cycleKey" = ANY(${present}::text[]))
          RETURNING "id", "dedupeKey", "cycleKey", "evidenceVersion"`;
        for (const v of vanished) {
          await tx.taskEvent.create({
            data: {
              businessId,
              sourceKind: r.kind,
              dedupeKey: v.dedupeKey,
              cycleKey: v.cycleKey,
              eventType: "SOURCE_CLOSED_OBSERVED",
              actor: "SYSTEM",
              actorUserId: null,
              occurredAt: now,
              payload: (PAYLOAD_TOKEN.test(v.evidenceVersion) ? { evidenceVersion: v.evidenceVersion } : {}) as Prisma.InputJsonValue,
              idempotencyKey: `sync:closed:${v.id}`,
            },
          });
          closed += 1;
        }
      }

      // 5. Series repair.
      const series = await tx.taskSeries.findMany({ where: { businessId, endedAt: null, pausedAt: null }, select: { id: true } });
      const withOpen = new Set(
        (await tx.task.findMany({ where: { businessId, status: "OPEN", seriesId: { in: series.map((s) => s.id) } }, select: { seriesId: true } })).map((t) => t.seriesId),
      );
      for (const s of series) {
        if (withOpen.has(s.id)) continue;
        if (await repairSeries(tx, businessId, s.id, now)) repaired += 1;
      }

      // 6. Bookkeeping. The lease stays until it expires: one run per 2 minutes.
      const changed = newCycles + closed + repaired > 0;
      const p = await tx.taskPreferences.update({
        where: { businessId },
        data: { lastSyncAt: now, ...(changed ? { syncVersion: { increment: 1 } } : {}) },
        select: { syncVersion: true },
      });
      return {
        status: "OK" as const,
        syncVersion: p.syncVersion,
        changed,
        newCycles,
        closed,
        repaired,
        sources: results.map((r) => ({ kind: r.kind, status: r.status })),
      };
    });
  } catch (e) {
    // The failure is recorded and the lease released, so the client's backoff retries can run (8.7).
    await tenantTx(businessId, (tx) =>
      tx.taskPreferences.update({ where: { businessId }, data: { lastSyncFailedAt: now, syncLeaseUntil: null } }),
    ).catch(() => undefined);
    throw e;
  }
}
