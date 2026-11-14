/**
 * The engine's per-business activation record — "NotificationEngineActivation" (migration 20261212090000). SERVER-ONLY.
 *
 * The rule lives in worker-decision.ts (pushableCreatedAt — the precise semantics and why). This file only reads the
 * record and reports the worker's observation, each inside the business's OWN tenant transaction:
 *
 *   observeActivation(businessId, engineOn, now)  the worker: notification_engine_observe(), the one door the
 *        runtime has to the table's writes (SECURITY DEFINER, refuses another tenant, refuses a claim the override /
 *        policy contradict). Records the FIRST moment the engine is seen ON for a business enabled through the global
 *        policy alone, and ON → OFF / OFF → ON the same way; a business switched by its override or the kill switch
 *        already has its transitions recorded by the database triggers at the exact moment, so this is a no-op there.
 *   readActivation(businessId)                    the read-only dry run: a plain SELECT of the business's row.
 *
 * FAIL SAFE: the table or the function missing (this code deployed before migration 20261212090000 was applied) or any
 * error ⇒ "unavailable" — the worker then holds every owed row (no claim, no send; TTL expiry only) and the dry run
 * counts them as held. Never a wave, never a crash, nothing closed that a readable record could still allow.
 */
import { tenantTx } from "@/lib/tenant/tenant-tx";

import { activationState, type ActivationRecord, type ActivationState } from "./worker-decision";

/** A UTC wall-clock string for a timestamp(3) parameter (the codebase convention, as push-worker toUtcTimestamp). */
const utcWallClock = (d: Date) => d.toISOString().replace("T", " ").replace("Z", "");

type ObserveRow = { outcome: string; first_at: Date | null; last_at: Date | null; prior_at: Date | null; deactivated_at: Date | null };

const present = (tx: { $queryRawUnsafe: <T>(sql: string) => Promise<T> }) =>
  tx.$queryRawUnsafe<{ ok: boolean }[]>(
    `SELECT (to_regclass('public."NotificationEngineActivation"') IS NOT NULL
             AND to_regprocedure('public.notification_engine_observe(integer, boolean, timestamp(3))') IS NOT NULL) AS ok`,
  );

export async function observeActivation(businessId: number, engineOn: boolean, now: Date): Promise<ActivationState> {
  try {
    const record = await tenantTx(businessId, async (tx) => {
      const [p] = await present(tx);
      if (!p?.ok) return null;
      const [row] = await tx.$queryRaw<ObserveRow[]>`
        SELECT "outcome", "first_at", "last_at", "prior_at", "deactivated_at"
          FROM public.notification_engine_observe(${businessId}::int, ${engineOn}::boolean, ${utcWallClock(now)}::timestamp(3))`;
      if (!row || row.first_at === null || row.last_at === null || row.prior_at === null) return null;
      return { firstActivatedAt: row.first_at, lastActivatedAt: row.last_at, priorActivatedAt: row.prior_at, lastDeactivatedAt: row.deactivated_at } satisfies ActivationRecord;
    });
    return activationState(engineOn, record);
  } catch {
    return { kind: "unavailable" };
  }
}

/** Read-only: the business's record; null = none yet; "unavailable" = the table missing or an error. */
export async function readActivation(businessId: number): Promise<ActivationRecord | null | "unavailable"> {
  try {
    return await tenantTx(businessId, async (tx) => {
      const [p] = await present(tx);
      if (!p?.ok) return "unavailable" as const;
      const row = await tx.notificationEngineActivation.findUnique({
        where: { businessId },
        select: { firstActivatedAt: true, lastActivatedAt: true, priorActivatedAt: true, lastDeactivatedAt: true },
      });
      return row ?? null;
    });
  } catch {
    return "unavailable";
  }
}
