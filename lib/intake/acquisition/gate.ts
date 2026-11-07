/**
 * M6 / M7-A — may this business receive events from this source right now?
 *
 * Checked AFTER the trusted resolver named the business and BEFORE anything is recorded:
 *   1. the source's platform feature is enabled for the business (every source is OFF by default);
 *   2. the business accepts writes (not quarantined / being erased).
 * A refusal records nothing. The webhook answers so the provider does not retry forever
 * (the owner turning a source off is a decision, not an outage).
 */
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import { resolveFeatureAccess } from "@/lib/services/feature-access/resolve-feature-access";
import { runWithTenantContext } from "@/lib/tenant/context";
import { assertBusinessAcceptsWrites, BusinessQuarantinedError } from "@/lib/tenant/business-lifecycle";
import { IntakeTerminalError } from "@/lib/intake/core/contract";

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
  /** decision 3 — the connection is PAUSED: verified deliveries are kept and wait for the owner to resume it. */
  connectionPaused: "held:connection_paused",
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

/**
 * L1.5-b · PR-6 — expiry of held receipts (PREPARED, OFF). The working assumptions under review — NOT final owner
 * decisions: a receipt held 14 days (from its arrival; a change of hold reason does not reset the clock) is settled
 * terminally instead of waiting again; a Dubiz emergency hold never expires (it needs its own policy).
 *
 *   OFF unless INTAKE_HELD_EXPIRY_ENABLED is exactly "true" (unset everywhere): nothing changes.
 *   ON  the look that finds the hold still standing past the age throws IntakeTerminalError("expired:<reason>") →
 *       the processor dead-letters it (FAILED, no further attempt, PAYLOAD KEPT — never purged by the dead-letter
 *       retention, see purgeExpiredFailedPayloads), so it is never processed automatically and a controlled manual
 *       restore stays possible while the payload exists. A hold lifted before that look → processed as usual.
 */
export const HELD_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;
/** When an owner warning would come (day 12) — read only by a future notification, once a policy is approved. */
export const HELD_EXPIRY_WARN_MS = 12 * 24 * 60 * 60 * 1000;
/** Holds that expire. Not the Dubiz emergency switch (held:emergency_disabled): its own policy. */
export const EXPIRING_HOLDS: ReadonlySet<string> = new Set([HOLD_CODES.connectionPaused, HOLD_CODES.sourceDisabled, HOLD_CODES.businessInactive]);
export const EXPIRED_PREFIX = "expired:";

export function heldExpiryEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.INTAKE_HELD_EXPIRY_ENABLED === "true";
}

/** The hold stands — unless expiry is on, the hold expires, and the receipt arrived HELD_EXPIRY_MS ago (then: terminal). */
export function holdOrExpire<H extends { kind: "deferred"; until: Date; code: string }>(
  hold: H,
  receivedAt: Date,
  now: Date,
  env: Record<string, string | undefined> = process.env
): H {
  if (heldExpiryEnabled(env) && EXPIRING_HOLDS.has(hold.code) && now.getTime() - receivedAt.getTime() >= HELD_EXPIRY_MS) {
    throw new IntakeTerminalError(EXPIRED_PREFIX + hold.code.slice("held:".length));
  }
  return hold;
}

export async function acquisitionGate(businessId: number, sourceKey: AcquisitionSourceKey): Promise<GateResult> {
  return sourceGate(businessId, sourceKey);
}
