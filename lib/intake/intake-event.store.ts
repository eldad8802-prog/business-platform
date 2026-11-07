/**
 * Business Intake · the IntakeEvent receipt store.
 *
 * The ONE place that reads or writes `IntakeEvent` (M2; provider-neutral since
 * M3 — every source's receipts live here, keyed by `sourceKey`). Every function runs inside a
 * tenant transaction (`withTenantTransaction`), so the table's FORCE RLS policy
 * is what decides which rows exist — a caller cannot reach another business's
 * receipts by passing its id, and a call with no tenant context sees nothing.
 *
 * LIFECYCLE
 *
 *   recordReceipts      RECEIVED (idempotent on (businessId, sourceKey, externalEventId))
 *   claimEvent          takes a lease: attempts+1, nextAttemptAt = now + lease.
 *                       Only one worker can hold an event; a crashed worker's
 *                       lease simply expires and the event becomes due again.
 *   markPersisted       domain records committed, enrichment pending (resumable)
 *   markProcessed       done — payload purged
 *   markIgnored         deliberately not materialised — payload purged
 *   markFailed          FAILED with a bounded code; retried on a backoff until
 *                       MAX_ATTEMPTS, then kept with nextAttemptAt = null
 *   markDeferred        not attempted (e.g. throttled): back to its prior state,
 *                       the attempt is not counted
 *
 * The payload is personal data until the event is processed. It is purged in
 * the same statement that marks the event PROCESSED or IGNORED, and nowhere
 * else is it copied.
 */

import { Prisma } from "@prisma/client";
import type { IntakeEventStatus } from "@prisma/client";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import {
  isValidEventType,
  isValidSourceKey,
  type ClaimedIntakeEvent,
  type IntakeReceiptDraft,
  type IntakeStage,
} from "@/lib/intake/core/contract";
import { isValidReceiptKey } from "@/lib/intake/core/event-identity";
import {
  oldest,
  RECOVERY_LAG_MS,
  totalsOf,
  type BusinessBacklog,
  type BusinessFlow,
  type ConnectionBacklog,
} from "@/lib/intake/intake-capacity";

/** How long a claim holds an event before another worker may take it over. */
export const INTAKE_LEASE_MS = 2 * 60 * 1000;

/** Attempts before a FAILED event stops being retried automatically. */
export const INTAKE_MAX_ATTEMPTS = 8;

/** Backoff after attempt N (1-based). The last entry repeats. */
const BACKOFF_MS = [
  30_000,
  2 * 60_000,
  10 * 60_000,
  30 * 60_000,
  60 * 60_000,
  3 * 60 * 60_000,
  6 * 60 * 60_000,
  12 * 60 * 60_000,
];

export function nextAttemptAfterFailure(attempts: number, now: Date): Date | null {
  if (attempts >= INTAKE_MAX_ATTEMPTS) return null;
  const delay = BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1];
  return new Date(now.getTime() + delay);
}

/** @deprecated M2 name — the canonical draft is {@link IntakeReceiptDraft}. */
export type IntakeReceiptInput = IntakeReceiptDraft;

/** Programming error in an adapter: never write a receipt the contract forbids. */
function assertDraft(sourceKey: string, r: IntakeReceiptDraft): void {
  if (!isValidSourceKey(sourceKey)) throw new Error("intake: invalid sourceKey");
  if (!isValidEventType(r.eventType)) throw new Error("intake: invalid eventType");
  if (!isValidReceiptKey(r.externalEventId)) throw new Error("intake: externalEventId must be a sha256 key");
  if (r.legacy && sourceKey !== "whatsapp") throw new Error("intake: legacy provider/kind is WhatsApp-only");
}

export type RecordedReceipt = {
  id: number;
  externalEventId: string;
  status: IntakeEventStatus;
  /** False when this delivery was a replay of a receipt that already existed. */
  isNew: boolean;
};

/**
 * Durably record receipts for ONE business. Idempotent: a provider replay of an
 * event already recorded inserts nothing and returns the existing row.
 *
 * Throws on any database failure — the caller must NOT acknowledge the provider
 * in that case, so the provider redelivers.
 */
export async function recordReceipts(
  businessId: number,
  sourceKey: string,
  receipts: IntakeReceiptDraft[]
): Promise<RecordedReceipt[]> {
  if (receipts.length === 0) return [];
  for (const r of receipts) assertDraft(sourceKey, r);
  const keys = [...new Set(receipts.map((r) => r.externalEventId))];
  return withTenantTransaction(async (tx) => {
    const before = await tx.intakeEvent.findMany({
      where: { businessId, sourceKey, externalEventId: { in: keys } },
      select: { externalEventId: true },
    });
    const existed = new Set(before.map((r) => r.externalEventId));

    await tx.intakeEvent.createMany({
      data: receipts.map((r) => ({
        businessId,
        sourceKey,
        family: r.family,
        eventType: r.eventType,
        dedupeBasis: r.dedupeBasis,
        lastStage: "received",
        provider: r.legacy?.provider ?? null,
        kind: r.legacy?.kind ?? null,
        externalEventId: r.externalEventId,
        providerAccountRef: r.providerAccountRef,
        occurredAt: r.occurredAt,
        payload: r.payload,
        metadata: r.metadata ?? Prisma.DbNull,
      })),
      // ON CONFLICT DO NOTHING on the (businessId, sourceKey, externalEventId)
      // unique: a concurrent duplicate delivery can never fail this transaction.
      skipDuplicates: true,
    });

    const rows = await tx.intakeEvent.findMany({
      where: { businessId, sourceKey, externalEventId: { in: keys } },
      select: { id: true, externalEventId: true, status: true },
    });
    return rows.map((r) => ({
      id: r.id,
      externalEventId: r.externalEventId,
      status: r.status,
      isNew: !existed.has(r.externalEventId),
    }));
  });
}

