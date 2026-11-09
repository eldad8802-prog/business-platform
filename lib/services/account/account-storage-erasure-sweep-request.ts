/**
 * The answer of the account storage erasure sweep route (app/api/account/storage-erasure-sweep). SERVER-ONLY.
 *
 * The route decides the scheduler's authority itself (decideCronAuth — the one CRON_SECRET decision); this function
 * takes that decision and does the rest, so the whole answer is testable without a database or a scheduler:
 *
 *   NOT_CONFIGURED → 503, UNAUTHORIZED → 401 — nothing read, nothing run.
 *   Switched off (ACCOUNT_STORAGE_ERASURE_SWEEP_ENABLED is not exactly "true", the default) → 200, the sweep never runs.
 *   On → one sweepAccountStorageErasures() pass within the time budget; counts only — never a business id, key or
 *   message. 500 when a module failed or the pass could not run, so a scheduler's log shows it; open jobs that are
 *   simply not finished yet (the hour, a business not reached) are not failures.
 *
 * Concurrent and repeated calls are safe because every module's resume is idempotent and safe to run concurrently
 * with itself (account-storage-erasure.ts); this layer keeps no state between calls.
 */
import type { StorageErasureSweepSummary } from "@/lib/services/account/account-storage-erasure";

export type CronDecision = "AUTHORIZED" | "UNAUTHORIZED" | "NOT_CONFIGURED";

/** Under the route's maxDuration (60 s), so a pass ends before the platform cuts it. */
export const SWEEP_BUDGET_MS = 45_000;

export type SweepAnswer = { status: number; body: Record<string, unknown> };

export function sweepEnabled(value: string | undefined): boolean {
  return value?.trim() === "true";
}

export async function answerStorageErasureSweep(
  decision: CronDecision,
  enabledValue: string | undefined,
  sweep: (options: { budgetMs: number }) => Promise<StorageErasureSweepSummary>
): Promise<SweepAnswer> {
  if (decision === "NOT_CONFIGURED") return { status: 503, body: { error: "sweep_not_configured" } };
  if (decision !== "AUTHORIZED") return { status: 401, body: { error: "unauthorized" } };
  if (!sweepEnabled(enabledValue)) return { status: 200, body: { ok: true, enabled: false } };
  try {
    const s = await sweep({ budgetMs: SWEEP_BUDGET_MS });
    const counts = { businesses: s.businesses, open: s.open, errors: s.errors, notReached: s.notReached };
    return { status: s.errors === 0 ? 200 : 500, body: { ok: s.errors === 0, enabled: true, counts } };
  } catch (error) {
    console.error("[account-storage-erasure-sweep] pass failed", { error: error instanceof Error ? error.name : "unknown" });
    return { status: 500, body: { ok: false, enabled: true, error: "sweep_failed" } };
  }
}
