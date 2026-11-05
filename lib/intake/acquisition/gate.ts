/**
 * M6 / M7-A — may this business receive events from this source right now?
 *
 * Checked AFTER the trusted resolver named the business and BEFORE anything is recorded:
 *   1. the source's platform feature is enabled for the business (every source is OFF by default);
 *   2. the business accepts writes (not quarantined / being erased).
 * A refusal records nothing. The webhook answers so the provider does not retry forever
 * (the owner turning a source off is a decision, not an outage).
 */
import type { Prisma } from "@prisma/client";
import type { RouteResult } from "@/lib/intake/core/contract";
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import {
  resolveBusinessCapabilitiesWith,
  resolveFeatureAccess,
  type FeatureAccessReader,
} from "@/lib/services/feature-access/resolve-feature-access";
import { runWithTenantContext } from "@/lib/tenant/context";
import { assertBusinessAcceptsWrites, BusinessQuarantinedError, readBusinessLifecycle } from "@/lib/tenant/business-lifecycle";
import { isGateLockTimeout, takeSharedGateLock } from "./gate-lock";

/** M6 — the lead sources (what the owner connects under "lead sources"). */
export const ACQUISITION_SOURCE_KEYS = ["meta.lead_ads", "google.lead_form", "web.form"] as const;
export type AcquisitionSourceKey = (typeof ACQUISITION_SOURCE_KEYS)[number];

/** M7-A — every source a governed AcquisitionConnection may bind (the DB CHECK mirrors it). */
export const CONNECTION_SOURCE_KEYS = [
  ...ACQUISITION_SOURCE_KEYS,
  "commerce.woocommerce",
  "commerce.wix",
  "telephony.cloudtalk",
  "telephony.voicenter",
  // S1-A — Rivhit sales documents → revenue truth (polled; read-only).
  "pos.rivhit",
] as const;
export type ConnectionSourceKey = (typeof CONNECTION_SOURCE_KEYS)[number];
export function isConnectionSourceKey(v: unknown): v is ConnectionSourceKey {
  return typeof v === "string" && (CONNECTION_SOURCE_KEYS as readonly string[]).includes(v);
}

export const SOURCE_FEATURE: Record<ConnectionSourceKey, string> = {
  "meta.lead_ads": PLATFORM_FEATURE_KEYS.ACQUISITION_META_LEAD_ADS,
  "google.lead_form": PLATFORM_FEATURE_KEYS.ACQUISITION_GOOGLE_LEAD_FORMS,
  "web.form": PLATFORM_FEATURE_KEYS.ACQUISITION_WEB_FORMS,
  "commerce.woocommerce": PLATFORM_FEATURE_KEYS.COMMERCE_WOOCOMMERCE,
  "commerce.wix": PLATFORM_FEATURE_KEYS.COMMERCE_WIX,
  "telephony.cloudtalk": PLATFORM_FEATURE_KEYS.TELEPHONY_CLOUDTALK,
  "telephony.voicenter": PLATFORM_FEATURE_KEYS.TELEPHONY_VOICENTER,
  "pos.rivhit": PLATFORM_FEATURE_KEYS.POS_RIVHIT,
};
/** M6 name, kept for its callers. */
export const ACQUISITION_FEATURE: Record<AcquisitionSourceKey, string> = SOURCE_FEATURE;

/**
 * L1.5-a — `holdable` is true ONLY for the platform's emergency switch (EMERGENCY_DISABLED): an operational,
 * temporary stop, so a verified delivery is recorded and HELD (never processed until released) instead of
 * dropped. Every other refusal records nothing, as before (owner decision 2026-11-04):
 *   BUSINESS_DISABLED / GLOBAL_DEFAULT   the business is not (or no longer) entitled to the source
 *   business_inactive                    quarantined (deletion requested / purged) — wins over everything
 * `ok` stays false for a holdable refusal, so callers that only ask "may I act now?" are unchanged.
 */
export type GateResult =
  | { ok: true }
  | { ok: false; reason: "source_disabled"; holdable: boolean }
  | { ok: false; reason: "business_inactive"; holdable: false };

export async function sourceGate(businessId: number, sourceKey: ConnectionSourceKey): Promise<GateResult> {
  const access = await runWithTenantContext({ businessId }, () => resolveFeatureAccess(businessId, SOURCE_FEATURE[sourceKey]));
  try {
    await assertBusinessAcceptsWrites(businessId);
  } catch (e) {
    if (e instanceof BusinessQuarantinedError) return { ok: false, reason: "business_inactive", holdable: false };
    throw e;
  }
  if (!access.allowed) return { ok: false, reason: "source_disabled", holdable: access.reasonCode === "EMERGENCY_DISABLED" };
  return { ok: true };
}