export type ClaimedEvent = ClaimedIntakeEvent & {
  lastStage: string | null;
  messageId: number | null;
  conversationId: number | null;
  customerId: number | null;
};

/**
 * Take the lease on one event, or return null when it is not due, already
 * finished, or held by another worker. The conditional UPDATE is the lock: two
 * workers racing for the same event cannot both see count = 1.
 */
export async function claimEvent(
  businessId: number,
  eventId: number,
  now: Date = new Date()
): Promise<ClaimedEvent | null> {
  return withTenantTransaction(async (tx) => {
    const leaseUntil = new Date(now.getTime() + INTAKE_LEASE_MS);
    const claimed = await tx.intakeEvent.updateMany({
      where: {
        id: eventId,
        businessId,
        OR: [
          { status: "RECEIVED", nextAttemptAt: null },
          { status: { in: ["RECEIVED", "PERSISTED", "FAILED"] }, nextAttemptAt: { lte: now } },
        ],
      },
      data: {
        attempts: { increment: 1 },
        lastAttemptAt: now,
        nextAttemptAt: leaseUntil,
      },
    });
    if (claimed.count !== 1) return null;
    return tx.intakeEvent.findFirst({
      where: { id: eventId, businessId },
      select: {
        id: true,
        businessId: true,
        sourceKey: true,
        family: true,
        eventType: true,
        lastStage: true,
        externalEventId: true,
        providerAccountRef: true,
        occurredAt: true,
        receivedAt: true,
        status: true,
        attempts: true,
        payload: true,
        metadata: true,
        messageId: true,
        conversationId: true,
        customerId: true,
      },
    });
  });
}

export type IntakeOutcomeRefs = {
  messageId?: number | null;
  conversationId?: number | null;
  customerId?: number | null;
};

function refsData(refs: IntakeOutcomeRefs | undefined) {
  const data: IntakeOutcomeRefs = {};
  if (refs?.messageId !== undefined) data.messageId = refs.messageId;
  if (refs?.conversationId !== undefined) data.conversationId = refs.conversationId;
  if (refs?.customerId !== undefined) data.customerId = refs.customerId;
  return data;
}

/**
 * The domain records exist; enrichment has not finished. The payload is kept,
 * because a resumed attempt needs nothing from it that the Message does not
 * already hold — but the lease is kept too, so the same worker finishes.
 */
export async function markPersisted(
  businessId: number,
  eventId: number,
  refs: IntakeOutcomeRefs
): Promise<void> {
  await withTenantTransaction((tx) =>
    tx.intakeEvent.updateMany({
      where: { id: eventId, businessId },
      data: { status: "PERSISTED", lastStage: "routed", ...refsData(refs) },
    })
  );
}

export async function markProcessed(
  businessId: number,
  eventId: number,
  refs?: IntakeOutcomeRefs,
  now: Date = new Date()
): Promise<void> {
  await withTenantTransaction((tx) =>
    tx.intakeEvent.updateMany({
      where: { id: eventId, businessId },
      data: {
        status: "PROCESSED",
        lastStage: "completed",
        processedAt: now,
        nextAttemptAt: null,
        lastErrorCode: null,
        payload: Prisma.DbNull,
        payloadPurgedAt: now,
        ...refsData(refs),
      },
    })
  );
}

export async function markIgnored(
  businessId: number,
  eventId: number,
  reasonCode: string,
  refs?: IntakeOutcomeRefs,
  now: Date = new Date()
): Promise<void> {
  await withTenantTransaction((tx) =>
    tx.intakeEvent.updateMany({
      where: { id: eventId, businessId },
      data: {
        status: "IGNORED",
        lastStage: "completed",
        processedAt: now,
        nextAttemptAt: null,
        lastErrorCode: boundedCode(reasonCode),
        payload: Prisma.DbNull,
        payloadPurgedAt: now,
        ...refsData(refs),
      },
    })
  );
}

/**
 * The attempt failed. A PERSISTED event stays PERSISTED while it has retries left
 * (its domain records are real; only enrichment is retried). Every other state —
 * and a PERSISTED event whose attempts are exhausted — becomes FAILED.
 */
export async function markFailed(
  businessId: number,
  event: Pick<ClaimedEvent, "id" | "attempts" | "status">,
  errorCode: string,
  now: Date = new Date()
): Promise<void> {
  const next = nextAttemptAfterFailure(event.attempts, now);
  await withTenantTransaction((tx) =>
    tx.intakeEvent.updateMany({
      where: { id: event.id, businessId },
      data: {
        // Exhausted → terminal FAILED (null nextAttemptAt is only "fresh" for RECEIVED).
        status: event.status === "PERSISTED" && next !== null ? "PERSISTED" : "FAILED",
        nextAttemptAt: next,
        lastErrorCode: boundedCode(errorCode),
      },
    })
  );
}

