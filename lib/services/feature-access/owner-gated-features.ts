/**
 * Features whose switch-on waits for the owner's explicit go.
 *
 * The platform-admin override path (update-business-feature-access.service.ts) may CLOSE such a feature for a
 * business (DISABLED) or clear an override (INHERIT), and nothing else: any other requested state — ENABLED, or a
 * value that is not a known state at all — is refused with FEATURE_OWNER_GATED before any database work. The default
 * answer is a refusal; only the two closing states are allowed through (fail closed).
 *
 * service_desk: the module's infrastructure (the post-commit object stage and its scheduled sweep, the 1.3 UI) is not
 * ready; switching it on for a business before then is the owner's decision, not an admin action.
 *
 * Removing a key from this list is an owner decision of its own: a separate pull request with the owner's approval.
 * Other features are not affected.
 */
import { PLATFORM_FEATURE_KEYS, type PlatformFeatureKey } from "@/lib/services/feature-access/platform-feature-catalog";

export const OWNER_GATED_FEATURES: ReadonlySet<PlatformFeatureKey> = new Set<PlatformFeatureKey>([PLATFORM_FEATURE_KEYS.SERVICE_DESK]);

export const FEATURE_OWNER_GATED = "FEATURE_OWNER_GATED";

const ALLOWED_WHILE_GATED: ReadonlySet<unknown> = new Set<unknown>(["DISABLED", "INHERIT"]);

export function isOwnerGatedFeature(featureKey: string): boolean {
  return OWNER_GATED_FEATURES.has(featureKey as PlatformFeatureKey);
}

/** True when this request must be refused: a gated feature asked for anything but DISABLED / INHERIT. */
export function refusedByOwnerGate(featureKey: string, requestedState: unknown): boolean {
  return isOwnerGatedFeature(featureKey) && !ALLOWED_WHILE_GATED.has(requestedState);
}
