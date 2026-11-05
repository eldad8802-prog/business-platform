/**
 * Leads L1.5-a — the FG lock: one advisory key per intake source feature, shared by every intake WRITE and taken
 * exclusively by every CHANGE of that feature's gate (the platform emergency switch, a per-business override).
 *
 *   key = (17991 = 0x4647 'FG', hashtext(featureKey))
 *
 * The emergency switch's database function (migration 20261113090000) takes the exclusive form first, in the same
 * transaction as its update and audit row; `updateBusinessFeatureAccess` takes it first in its control-plane
 * transaction. An intake write takes the shared form as the FIRST statement of its transaction, then re-reads the gate
 * there. So once a change of the gate has returned, no write that read the old gate can still commit — and a write
 * that started earlier finishes before the change applies.
 *
 * Lock order is fixed — FG first, then anything else (identity locks, order / call locks) — and each side waits at
 * most GATE_LOCK_TIMEOUT for it: a change fails cleanly, an intake write is deferred (nothing lost, no attempt spent).
 *
 * No Prisma client is imported here (type only), so the control-plane service can use it.
 */
import type { Prisma } from "@prisma/client";

export const FEATURE_GATE_LOCK_NAMESPACE = 17991;

/** Bounded wait for the FG lock, on both sides (the migration's function pins the same 5 s). */
export const GATE_LOCK_TIMEOUT = "5s";

/** The seven intake source features — exactly the database function's allowlist. */
export const INTAKE_SOURCE_FEATURES = [
  "acquisition_web_forms",
  "acquisition_google_lead_forms",
  "acquisition_meta_lead_ads",
  "commerce_woocommerce",
  "commerce_wix",
  "telephony_cloudtalk",
  "telephony_voicenter",
] as const;
export type IntakeSourceFeature = (typeof INTAKE_SOURCE_FEATURES)[number];

export function isIntakeSourceFeature(featureKey: unknown): featureKey is IntakeSourceFeature {
  return typeof featureKey === "string" && (INTAKE_SOURCE_FEATURES as readonly string[]).includes(featureKey);
}

type RawTx = Pick<Prisma.TransactionClient, "$executeRaw" | "$executeRawUnsafe">;

async function take(tx: RawTx, featureKey: string, mode: "shared" | "exclusive"): Promise<void> {
  // SET LOCAL takes no bind parameters; the value is a constant of this module.
  await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${GATE_LOCK_TIMEOUT}'`);
  if (mode === "shared") {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(${FEATURE_GATE_LOCK_NAMESPACE}::int, hashtext(${featureKey}))`;
  } else {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${FEATURE_GATE_LOCK_NAMESPACE}::int, hashtext(${featureKey}))`;
  }
  // Back to the session's setting: only the FG wait is bounded here, nothing else in the transaction changes.
  await tx.$executeRawUnsafe(`SET LOCAL lock_timeout TO DEFAULT`);
}

/** An intake write, as the first statement of its transaction. */
export function takeSharedGateLock(tx: RawTx, featureKey: string): Promise<void> {
  return take(tx, featureKey, "shared");
}

/** A change of the gate (per-business override), as the first statement of its transaction. */
export function takeExclusiveGateLock(tx: RawTx, featureKey: string): Promise<void> {
  return take(tx, featureKey, "exclusive");
}

/** Postgres lock_not_available (55P03) — the bounded wait expired. */
export function isGateLockTimeout(error: unknown): boolean {
  const e = error as { code?: string; meta?: { code?: string }; message?: string } | null;
  return e?.meta?.code === "55P03" || e?.code === "55P03" || /\b55P03\b|lock timeout/i.test(e?.message ?? "");
}