/**
 * M6 — a notification-only source completed its receipt (hydrate). The payload stays PERSONAL DATA
 * under the same purge rules; only an unfinished receipt (not completed, payload not purged) changes.
 */
export async function replacePayload(
  businessId: number,
  eventId: number,
  payload: Prisma.InputJsonValue,
  metadata?: Prisma.InputJsonValue
): Promise<void> {
  await withTenantTransaction((tx) =>
    tx.intakeEvent.updateMany({
      where: { id: eventId, businessId, payloadPurgedAt: null, status: { in: ["RECEIVED", "FAILED"] } },
      data: { payload, ...(metadata !== undefined ? { metadata } : {}) },
    })
  );
}

/** Record how far processing got (normalized / routed), without other changes. */
export async function markStage(businessId: number, eventId: number, stage: IntakeStage): Promise<void> {
  await withTenantTransaction((tx) =>
    tx.intakeEvent.updateMany({ where: { id: eventId, businessId }, data: { lastStage: stage } })
  );
}

/**
 * Terminal now: a failure retrying cannot fix (malformed payload, an adapter's
 * explicit terminal error). FAILED with no next attempt — the payload is kept
 * for the bounded operator-replay window, then purged like any exhausted event.
 */
export async function markDeadLetter(businessId: number, eventId: number, errorCode: string): Promise<void> {
  await withTenantTransaction((tx) =>
    tx.intakeEvent.updateMany({
      where: { id: eventId, businessId },
      data: { status: "FAILED", nextAttemptAt: null, lastErrorCode: boundedCode(errorCode) },
    })
  );
}

/** Not attempted (throttled, provider asked us to wait). The attempt is not counted. */
export async function markDeferred(
  businessId: number,
  event: Pick<ClaimedEvent, "id" | "status">,
  until: Date,
  reasonCode: string
): Promise<void> {
  await withTenantTransaction((tx) =>
    tx.intakeEvent.updateMany({
      where: { id: event.id, businessId },
      data: {
        attempts: { decrement: 1 },
        nextAttemptAt: until,
        lastErrorCode: boundedCode(reasonCode),
      },
    })
  );
}

/**
 * Leads L1 · G-06 — the owner fixed what blocked a connection's receipts (e.g. saved a working API key):
 * every receipt of THAT connection still waiting on, or dead-lettered by, one of `codes` — and whose
 * payload is still kept — is due again now, with a fresh attempt budget. Purged receipts stay settled
 * (nothing left to act on); other connections and other failures are untouched.
 */
export async function rearmBlockedEvents(
  businessId: number,
  sourceKey: string,
  providerAccountRef: string,
  codes: readonly string[],
  now: Date = new Date()
): Promise<number> {
  const bounded = codes.map(boundedCode);
  return withTenantTransaction(async (tx) => {
    // A re-armed receipt that dead-letters again must be reported again (G-07): drop its "reported" stamp.
    await tx.$executeRaw`
      UPDATE "IntakeEvent" SET "metadata" = "metadata" - 'deadLetterReportedAt'
       WHERE "businessId" = ${businessId} AND "sourceKey" = ${sourceKey} AND "providerAccountRef" = ${providerAccountRef}
         AND "lastErrorCode" = ANY(${bounded}::text[]) AND "payloadPurgedAt" IS NULL
         AND ("metadata" -> 'deadLetterReportedAt') IS NOT NULL`;
    const res = await tx.intakeEvent.updateMany({
      where: {
        businessId,
        sourceKey,
        providerAccountRef,
        status: { in: ["RECEIVED", "PERSISTED", "FAILED"] },
        lastErrorCode: { in: bounded },
        payloadPurgedAt: null,
      },
      data: { status: "RECEIVED", nextAttemptAt: now, attempts: 0 },
    });
    return res.count;
  });
}

/** L1.5-b · PR-5 — most receipts one health read stamps as reported (per kind), so it stays inside its transaction. */
export const HEALTH_STAMP_BATCH = 2000;

/** A receipt still unfinished this long after arrival is a stuck backlog the operator should see. */
export const STALE_PENDING_AFTER_MS = 24 * 60 * 60 * 1000;

export type IntakeHealthCounts = {
  /** Dead letters no sweep has reported yet — by ANY path (webhook-time drain or a sweep); now reported. */
  deadLettersNew: number;
  /** Every dead letter whose payload is still kept (replayable). */
  deadLettersOpen: number;
  /** Receipts not finished (waiting / deferred / retrying) that arrived longer ago than STALE_PENDING_AFTER_MS. */
  pendingStale: number;
  /** L1.5-a — of those, the ones no sweep had reported yet; now reported (same once-only rule as dead letters). */
  pendingStaleNew: number;
  /** L1.5-a — receipts waiting on a hold (emergency switch, entitlement withdrawn, quarantine): never deleted here. */
  held: number;
};