/** L1.5-a — how long a held receipt waits before the next look (the sweep cadence); the wait is not an attempt. */
export const HOLD_RECHECK_MS = 10 * 60 * 1000;

/** Bounded, non-personal hold codes (IntakeEvent.lastErrorCode while held). */
export const HOLD_CODES = {
  emergency: "held:emergency_disabled",
  sourceDisabled: "held:source_disabled",
  businessInactive: "held:business_inactive",
} as const;

/**
 * L1.5-a — the gate again, right before a receipt is processed (after its lease is taken, after the revoked
 * check): what may not be acted on NOW stays waiting — deferred, the attempt not counted, the payload kept,
 * nothing deleted — and is released by a later look once the source and the business allow it again.
 * Null = proceed.
 */
export async function holdUnlessAllowed(
  businessId: number,
  sourceKey: ConnectionSourceKey,
  now: Date
): Promise<{ kind: "deferred"; until: Date; code: string } | null> {
  const gate = await sourceGate(businessId, sourceKey);
  if (gate.ok) return null;
  const code =
    gate.reason === "business_inactive" ? HOLD_CODES.businessInactive : gate.holdable ? HOLD_CODES.emergency : HOLD_CODES.sourceDisabled;
  return { kind: "deferred", until: new Date(now.getTime() + HOLD_RECHECK_MS), code };
}

export async function acquisitionGate(businessId: number, sourceKey: AcquisitionSourceKey): Promise<GateResult> {
  return sourceGate(businessId, sourceKey);
}

/** L1.5-a — the in-transaction gate said "not now": the write is abandoned (rolled back) and the receipt waits. */
export class SourceGateHeldError extends Error {
  constructor(readonly code: string) {
    super(`intake gate held: ${code}`);
    this.name = "SourceGateHeldError";
  }
}

/**
 * L1.5-a · race protection — the FIRST statement of every intake write transaction (lead / commerce order / call):
 * take the FG lock in its shared form, then read the gate again INSIDE that transaction. A gate change (emergency
 * switch, per-business override) holds the same key exclusively, so the two serialise: a write either commits
 * before the change applies, or reads the new gate here and is held. Throws SourceGateHeldError when the write must
 * not happen now; the business lifecycle is read without its own lock (no per-business serialisation of writes).
 */
export async function enterSourceGateInTx(tx: Prisma.TransactionClient, businessId: number, sourceKey: ConnectionSourceKey): Promise<void> {
  const featureKey = SOURCE_FEATURE[sourceKey];
  await takeSharedGateLock(tx, featureKey);
  const lifecycle = await readBusinessLifecycle(businessId, tx as unknown as Parameters<typeof readBusinessLifecycle>[1]);
  if (lifecycle !== "ACTIVE") throw new SourceGateHeldError(HOLD_CODES.businessInactive);
  const access = (await resolveBusinessCapabilitiesWith(tx as unknown as FeatureAccessReader, businessId))[featureKey as keyof Awaited<ReturnType<typeof resolveBusinessCapabilitiesWith>>];
  if (!access?.allowed) {
    throw new SourceGateHeldError(access?.reasonCode === "EMERGENCY_DISABLED" ? HOLD_CODES.emergency : HOLD_CODES.sourceDisabled);
  }
}

/** The FG lock could not be had within its bound: the receipt waits and is looked at again (no attempt spent). */
export const GATE_BUSY_CODE = "held:gate_busy";

/**
 * Wraps a core destination: a held gate (or a busy FG lock) becomes a deferral — the transaction rolled back, nothing
 * written, the attempt not counted — instead of a failure. Any other error is the destination's own, unchanged.
 */
export function gatedDestination<A extends unknown[]>(
  fn: (...args: A) => Promise<RouteResult>,
  nowOf: (...args: A) => Date
): (...args: A) => Promise<RouteResult> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (error) {
      const until = new Date(nowOf(...args).getTime() + HOLD_RECHECK_MS);
      if (error instanceof SourceGateHeldError) return { kind: "deferred", until, code: error.code };
      if (isGateLockTimeout(error)) return { kind: "deferred", until, code: GATE_BUSY_CODE };
      throw error;
    }
  };
}
