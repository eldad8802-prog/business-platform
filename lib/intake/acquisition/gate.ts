/**
 * M6 — may this business receive leads from this acquisition source right now?
 *
 * Checked AFTER the trusted resolver named the business and BEFORE anything is recorded:
 *   1. the source's platform feature is enabled for the business (all three are OFF by default);
 *   2. the business accepts writes (not quarantined / being erased).
 * A refusal records nothing. The webhook answers so the provider does not retry forever
 * (the owner turning a source off is a decision, not an outage).
 */
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import { resolveFeatureAccess } from "@/lib/services/feature-access/resolve-feature-access";
import { runWithTenantContext } from "@/lib/tenant/context";
import { assertBusinessAcceptsWrites, BusinessQuarantinedError } from "@/lib/tenant/business-lifecycle";

export const ACQUISITION_SOURCE_KEYS = ["meta.lead_ads", "google.lead_form", "web.form"] as const;
export type AcquisitionSourceKey = (typeof ACQUISITION_SOURCE_KEYS)[number];

export const ACQUISITION_FEATURE: Record<AcquisitionSourceKey, string> = {
  "meta.lead_ads": PLATFORM_FEATURE_KEYS.ACQUISITION_META_LEAD_ADS,
  "google.lead_form": PLATFORM_FEATURE_KEYS.ACQUISITION_GOOGLE_LEAD_FORMS,
  "web.form": PLATFORM_FEATURE_KEYS.ACQUISITION_WEB_FORMS,
};

export type GateResult = { ok: true } | { ok: false; reason: "source_disabled" | "business_inactive" };

export async function acquisitionGate(businessId: number, sourceKey: AcquisitionSourceKey): Promise<GateResult> {
  const access = await runWithTenantContext({ businessId }, () => resolveFeatureAccess(businessId, ACQUISITION_FEATURE[sourceKey]));
  if (!access.allowed) return { ok: false, reason: "source_disabled" };
  try {
    await assertBusinessAcceptsWrites(businessId);
  } catch (e) {
    if (e instanceof BusinessQuarantinedError) return { ok: false, reason: "business_inactive" };
    throw e;
  }
  return { ok: true };
}