/**
 * Leads L1 · G-07 — the business-event health of ONE business's receipts, as counts only (no id, no
 * content). Read inside the business's tenant job by the sweeper.
 *
 * A dead letter is reported EXACTLY ONCE: the first sweep after it happened (whichever path dead-lettered
 * it) counts it and stamps `metadata.deadLetterReportedAt` (non-personal) in the same statement, so the
 * scheduler goes red once per new dead letter — never silently green, never red forever.
 *
 * L1.5-a — a receipt still unfinished a day after arrival (deferred forever, retrying, never claimed) follows
 * the same rule: the first sweep that sees it stale counts it in `pendingStaleNew` and stamps
 * `metadata.staleReportedAt`, so it turns the run red once instead of only appearing as a count.
 */
export async function intakeHealthCounts(businessId: number, now: Date = new Date()): Promise<IntakeHealthCounts> {
  return withTenantTransaction(async (tx) => {
    const deadLetter = { businessId, status: "FAILED" as const, nextAttemptAt: null };
    // L1.5-b · PR-5 — both stamps are bounded (HEALTH_STAMP_BATCH per run, oldest first): an unbounded stamp over a
    // large backlog outgrew the transaction timeout, rolled back, and failed again on every run. Each receipt is still
    // reported exactly once; a big backlog is reported over a few runs (the run stays red until it is all reported).
    const deadLettersNew = await tx.$executeRaw`
      UPDATE "IntakeEvent"
         SET "metadata" = COALESCE("metadata", '{}'::jsonb) || jsonb_build_object('deadLetterReportedAt', ${now.toISOString()}::text)
       WHERE "id" IN (
               SELECT d."id" FROM "IntakeEvent" d
                WHERE d."businessId" = ${businessId}::int AND d."status" = 'FAILED' AND d."nextAttemptAt" IS NULL
                  AND (d."metadata" -> 'deadLetterReportedAt') IS NULL
                ORDER BY d."id"
                LIMIT ${HEALTH_STAMP_BATCH}::int)
         AND ("metadata" -> 'deadLetterReportedAt') IS NULL`;
    const deadLettersOpen = await tx.intakeEvent.count({ where: { ...deadLetter, payloadPurgedAt: null } });
    const staleBefore = new Date(now.getTime() - STALE_PENDING_AFTER_MS);
    // Same predicate as `pendingStale` below (unfinished: waiting, deferred, persisted, or failed with a retry due).
    const pendingStaleNew = await tx.$executeRaw`
      UPDATE "IntakeEvent"
         SET "metadata" = COALESCE("metadata", '{}'::jsonb) || jsonb_build_object('staleReportedAt', ${now.toISOString()}::text)
       WHERE "id" IN (
               SELECT p."id" FROM "IntakeEvent" p
                WHERE p."businessId" = ${businessId}::int AND p."receivedAt" < ${utc(staleBefore)}
                  AND (p."status" IN ('RECEIVED', 'PERSISTED') OR (p."status" = 'FAILED' AND p."nextAttemptAt" IS NOT NULL))
                  AND (p."metadata" -> 'staleReportedAt') IS NULL
                ORDER BY p."receivedAt", p."id"
                LIMIT ${HEALTH_STAMP_BATCH}::int)
         AND ("metadata" -> 'staleReportedAt') IS NULL`;
    const pendingStale = await tx.intakeEvent.count({
      where: {
        businessId,
        receivedAt: { lt: staleBefore },
        OR: [{ status: { in: ["RECEIVED", "PERSISTED"] } }, { status: "FAILED", nextAttemptAt: { not: null } }],
      },
    });
    // Unfinished and currently deferred by holdUnlessAllowed (lastErrorCode "held:…"), whatever their age.
    const held = await tx.intakeEvent.count({
      where: {
        businessId,
        lastErrorCode: { startsWith: "held:" },
        OR: [{ status: { in: ["RECEIVED", "PERSISTED"] } }, { status: "FAILED", nextAttemptAt: { not: null } }],
      },
    });
    return { deadLettersNew, deadLettersOpen, pendingStale, pendingStaleNew, held };
  });
}

/**
 * Payload retention for receipts that will never be processed: a FAILED event
 * whose retries are exhausted keeps its payload for a bounded window (so an
 * operator can replay it), then loses it. The receipt itself — identity,
 * lifecycle, error code, non-personal metadata — is kept.
 */
export const FAILED_PAYLOAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export async function purgeExpiredFailedPayloads(
  businessId: number,
  now: Date = new Date()
): Promise<number> {
  const cutoff = new Date(now.getTime() - FAILED_PAYLOAD_RETENTION_MS);
  const res = await withTenantTransaction((tx) =>
    tx.intakeEvent.updateMany({
      where: {
        businessId,
        status: "FAILED",
        nextAttemptAt: null,
        lastAttemptAt: { lt: cutoff },
        payloadPurgedAt: null,
        // L1.5-b · PR-6 — an EXPIRED held receipt is dead-lettered but its payload is never purged here: expiry must
        // not delete data through the dead-letter retention. Purging an expired payload is a separate, explicit owner
        // decision (a privacy policy) and a separate mechanism.
        OR: [{ lastErrorCode: null }, { NOT: { lastErrorCode: { startsWith: "expired:" } } }],
      },
      data: { payload: Prisma.DbNull, payloadPurgedAt: now },
    })
  );
  return res.count;
}

