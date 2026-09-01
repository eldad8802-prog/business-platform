/**
 * D2 / ACCOUNT-DELETION-2A — the canonical business lifecycle gate.
 *
 * ONE place decides whether a business still accepts normal tenant writes. Before
 * this module the answer lived in a single `if (user.business?.deletedAt)` inside
 * `getCurrentUser`, which meant every path that does not go through a session —
 * provider webhooks, background jobs, imports — treated a business being erased
 * exactly like a healthy one.
 *
 * STATES (derived from the existing Business timestamps — no schema change):
 *
 *   ACTIVE              deletionRequestedAt = null, deletedAt = null
 *   DELETION_REQUESTED  deletionRequestedAt set,    deletedAt = null   → QUARANTINED
 *   PURGED              deletedAt set                                  → QUARANTINED
 *
 * A separate PURGING state is deliberately NOT represented. It would be
 * operationally identical to DELETION_REQUESTED — both deny every normal write and
 * both are resumable — so a column for it would be schema change for zero security
 * value. What the erasure flow actually needs is preserved: a purge that fails
 * leaves the business in DELETION_REQUESTED (quarantined, retryable) and is
 * therefore still distinguishable from a purge that succeeded (PURGED).
 *
 * QUARANTINE INVARIANT: from the instant DELETION_REQUESTED commits, no NORMAL
 * tenant write may commit — not through a session, not through a provider webhook,
 * not through a background job. The erasure worker itself is the sole exception and
 * says so explicitly (see `lib/services/account/erasure-job.ts`); it never travels
 * through this guard's deny path by accident.
 *
 * TOCTOU: `assertBusinessAcceptsWritesTx` exists because a check performed before a
 * transaction proves nothing — deletion can commit in between. Security-critical
 * writes call the tx variant INSIDE their own transaction, where it takes a row
 * lock that serialises against the quarantine transition (which locks the same row).
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Advisory-lock namespace for the account-deletion lifecycle. Any two callers that
 * must not interleave around a quarantine take `pg_advisory_xact_lock(this, businessId)`.
 */
export const ADVISORY_NAMESPACE = 0x41_44; // 'AD'

export type BusinessLifecycle = "ACTIVE" | "DELETION_REQUESTED" | "PURGED";

/** The lifecycle-bearing columns. Kept structural so any client shape can supply them. */
export type BusinessLifecycleRow = {
  readonly deletionRequestedAt: Date | null;
  readonly deletedAt: Date | null;
};

/**
 * Thrown when a normal tenant write is attempted against a business that is being
 * or has been erased. Carries no tenant content — only the state and the id.
 */
export class BusinessQuarantinedError extends Error {
  readonly businessId: number;
  readonly lifecycle: BusinessLifecycle | "UNKNOWN";

  constructor(businessId: number, lifecycle: BusinessLifecycle | "UNKNOWN") {
    super(
      `business ${businessId} does not accept writes (lifecycle=${lifecycle}) — account deletion quarantine`
    );
    this.name = "BusinessQuarantinedError";
    this.businessId = businessId;
    this.lifecycle = lifecycle;
  }
}

/** Pure derivation. `deletedAt` wins: a purged business is never "merely requested". */
export function lifecycleOf(row: BusinessLifecycleRow): BusinessLifecycle {
  if (row.deletedAt !== null) {
    return "PURGED";
  }
  if (row.deletionRequestedAt !== null) {
    return "DELETION_REQUESTED";
  }
  return "ACTIVE";
}

/** ACTIVE is the only state that accepts normal tenant writes. */
export function acceptsNormalWrites(row: BusinessLifecycleRow): boolean {
  return lifecycleOf(row) === "ACTIVE";
}

/** The minimal client shape this module needs (satisfied by PrismaClient and by a tx). */
type LifecycleReader = {
  business: {
    findUnique(args: {
      where: { id: number };
      select: { deletionRequestedAt: true; deletedAt: true };
    }): Promise<BusinessLifecycleRow | null>;
  };
};

/**
 * Read the lifecycle. Returns null when the business does not exist — callers must
 * treat that as "deny", never as "allow".
 */
export async function readBusinessLifecycle(
  businessId: number,
  db: LifecycleReader = prisma as unknown as LifecycleReader
): Promise<BusinessLifecycle | null> {
  if (!Number.isInteger(businessId) || businessId <= 0) {
    return null;
  }
  const row = await db.business.findUnique({
    where: { id: businessId },
    select: { deletionRequestedAt: true, deletedAt: true },
  });
  return row ? lifecycleOf(row) : null;
}

/**
 * Fail-closed gate for a NORMAL tenant write, checked before the work starts.
 *
 * Use this at an entry boundary (a provider webhook, a background job). It is a
 * cheap single-row read. It is NOT sufficient on its own for a write that must not
 * survive a concurrent quarantine — those must also call the tx variant below.
 */
export async function assertBusinessAcceptsWrites(
  businessId: number,
  db: LifecycleReader = prisma as unknown as LifecycleReader
): Promise<void> {
  const lifecycle = await readBusinessLifecycle(businessId, db);
  if (lifecycle === null) {
    throw new BusinessQuarantinedError(businessId, "UNKNOWN");
  }
  if (lifecycle !== "ACTIVE") {
    throw new BusinessQuarantinedError(businessId, lifecycle);
  }
}

/**
 * Race-safe gate, checked INSIDE the caller's transaction.
 *
 * Serialisation is by a TRANSACTION-SCOPED ADVISORY LOCK keyed on the business,
 * not by `SELECT ... FOR UPDATE`. That matters for a reason worth recording: row
 * locking requires UPDATE/DELETE/TRUNCATE privilege in addition to SELECT, and the
 * tenant runtime deliberately holds SELECT-only on Business — the table has no RLS,
 * so giving the runtime write privilege there would hand it a cross-tenant write
 * capability. An advisory lock needs no table privilege, releases at transaction
 * end, and provides exactly the mutual exclusion required.
 *
 * The quarantine transition takes the SAME lock, so the two serialise: either this
 * transaction takes the lock, reads ACTIVE and commits (the transition waits behind
 * it), or the transition holds the lock, commits, and this read then observes the
 * quarantined state and throws. There is no interleaving in which a normal write
 * commits after the quarantine has committed.
 *
 * `Business` carries no RLS, so this read is not tenant-scoped by policy — which is
 * exactly right: the caller has already established WHICH business it is acting for
 * through the trusted tenant chain, and this asks only whether that business is
 * still open for business.
 */
export async function assertBusinessAcceptsWritesTx(
  tx: Prisma.TransactionClient,
  businessId: number
): Promise<void> {
  if (!Number.isInteger(businessId) || businessId <= 0) {
    throw new BusinessQuarantinedError(businessId, "UNKNOWN");
  }
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(${ADVISORY_NAMESPACE}::int, ${businessId}::int)`;
  const rows = await tx.$queryRaw<BusinessLifecycleRow[]>`
    SELECT "deletionRequestedAt", "deletedAt"
    FROM "Business"
    WHERE "id" = ${businessId}
  `;
  if (rows.length === 0) {
    throw new BusinessQuarantinedError(businessId, "UNKNOWN");
  }
  const lifecycle = lifecycleOf(rows[0]);
  if (lifecycle !== "ACTIVE") {
    throw new BusinessQuarantinedError(businessId, lifecycle);
  }
}
