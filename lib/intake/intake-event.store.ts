/**
 * Business Intake · the IntakeEvent receipt store.
 *
 * The ONE place that reads or writes `IntakeEvent`. Every function runs inside a
 * tenant transaction (`withTenantTransaction`), so the table's FORCE RLS policy
 * is what decides which rows exist — a caller cannot reach another business's
 * receipts by passing its id, and a call with no tenant context sees nothing.
 *
 * LIFECYCLE
 *
 *   recordReceipts      RECEIVED (idempotent on (businessId, provider, externalEventId))
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
import type { IntakeEventKind, IntakeEventStatus, IntakeProvider } from "@prisma/client";
import { withTenantTransaction } from "@/lib/tenant/transaction";

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

export type IntakeReceiptInput = {
  provider: IntakeProvider;
  kind: IntakeEventKind;
  externalEventId: string;
  providerAccountRef: string | null;
  occurredAt: Date | null;
  payload: Prisma.InputJsonValue;
  metadata: Prisma.InputJsonValue | null;
};

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
  receipts: IntakeReceiptInput[]
): Promise<RecordedReceipt[]> {
  if (receipts.length === 0) return [];
  return withTenantTransaction(async (tx) => {
    const before = await tx.intakeEvent.findMany({
      where: {
        businessId,
        OR: receipts.map((r) => ({ provider: r.provider, externalEventId: r.externalEventId })),
      },
      select: { externalEventId: true, provider: true },
    });
    const existed = new Set(before.map((r) => `${r.provider}:${r.externalEventId}`));

    await tx.intakeEvent.createMany({
      data: receipts.map((r) => ({
        businessId,
        provider: r.provider,
        kind: r.kind,
        externalEventId: r.externalEventId,
        providerAccountRef: r.providerAccountRef,
        occurredAt: r.occurredAt,
        payload: r.payload,
        metadata: r.metadata ?? Prisma.DbNull,
      })),
      // ON CONFLICT DO NOTHING on the (businessId, provider, externalEventId)
      // unique: a concurrent duplicate delivery can never fail this transaction.
      skipDuplicates: true,
    });

    const rows = await tx.intakeEvent.findMany({
      where: {
        businessId,
        OR: receipts.map((r) => ({ provider: r.provider, externalEventId: r.externalEventId })),
      },
      select: { id: true, externalEventId: true, provider: true, status: true },
    });
    return rows.map((r) => ({
      id: r.id,
      externalEventId: r.externalEventId,
      status: r.status,
      isNew: !existed.has(`${r.provider}:${r.externalEventId}`),
    }));
  });
}

export type ClaimedEvent = {
  id: number;
  businessId: number;
  provider: IntakeProvider;
  kind: IntakeEventKind;
  externalEventId: string;
  providerAccountRef: string | null;
  occurredAt: Date | null;
  status: IntakeEventStatus;
  attempts: number;
  payload: Prisma.JsonValue | null;
  metadata: Prisma.JsonValue | null;
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
        provider: true,
        kind: true,
        externalEventId: true,
        providerAccountRef: true,
        occurredAt: true,
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
      data: { status: "PERSISTED", ...refsData(refs) },
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
      },
      data: { payload: Prisma.DbNull, payloadPurgedAt: now },
    })
  );
  return res.count;
}

/** Events of this business that are due now, oldest first. */
export async function listDueEventIds(
  businessId: number,
  now: Date = new Date(),
  limit = 25
): Promise<number[]> {
  const rows = await withTenantTransaction((tx) =>
    tx.intakeEvent.findMany({
      where: {
        businessId,
        OR: [
          { status: "RECEIVED", nextAttemptAt: null },
          { status: { in: ["RECEIVED", "PERSISTED", "FAILED"] }, nextAttemptAt: { lte: now } },
        ],
      },
      orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
      take: limit,
      select: { id: true },
    })
  );
  return rows.map((r) => r.id);
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