/**
 * L1.5-b · PR-1 — the share of a drain's budget always kept for each lane when the other is full: at least one in
 * five slots. A business with thousands of held receipts still gets its ready work done every run, and a business
 * with a busy ready queue still re-looks at (and so releases) its held receipts every run.
 */
export function laneReserve(limit: number): number {
  return Math.max(1, Math.floor(limit / 5));
}

/**
 * Split a drain's budget between the two lanes (pure). Each lane is guaranteed min(its due count, reserve);
 * whatever one lane does not use goes to the other; the total never exceeds `limit`.
 *   ready  due receipts that are not waiting on a hold — new, retrying, a dead worker's lease, resumable;
 *   held   due receipts whose last look found a hold (`held:*`) — re-looked at, and released once it lifts.
 */
export function pickLanes(ready: number[], held: number[], limit: number): number[] {
  const reserve = Math.min(laneReserve(limit), limit);
  const heldTake = Math.min(held.length, Math.max(reserve, limit - ready.length));
  const readyTake = Math.min(ready.length, limit - heldTake);
  return [...ready.slice(0, readyTake), ...held.slice(0, heldTake)];
}

/** A JS instant as the UTC wall time Prisma stores in `timestamp(3)` columns, whatever the session's TimeZone. */
const utc = (d: Date) => Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

/**
 * One lane's due receipts, fair across what feeds it: round-robin by source (ready) or by connection (held — a
 * hold is decided per connection), oldest first within each, so one source's backlog never starves another's.
 * Due = exactly claimEvent's condition; a receipt under a live lease is never listed.
 */
async function dueLane(
  tx: Prisma.TransactionClient,
  businessId: number,
  now: Date,
  limit: number,
  held: boolean
): Promise<number[]> {
  if (limit <= 0) return [];
  const rows = held
    ? await tx.$queryRaw<{ id: number }[]>`
        SELECT d."id" FROM (
          SELECT e."id", e."receivedAt",
                 ROW_NUMBER() OVER (PARTITION BY e."sourceKey", e."providerAccountRef" ORDER BY e."receivedAt", e."id") AS rn
            FROM "IntakeEvent" e
           WHERE e."businessId" = ${businessId}::int
             AND ((e."status" = 'RECEIVED' AND e."nextAttemptAt" IS NULL)
                  OR (e."status" IN ('RECEIVED', 'PERSISTED', 'FAILED') AND e."nextAttemptAt" <= ${utc(now)}))
             AND e."lastErrorCode" LIKE 'held:%'
        ) d
        ORDER BY d.rn, d."receivedAt", d."id"
        LIMIT ${limit}::int`
    : await tx.$queryRaw<{ id: number }[]>`
        SELECT d."id" FROM (
          SELECT e."id", e."receivedAt",
                 ROW_NUMBER() OVER (PARTITION BY e."sourceKey" ORDER BY e."receivedAt", e."id") AS rn
            FROM "IntakeEvent" e
           WHERE e."businessId" = ${businessId}::int
             AND ((e."status" = 'RECEIVED' AND e."nextAttemptAt" IS NULL)
                  OR (e."status" IN ('RECEIVED', 'PERSISTED', 'FAILED') AND e."nextAttemptAt" <= ${utc(now)}))
             AND (e."lastErrorCode" IS NULL OR e."lastErrorCode" NOT LIKE 'held:%')
        ) d
        ORDER BY d.rn, d."receivedAt", d."id"
        LIMIT ${limit}::int`;
  return rows.map((r) => Number(r.id));
}

/**
 * Events of this business that are due now, in two lanes (L1.5-b · PR-1): ready work first, held receipts in their
 * own reserved share — so held receipts can never fill the whole budget, and are still re-looked at every run.
 * Listing only proposes ids; claimEvent's lease is still what decides who processes a receipt.
 */
export async function listDueEventIds(
  businessId: number,
  now: Date = new Date(),
  limit = 25
): Promise<number[]> {
  return withTenantTransaction(async (tx) => {
    const ready = await dueLane(tx, businessId, now, limit, false);
    const held = await dueLane(tx, businessId, now, limit, true);
    return pickLanes(ready, held, limit);
  });
}

/** Most held siblings one look settles (L1.5-b · PR-1); a larger backlog is settled by the held lane's next looks. */
export const SIBLING_BATCH = 1000;
/** Server-side ceiling for that one statement — well inside the 5 s interactive-transaction timeout. */
const SIBLING_STATEMENT_TIMEOUT_MS = 3000;

/**
 * L1.5-b · PR-1 — one look settles the connection. A hold is decided per (business, source, connection) — the
 * revoked / paused state of the connection, the source gate, the business — never per receipt (gate.ts). So when
 * the look at one receipt finds its connection still held, every OTHER receipt of that connection that was already
 * waiting on a hold and is due now waits the same `until` — up to SIBLING_BATCH of them, in one statement — instead
 * of each being claimed and deferred on its own. Attempts are untouched (none was taken). A receipt under a live lease, a receipt that never
 * waited on a hold (new, or retrying a failure), and other connections are not touched. Returns how many waited.
 */
