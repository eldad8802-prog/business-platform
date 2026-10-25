/**
 * Appointments — one owner write = one transaction, safe to repeat (milestone A). SERVER-ONLY.
 *
 *   1. A transaction-scoped advisory lock per business serialises the business's appointment writes, so the
 *      availability check that follows sees every committed appointment (layer 1 of decision 2; the EXCLUDE
 *      constraint is layer 2 and refuses an overlap even if this layer were bypassed).
 *   2. Repeated requests (Idempotency-Key): the key is a UUIDv7 no older than 24 hours, and the request's digest is
 *      an HMAC over (route, business, user, body) — the Daily Tasks scheme (task-idempotency.ts), with its key
 *      (TASK_REQUEST_HMAC_KEY), so no new secret is needed. The ledger is the journal itself: a request's event
 *      carries its key and digest under UNIQUE (businessId, idempotencyKey). Same key + same request → the stored
 *      result (`replayed: true`); same key + different request → IDEMPOTENCY_KEY_REUSED; a digest erased with the
 *      account refuses every reuse of its key.
 *   3. An overlap refused by the database itself (23P01 — a write that slipped past layer 1) is answered as
 *      SLOT_CONFLICT, never as a 500.
 */
import type { Prisma } from "@prisma/client";

import { tenantTx } from "@/lib/tenant/tenant-tx";
import {
  checkIdempotencyKey,
  digestKeysFromEnv,
  digestWithKeyId,
  requestDigest,
  sameDigest,
  type RequestIdentity,
} from "@/lib/services/tasks/task-idempotency";

import { AppointmentServiceError } from "./appointment-errors";
import type { AppointmentPrincipal } from "./appointment-authorization";
import type { JournalDigest } from "./appointment-journal";

/** 'APPT' — the advisory-lock namespace of appointment writes (the second key is the business id). */
export const APPOINTMENT_LOCK_NAMESPACE = 0x41505054;

export type OwnerRequest = { idempotencyKey: string; now?: Date };

export type PreparedRequest = {
  key: string;
  now: Date;
  keys: ReturnType<typeof digestKeysFromEnv>;
  ident: RequestIdentity;
  digest: JournalDigest;
};

export function prepareRequest(principal: AppointmentPrincipal, req: OwnerRequest, route: string, body: unknown): PreparedRequest {
  const now = req.now ?? new Date();
  const key = req.idempotencyKey;
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new AppointmentServiceError("IDEMPOTENCY_KEY_INVALID");
  const keys = digestKeysFromEnv();
  const ident: RequestIdentity = { route, businessId: principal.businessId, userId: principal.userId, body };
  return { key, now, keys, ident, digest: { value: requestDigest(keys.current, ident), keyId: keys.current.id } };
}

export async function lockBusinessAppointments(tx: Prisma.TransactionClient, businessId: number): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${APPOINTMENT_LOCK_NAMESPACE}::int, ${businessId}::int)`;
}

/** The appointment an earlier request with this key wrote, or null. A different request under the key is refused. */
export async function findPrior(tx: Prisma.TransactionClient, businessId: number, p: PreparedRequest): Promise<number | null> {
  const origin = await tx.appointmentEvent.findFirst({
    where: { businessId, idempotencyKey: p.key },
    select: { appointmentId: true, requestDigest: true, digestKeyId: true },
  });
  if (!origin) return null;
  if (!origin.requestDigest || !origin.digestKeyId) throw new AppointmentServiceError("IDEMPOTENCY_KEY_REUSED");
  const expected = digestWithKeyId(p.keys, origin.digestKeyId, p.ident);
  if (!expected || !sameDigest(expected, origin.requestDigest)) throw new AppointmentServiceError("IDEMPOTENCY_KEY_REUSED");
  return origin.appointmentId;
}

export function isOverlapViolation(e: unknown): boolean {
  const code = (e as { code?: string; meta?: { code?: string } })?.meta?.code ?? (e as { code?: string })?.code;
  const message = e instanceof Error ? e.message : String(e);
  return code === "23P01" || /Appointment_no_overlap|exclusion constraint|23P01/.test(message);
}

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string })?.code === "P2002";
}

export type WriteContext = { tx: Prisma.TransactionClient; businessId: number; now: Date; key: string; digest: JournalDigest };
export type WriteOutcome = { appointmentId: number; replayed: boolean; warnings: string[] };

/**
 * Lock → earlier answer? → (key young enough?) → work → commit. `work` must journal exactly one event with
 * `ctx.key` and `ctx.digest` (the request's ledger entry). A concurrent first request with the same key loses on the
 * unique key and is answered from the winner, in a fresh transaction.
 */
export async function ownerWrite(
  principal: AppointmentPrincipal,
  req: OwnerRequest,
  route: string,
  body: unknown,
  work: (ctx: WriteContext) => Promise<{ appointmentId: number; warnings?: string[] }>,
): Promise<WriteOutcome> {
  const p = prepareRequest(principal, req, route, body);
  const attempt = () =>
    tenantTx(principal.businessId, async (tx): Promise<WriteOutcome> => {
      await lockBusinessAppointments(tx, principal.businessId);
      const prior = await findPrior(tx, principal.businessId, p);
      if (prior !== null) return { appointmentId: prior, replayed: true, warnings: [] };
      const verdict = checkIdempotencyKey(p.key, p.now);
      if (!verdict.ok) throw new AppointmentServiceError(verdict.code);
      const out = await work({ tx, businessId: principal.businessId, now: p.now, key: p.key, digest: p.digest });
      return { appointmentId: out.appointmentId, replayed: false, warnings: out.warnings ?? [] };
    }, { timeoutMs: 15_000 });

  try {
    return await attempt();
  } catch (e) {
    if (isOverlapViolation(e)) throw new AppointmentServiceError("SLOT_CONFLICT", { source: "database" });
    if (!isUniqueViolation(e)) throw e;
    try {
      return await attempt();
    } catch (e2) {
      if (isOverlapViolation(e2)) throw new AppointmentServiceError("SLOT_CONFLICT", { source: "database" });
      if (isUniqueViolation(e2)) throw new AppointmentServiceError("CONFLICT");
      throw e2;
    }
  }
}
