/**
 * Father Engine — C0 / PR3. RealityTier boundary validation.
 *
 * normalize() depends on this INTERFACE, not on any fixed allow-list. The real
 * registry (the Evidence & Reality Constitution's tier vocabulary, off-main) is
 * injected later without touching normalize. No token is valid merely for being a
 * string. There is NO ranking / precedence / ceiling here — validity only.
 */

import type { RealityTier } from "../observation.types";

export interface RealityTierValidator {
  isValid(tier: RealityTier): boolean;
}

/**
 * TEST-ONLY fixture allow-list — NOT a canonical vocabulary and NOT a source of
 * truth. Exists solely so PR3 fixtures have valid tiers to normalize against.
 */
const FIXTURE_TIERS: ReadonlySet<string> = new Set([
  "tier-observed",
  "tier-inferred",
  "tier-declared",
  "tier-self-asserted",
  "tier-third-party",
]);

export const fixtureRealityTierValidator: RealityTierValidator = {
  isValid: (tier) => typeof tier === "string" && FIXTURE_TIERS.has(tier),
};