export async function deferHeldSiblings(
  businessId: number,
  probe: { id: number; sourceKey: string; providerAccountRef: string | null },
  until: Date,
  code: string,
  now: Date = new Date()
): Promise<number> {
  if (!code.startsWith("held:")) return 0;
  // Bounded: at most SIBLING_BATCH rows per look (oldest first), picked ONCE (MATERIALIZED, whatever the planner
  // thinks of the table's statistics) and under a server-side statement timeout, so this statement can neither run
  // long nor keep row locks past the transaction; a larger backlog is settled by the held lane's next looks.
  // SKIP LOCKED: a row a racing worker is claiming right now is left to that worker.
  return withTenantTransaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('statement_timeout', ${String(SIBLING_STATEMENT_TIMEOUT_MS)}, true)`;
    return tx.$executeRaw`
      WITH picked AS MATERIALIZED (
        SELECT s."id" FROM "IntakeEvent" s
         WHERE s."businessId" = ${businessId}::int
           AND s."sourceKey" = ${probe.sourceKey}::text
           AND s."providerAccountRef" IS NOT DISTINCT FROM ${probe.providerAccountRef}::text
           AND s."id" <> ${probe.id}::int
           AND s."lastErrorCode" LIKE 'held:%'
           AND ((s."status" = 'RECEIVED' AND s."nextAttemptAt" IS NULL)
                OR (s."status" IN ('RECEIVED', 'PERSISTED', 'FAILED') AND s."nextAttemptAt" <= ${utc(now)}))
         ORDER BY s."receivedAt", s."id"
         LIMIT ${SIBLING_BATCH}::int
           FOR UPDATE SKIP LOCKED
      )
      UPDATE "IntakeEvent" e
         SET "nextAttemptAt" = ${utc(until)}, "lastErrorCode" = ${boundedCode(code)}, "updatedAt" = ${utc(now)}
        FROM picked
       WHERE e."id" = picked."id"
         AND e."businessId" = ${businessId}::int
         AND e."lastErrorCode" LIKE 'held:%'
         AND ((e."status" = 'RECEIVED' AND e."nextAttemptAt" IS NULL)
              OR (e."status" IN ('RECEIVED', 'PERSISTED', 'FAILED') AND e."nextAttemptAt" <= ${utc(now)}))`;
  });
}

/**
 * A failure code that cannot carry payload content: the error's class and, for
 * Prisma, its code — never `error.message`, which can echo values.
 */
export function errorCodeOf(error: unknown): string {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return `prisma:${error.code}`;
  if (error instanceof Prisma.PrismaClientValidationError) return "prisma:validation";
  if (error instanceof Prisma.PrismaClientUnknownRequestError) return "prisma:unknown";
  if (error instanceof Error) return `error:${error.name}`;
  return "error:unknown";
}

function boundedCode(code: string): string {
  return code.replace(/[^A-Za-z0-9:_.\-]/g, "_").slice(0, 64);
}

/** L1.5-b · PR-5 — receipts one resume batch re-arms; each batch is its own short transaction. */
export const REARM_BATCH = 1000;
/** Wall-clock budget for re-arming after a resume; whatever is left is released by the hold recheck (≤ 10 min). */
export const REARM_BUDGET_MS = 8000;

/**
 * L1.5-b · PR-5 — a resumed connection's paused receipts become due NOW, in bounded batches AFTER the resume has
 * committed (no single transaction grows with the backlog). This only ACCELERATES release: a receipt not re-armed
 * here (budget spent, a batch failed, the process stopped) still comes due at its next hold recheck, and the
 * processor then finds the connection ACTIVE and processes it. Only `held:connection_paused` receipts of THIS
 * connection whose payload is kept and that are waiting for a later look; a receipt a worker holds under its lease
 * is never re-armed (that would let a second worker claim it), and a row being updated right now is skipped.
 * Returns how many were re-armed.
 */
export async function rearmPausedReceipts(
  sourceKey: string,
  providerAccountRef: string,
  now: Date = new Date(),
  opts: { batch?: number; budgetMs?: number; clock?: () => number } = {}
): Promise<number> {
  const batch = opts.batch ?? REARM_BATCH;
  const clock = opts.clock ?? Date.now;
  const stopAt = clock() + (opts.budgetMs ?? REARM_BUDGET_MS);
  let total = 0;
  while (clock() < stopAt) {
    const n = await withTenantTransaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('statement_timeout', ${String(SIBLING_STATEMENT_TIMEOUT_MS)}, true)`;
      return tx.$executeRaw`
        WITH picked AS MATERIALIZED (
          SELECT s."id" FROM "IntakeEvent" s
           WHERE s."sourceKey" = ${sourceKey}::text
             AND s."providerAccountRef" = ${providerAccountRef}::text
             AND s."lastErrorCode" = 'held:connection_paused'
             AND s."status" IN ('RECEIVED', 'PERSISTED', 'FAILED')
             AND s."payloadPurgedAt" IS NULL
             -- waiting for a later look (already-due rows need nothing) …
             AND s."nextAttemptAt" > ${utc(now)}
             -- … but never a row a worker holds right now: claimEvent leases exactly lastAttemptAt + INTAKE_LEASE_MS,
             -- while a hold waits HOLD_RECHECK_MS (longer) from its look. Re-arming a lease would let a second worker in.
             AND (s."lastAttemptAt" IS NULL OR s."nextAttemptAt" > s."lastAttemptAt" + make_interval(secs => ${INTAKE_LEASE_MS / 1000}::int))
           -- no ORDER BY: which receipts are re-armed first does not matter (all become due); no sort over the backlog
           LIMIT ${batch}::int
             FOR UPDATE SKIP LOCKED
        )
        UPDATE "IntakeEvent" e
           SET "nextAttemptAt" = ${utc(now)}, "updatedAt" = ${utc(now)}
          FROM picked
         WHERE e."id" = picked."id"`;
    });
    total += n;
    if (n < batch) break;
  }
  return total;
