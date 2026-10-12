/**
 * Daily Tasks — the store: every database statement the task engine makes, always on a tenant transaction
 * (`app.current_business_id` set), never on the global client. SERVER-ONLY.
 *
 * Kept deliberately thin: the decisions live in task-core.ts and task.service.ts. What lives here is how a
 * decision becomes rows — the series lock, the journal insert, the fingerprint ledger.
 */
import type { Prisma, TaskEventActor, TaskEventType } from "@prisma/client";

export type TaskTx = Prisma.TransactionClient;

/** Serialises every action on one series (6.5): the second request sees the first one's result. */
export async function lockSeries(tx: TaskTx, businessId: number, seriesId: number): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: number }[]>`
    SELECT "id" FROM "TaskSeries" WHERE "id" = ${seriesId} AND "businessId" = ${businessId} FOR UPDATE`;
  return rows.length === 1;
}

/** Row-locks one task for a state change (version checks then read the locked row). */
export async function lockTask(tx: TaskTx, businessId: number, taskId: number): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: number }[]>`
    SELECT "id" FROM "Task" WHERE "id" = ${taskId} AND "businessId" = ${businessId} FOR UPDATE`;
  return rows.length === 1;
}

export async function maxSequence(tx: TaskTx, businessId: number, seriesId: number): Promise<number> {
  const agg = await tx.task.aggregate({ where: { businessId, seriesId }, _max: { sequence: true } });
  return agg._max.sequence ?? 0;
}

export type JournalEntry = {
  eventType: TaskEventType;
  actor: TaskEventActor;
  actorUserId: number | null;
  taskId?: number | null;
  seriesId?: number | null;
  payload: Record<string, unknown>;
};

/**
 * Write a request's events in order. The first carries the request's Idempotency-Key and digest (the journal's
 * line of defence, 12.9); the following ones carry `<key>:<n>`, unique per business like every journal key.
 */
export async function appendEvents(
  tx: TaskTx,
  businessId: number,
  key: string,
  digest: { value: string; keyId: string } | null,
  occurredAt: Date,
  entries: JournalEntry[],
): Promise<void> {
  for (const [i, e] of entries.entries()) {
    await tx.taskEvent.create({
      data: {
        businessId,
        taskId: e.taskId ?? null,
        seriesId: e.seriesId ?? null,
        eventType: e.eventType,
        actor: e.actor,
        actorUserId: e.actor === "SYSTEM" ? null : e.actorUserId,
        occurredAt,
        payload: e.payload as Prisma.InputJsonValue,
        idempotencyKey: i === 0 ? key : `${key}:${i + 1}`,
        requestDigest: i === 0 ? digest?.value ?? null : null,
        digestKeyId: i === 0 ? digest?.keyId ?? null : null,
      },
    });
  }
}

export type ResultRef = { taskId?: number; seriesId?: number; nextTaskId?: number; withdrawnTaskId?: number };

export async function findFingerprint(tx: TaskTx, businessId: number, key: string, freshSince: Date) {
  return tx.taskRequestLedger.findFirst({
    where: { businessId, idempotencyKey: key, createdAt: { gte: freshSince } },
    select: { requestDigest: true, digestKeyId: true, resultRef: true },
  });
}

export async function findJournalOrigin(tx: TaskTx, businessId: number, key: string) {
  return tx.taskEvent.findFirst({
    where: { businessId, idempotencyKey: key },
    select: { requestDigest: true, digestKeyId: true, taskId: true, seriesId: true, payload: true },
  });
}

export async function recordFingerprint(
  tx: TaskTx,
  businessId: number,
  key: string,
  digest: { value: string; keyId: string },
  result: ResultRef,
): Promise<void> {
  await tx.taskRequestLedger.create({
    data: {
      businessId,
      idempotencyKey: key,
      requestDigest: digest.value,
      digestKeyId: digest.keyId,
      resultRef: result as Prisma.InputJsonValue,
    },
  });
}
