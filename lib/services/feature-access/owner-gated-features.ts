/**
 * Features whose switch-on waits for the owner's explicit go.
 *
 * The platform-admin override path (update-business-feature-access.service.ts) may CLOSE such a feature for a
 * business (DISABLED) or clear an override (INHERIT), and nothing else: any other requested state — ENABLED, or a
 * value that is not a known state at all — is refused with FEATURE_OWNER_GATED before any database work. The default
 * answer is a refusal; only the two closing states are allowed through (fail closed).
 *
 * The one exception is OWNER_PILOT_BUSINESSES: the owner named the businesses a gated feature may be OPENED for, one
 * by one. Only ENABLED, only for that exact business id (a positive safe integer, compared by value — no string, no
 * pattern, no range), only for that feature. Every other business, a business created later included, stays refused.
 * Closing (DISABLED) and clearing (INHERIT) stay allowed for every business, the pilot included, so the platform admin
 * can switch the feature off at once. This list opens nothing by itself: it only lets the platform admin make the
 * ENABLED override for that business — an audited action the owner approves separately. The global policy is not
 * touched: the feature stays OFF globally.
 *
 * service_desk: the owner chose business 9 (the platform's test business) for the first pilot (2026-11-20). Before any
 * further business: the shared storage-erasure sweep (/api/account/storage-erasure-sweep) is still unscheduled and off.
 *
 * activity_packs (phase 2): gated from the day it exists. Pilot: business 9 only (the platform's test business, as for
 * service_desk) — THIS pull request, which waits for the owner's approval. It opens nothing by itself: the ENABLED
 * override for business 9 is a separate audited admin action, and closing it (DISABLED / INHERIT) keeps the saved
 * selection in BusinessActivityProfile.
 *
 * Removing a key from OWNER_GATED_FEATURES, or adding a business to OWNER_PILOT_BUSINESSES, is an owner decision of
 * its own: a separate pull request with the owner's approval. Other features are not affected.
 */
import { PLATFORM_FEATURE_KEYS, type PlatformFeatureKey } from "@/lib/services/feature-access/platform-feature-catalog";

export const OWNER_GATED_FEATURES: ReadonlySet<PlatformFeatureKey> = new Set<PlatformFeatureKey>([
  PLATFORM_FEATURE_KEYS.SERVICE_DESK,
  PLATFORM_FEATURE_KEYS.ACTIVITY_PACKS,
]);

/** The owner's pilot businesses per gated feature: the only (feature, business) pairs ENABLED may be requested for. */
export const OWNER_PILOT_BUSINESSES: ReadonlyMap<PlatformFeatureKey, ReadonlySet<number>> = new Map<PlatformFeatureKey, ReadonlySet<number>>([
  [PLATFORM_FEATURE_KEYS.SERVICE_DESK, new Set<number>([9])],
  [PLATFORM_FEATURE_KEYS.ACTIVITY_PACKS, new Set<number>([9])],
]);

export const FEATURE_OWNER_GATED = "FEATURE_OWNER_GATED";

const ALLOWED_WHILE_GATED: ReadonlySet<unknown> = new Set<unknown>(["DISABLED", "INHERIT"]);

export function isOwnerGatedFeature(featureKey: string): boolean {
  return OWNER_GATED_FEATURES.has(featureKey as PlatformFeatureKey);
}

/** True only for an owner-named pilot: this exact feature, this exact business id. */
export function isOwnerPilotBusiness(featureKey: string, businessId: unknown): boolean {
  if (typeof businessId !== "number" || !Number.isSafeInteger(businessId) || businessId <= 0) return false;
  return OWNER_PILOT_BUSINESSES.get(featureKey as PlatformFeatureKey)?.has(businessId) === true;
}

/**
 * True when this request must be refused: a gated feature asked for anything but DISABLED / INHERIT — except ENABLED
 * for one of the owner's pilot businesses of that feature. Without a business id (or with anything but a positive safe
 * integer) ENABLED is refused.
 */
export function refusedByOwnerGate(featureKey: string, requestedState: unknown, businessId?: unknown): boolean {
  if (!isOwnerGatedFeature(featureKey)) return false;
  if (ALLOWED_WHILE_GATED.has(requestedState)) return false;
  if (requestedState === "ENABLED" && isOwnerPilotBusiness(featureKey, businessId)) return false;
  return true;
}