/** L1.5-b · PR-2 — most unfinished receipts one backlog read scans; beyond it every count is a lower bound. */
export const BACKLOG_SCAN_CAP = 25_000;
/** Server-side ceiling for a capacity read: a metric never holds a connection or a lock for long. */
const CAPACITY_STATEMENT_TIMEOUT_MS = 3000;
/** Flow window for "processed / recovered in the last hour": receipts that arrived within this many days. */
export const FLOW_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

type BacklogRow = { sourceKey: string; providerAccountRef: string | null; cls: string; reason: string | null; n: number; oldest: Date | null };

/**
 * L1.5-b · PR-2 — the business's unfinished receipts by connection and class (counts + oldest arrival only): held
 * (by reason), due, retrying, dead letters still replayable. One aggregate over at most `scanCap` rows (index
 * IntakeEvent(businessId, status, nextAttemptAt)) under a server statement timeout; `capped` says the counts are
 * lower bounds. Finished receipts (PROCESSED / IGNORED) and dead letters whose payload is gone are not scanned, so
 * the cost follows the open backlog, never the history. Read-only; under the business's RLS.
 */
export async function intakeBacklog(
  businessId: number,
  now: Date = new Date(),
  opts: { scanCap?: number } = {}
): Promise<BusinessBacklog> {
  const cap = opts.scanCap ?? BACKLOG_SCAN_CAP;
  return withTenantTransaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('statement_timeout', ${String(CAPACITY_STATEMENT_TIMEOUT_MS)}, true)`;
    const rows = await tx.$queryRaw<BacklogRow[]>`
      WITH u AS (
        SELECT e."sourceKey", e."providerAccountRef", e."status", e."nextAttemptAt", e."lastErrorCode", e."receivedAt"
          FROM "IntakeEvent" e
         WHERE e."businessId" = ${businessId}::int
           AND e."status" IN ('RECEIVED', 'PERSISTED', 'FAILED')
           AND (e."status" <> 'FAILED' OR e."nextAttemptAt" IS NOT NULL OR e."payloadPurgedAt" IS NULL)
         LIMIT ${cap + 1}::int
      ), c AS (
        SELECT "sourceKey", "providerAccountRef", "receivedAt",
               CASE
                 WHEN "status" = 'FAILED' AND "nextAttemptAt" IS NULL THEN 'dead'
                 WHEN "lastErrorCode" LIKE 'held:%' THEN 'held'
                 WHEN "nextAttemptAt" IS NULL OR "nextAttemptAt" <= ${utc(now)} THEN 'due'
                 ELSE 'retrying'
               END AS cls,
               CASE WHEN "lastErrorCode" LIKE 'held:%' THEN substr("lastErrorCode", 6) END AS reason
          FROM u
      )
      SELECT "sourceKey", "providerAccountRef", cls, CASE WHEN cls = 'held' THEN reason END AS reason,
             count(*)::int AS n, min("receivedAt") AS oldest
        FROM c
       GROUP BY 1, 2, 3, 4`;
    const scanned = rows.reduce((a, r) => a + Number(r.n), 0);
    const byConn = new Map<string, ConnectionBacklog>();
    for (const r of rows) {
      const key = `${r.sourceKey}\u0000${r.providerAccountRef ?? ""}`;
      const c = byConn.get(key) ?? {
        sourceKey: r.sourceKey, providerAccountRef: r.providerAccountRef, held: 0, heldByReason: {}, due: 0, retrying: 0, deadLetters: 0,
        oldestHeldAt: null, oldestUnfinishedAt: null,
      };
      const n = Number(r.n);
      if (r.cls === "held") {
        c.held += n;
        const reason = r.reason ?? "unknown";
        c.heldByReason[reason] = (c.heldByReason[reason] ?? 0) + n;
        c.oldestHeldAt = oldest([c.oldestHeldAt, r.oldest]);
      } else if (r.cls === "due") c.due += n;
      else if (r.cls === "retrying") c.retrying += n;
      else c.deadLetters += n;
      c.oldestUnfinishedAt = oldest([c.oldestUnfinishedAt, r.oldest]);
      byConn.set(key, c);
    }
    const connections = [...byConn.values()].sort((a, b) => a.sourceKey.localeCompare(b.sourceKey) || (a.providerAccountRef ?? "").localeCompare(b.providerAccountRef ?? ""));
    return { connections, totals: totalsOf(connections), oldestHeldAt: oldest(connections.map((c) => c.oldestHeldAt)), capped: scanned > cap };
  });
}

/**
 * L1.5-b · PR-2 — the business's flow (sweep only): receipts received in the last hour / day, processed in the last
 * hour, and of those the ones processed more than RECOVERY_LAG_MS after arrival (released holds, late retries). Each
 * count scans at most `scanCap` rows through IntakeEvent(businessId, receivedAt); "processed" looks only at receipts
 * that arrived within FLOW_LOOKBACK_MS (a release of something older is not counted — a lower bound).
 */
export async function intakeFlow(
  businessId: number,
  now: Date = new Date(),
  opts: { scanCap?: number } = {}
): Promise<BusinessFlow> {
  const cap = opts.scanCap ?? BACKLOG_SCAN_CAP;
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const lookback = new Date(now.getTime() - FLOW_LOOKBACK_MS);
  return withTenantTransaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('statement_timeout', ${String(CAPACITY_STATEMENT_TIMEOUT_MS)}, true)`;
    const [r] = await tx.$queryRaw<{ day: number; hour: number; done: number; recovered: number }[]>`
      WITH p AS (
        SELECT e."processedAt", e."receivedAt" FROM "IntakeEvent" e
         WHERE e."businessId" = ${businessId}::int AND e."receivedAt" >= ${utc(lookback)}
           AND e."status" = 'PROCESSED' AND e."processedAt" >= ${utc(hourAgo)}
         LIMIT ${cap + 1}::int
      )
      SELECT
        (SELECT count(*) FROM (SELECT 1 FROM "IntakeEvent" WHERE "businessId" = ${businessId}::int AND "receivedAt" >= ${utc(dayAgo)} LIMIT ${cap + 1}::int) d)::int AS day,
        (SELECT count(*) FROM (SELECT 1 FROM "IntakeEvent" WHERE "businessId" = ${businessId}::int AND "receivedAt" >= ${utc(hourAgo)} LIMIT ${cap + 1}::int) h)::int AS hour,
        (SELECT count(*) FROM p)::int AS done,
        (SELECT count(*) FROM p WHERE p."processedAt" - p."receivedAt" > make_interval(secs => ${RECOVERY_LAG_MS / 1000}::int))::int AS recovered`;
    const day = Number(r.day), hour = Number(r.hour), done = Number(r.done), recovered = Number(r.recovered);
    return {
      receivedLastHour: Math.min(hour, cap), receivedLastDay: Math.min(day, cap), processedLastHour: Math.min(done, cap),
      recoveredLastHour: Math.min(recovered, cap), capped: day > cap || done > cap,
    };
  });
}

