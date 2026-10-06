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
};
/** M6 name, kept for its callers. */
export const ACQUISITION_FEATURE: Record<AcquisitionSourceKey, string> = SOURCE_FEATURE;

export type GateResult = { ok: true } | { ok: false; reason: "source_disabled" | "business_inactive" };

export async function sourceGate(businessId: number, sourceKey: ConnectionSourceKey): Promise<GateResult> {
  const access = await runWithTenantContext({ businessId }, () => resolveFeatureAccess(businessId, SOURCE_FEATURE[sourceKey]));
  if (!access.allowed) return { ok: false, reason: "source_disabled" };
  try {
    await assertBusinessAcceptsWrites(businessId);
  } catch (e) {
    if (e instanceof BusinessQuarantinedError) return { ok: false, reason: "business_inactive" };
    throw e;
  }
  return { ok: true };
}

export async function acquisitionGate(businessId: number, sourceKey: AcquisitionSourceKey): Promise<GateResult> {
  return sourceGate(businessId, sourceKey);
}
