/**
 * The sweep — the retry path. Every run:
 *   1. settles rows whose lifetime ended without a send as EXPIRED (never sent late);
 *   2. claims and delivers up to `limit` due rows, oldest first, one at a time.
 * The immediate send right after signup is only the fast path; this is what makes delivery
 * eventually happen (or eventually stop) when that attempt failed or never ran.
 *
 * OFF (TRANSACTIONAL_EMAIL_ENABLED not "true"): returns at once, without touching the database.
 * Rows written meanwhile stay PENDING; once delivery is turned on, any of them older than their
 * lifetime is settled EXPIRED by step 1 — there is no late welcome.
 *
 * Concurrency-safe: two sweeps may scan the same ids; each row is claimed by exactly one of them.
 */

import { authDb, isAuthPlaneActive } from "@/lib/prisma-auth";

import { readTransactionalEmailConfig, type TransactionalEmailEnv } from "./config";
import { deliverTransactionalEmail, dueWhere, type DeliverOptions, type DeliveryOutcome } from "./delivery";

export const SWEEP_BATCH = 25;

export type SweepReport =
  | { enabled: false; configError: string | null }
  | { enabled: true; configured: false; missing: readonly string[] }
  | { enabled: true; configured: true; authPlane: false }
  | {
      enabled: true;
      configured: true;
      authPlane: true;
      expired: number;
      scanned: number;
      outcomes: Partial<Record<DeliveryOutcome, number>>;
    };

export async function runTransactionalEmailSweep(
  opts: DeliverOptions & { limit?: number; env?: TransactionalEmailEnv } = {}
): Promise<SweepReport> {
  const state = readTransactionalEmailConfig(opts.env);
  if (!state.enabled) return { enabled: false, configError: state.error };
  if (!state.ok) return { enabled: true, configured: false, missing: state.missing };
  if (!(opts.authPlaneActive ?? isAuthPlaneActive)()) return { enabled: true, configured: true, authPlane: false };

  const db = opts.db ?? authDb();
  const now = opts.now ?? new Date();

  const expired = await db.transactionalEmail.updateMany({
    where: {
      expiresAt: { lte: now },
      OR: [{ status: "PENDING" }, { status: "SENDING", nextAttemptAt: { lte: now } }],
    },
    data: { status: "EXPIRED", nextAttemptAt: null, lastErrorCode: "expired", updatedAt: now },
  });

  const due = await db.transactionalEmail.findMany({
    where: dueWhere(now),
    orderBy: { id: "asc" },
    take: opts.limit ?? SWEEP_BATCH,
    select: { id: true },
  });

  const outcomes: Partial<Record<DeliveryOutcome, number>> = {};
  for (const { id } of due) {
    const outcome = await deliverTransactionalEmail(id, { ...opts, db, now });
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  }
  return { enabled: true, configured: true, authPlane: true, expired: expired.count, scanned: due.length, outcomes };
}