/**
 * L1.5-b · PR-2 — "this business reached `tier` held receipts" is reported ONCE per crossing. A crossing is new when
 * the business holds at least `tier` receipts but fewer than `tier` of them carry the stamp
 * `metadata.heldTier<tier>At` (non-personal); the run that finds it stamps the NEWEST `tier` held receipts and
 * reports. Releasing the oldest, or new arrivals while above the tier, never re-reports (the stamped newest stay held
 * and stamped); falling below the tier and rising again does (fewer than `tier` stamped remain). Only called when
 * capacity alerts are switched on. Bounded: one count over the held rows, an update of at most `tier` rows.
 */
export async function claimHeldTierCrossing(businessId: number, tier: number, now: Date = new Date()): Promise<boolean> {
  if (!Number.isInteger(tier) || tier <= 0) return false;
  const key = `heldTier${tier}At`;
  return withTenantTransaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('statement_timeout', ${String(CAPACITY_STATEMENT_TIMEOUT_MS)}, true)`;
    const [c] = await tx.$queryRaw<{ held: number; stamped: number }[]>`
      SELECT count(*)::int AS held, count(*) FILTER (WHERE COALESCE(e."metadata", '{}'::jsonb) ? ${key}::text)::int AS stamped
        FROM "IntakeEvent" e
       WHERE e."businessId" = ${businessId}::int
         AND e."lastErrorCode" LIKE 'held:%'
         AND (e."status" IN ('RECEIVED', 'PERSISTED') OR (e."status" = 'FAILED' AND e."nextAttemptAt" IS NOT NULL))`;
    if (Number(c.held) < tier || Number(c.stamped) >= tier) return false;
    await tx.$executeRaw`
      UPDATE "IntakeEvent"
         SET "metadata" = COALESCE("metadata", '{}'::jsonb) || jsonb_build_object(${key}::text, ${now.toISOString()}::text)
       WHERE "id" IN (
               SELECT e."id" FROM "IntakeEvent" e
                WHERE e."businessId" = ${businessId}::int
                  AND e."lastErrorCode" LIKE 'held:%'
                  AND (e."status" IN ('RECEIVED', 'PERSISTED') OR (e."status" = 'FAILED' AND e."nextAttemptAt" IS NOT NULL))
                ORDER BY e."receivedAt" DESC, e."id" DESC
                LIMIT ${tier}::int)
         AND "businessId" = ${businessId}::int`;
    return true;
  });
}
