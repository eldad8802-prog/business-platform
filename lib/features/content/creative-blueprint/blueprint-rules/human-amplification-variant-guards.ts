import type { BusinessContentProfile } from "@/lib/services/business-content-profile.service";
import type { CreativeBlueprint, HumanAmplification } from "../types";
import type { VariantStyle } from "./variant.rules";

/** Phase 1B — deterministic caps only; no new keys; undefined humanAmplification = no-op. */

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function hasDefinedHumanAmplificationField(ha: HumanAmplification): boolean {
  return (
    ha.conversationalCutAggression !== undefined ||
    ha.awkwardHoldWeight !== undefined ||
    ha.conversationalDensity !== undefined ||
    ha.productionPolish !== undefined ||
    ha.viewerMotivationPrimary !== undefined
  );
}

function variantNumericMax(variantStyle: VariantStyle): {
  cut: number;
  awkward: number;
  density: number;
} {
  switch (variantStyle) {
    case "direct":
      return { cut: 1.0, awkward: 1.0, density: 1.0 };
    case "explanatory":
      return { cut: 0.8, awkward: 0.85, density: 0.8 };
    case "trust":
      return { cut: 0.5, awkward: 0.4, density: 0.6 };
    default:
      return { cut: 1, awkward: 1, density: 1 };
  }
}

function applyProfileNumericCeilings(
  ceilings: { cut: number; awkward: number; density: number },
  profile: BusinessContentProfile
): { cut: number; awkward: number; density: number } {
  let { cut, awkward, density } = ceilings;

  if (profile.marketCategory === "legal") {
    cut = Math.min(cut, 0.55);
    awkward = Math.min(awkward, 0.45);
    density = Math.min(density, 0.65);
  }
  if (profile.marketCategory === "finance") {
    cut = Math.min(cut, 0.55);
    awkward = Math.min(awkward, 0.45);
    density = Math.min(density, 0.65);
  }
  if (profile.marketCategory === "health") {
    cut = Math.min(cut, 0.5);
    awkward = Math.min(awkward, 0.3);
    density = Math.min(density, 0.6);
  }
  if (profile.brandPersona === "luxury" || profile.brandPersona === "premium") {
    cut = Math.min(cut, 0.55);
    awkward = Math.min(awkward, 0.5);
    density = Math.min(density, 0.5);
  }
  if (profile.trustLevel === "high") {
    cut = Math.min(cut, 0.65);
    awkward = Math.min(awkward, 0.55);
    density = Math.min(density, 0.7);
  }
  if (profile.contentStyle === "authority") {
    cut = Math.min(cut, 0.6);
    awkward = Math.min(awkward, 0.5);
    density = Math.min(density, 0.65);
  }

  return { cut, awkward, density };
}

function isTikTokDirectCutBoostBlocked(profile: BusinessContentProfile): boolean {
  if (
    profile.marketCategory === "legal" ||
    profile.marketCategory === "finance" ||
    profile.marketCategory === "health"
  ) {
    return true;
  }
  if (profile.trustLevel === "high" && profile.contentStyle === "authority") {
    return true;
  }
  return false;
}

function isRawPolishForbidden(
  variantStyle: VariantStyle,
  profile: BusinessContentProfile
): boolean {
  if (
    profile.marketCategory === "legal" ||
    profile.marketCategory === "finance" ||
    profile.marketCategory === "health"
  ) {
    return true;
  }
  if (profile.brandPersona === "luxury" || profile.brandPersona === "premium") {
    return true;
  }
  if (variantStyle === "trust") {
    return true;
  }
  if (profile.trustLevel === "high" && profile.contentStyle === "authority") {
    return true;
  }
  return false;
}

function remapViewerMotivationIfEntertainment(
  value: HumanAmplification["viewerMotivationPrimary"],
  variantStyle: VariantStyle,
  profile: BusinessContentProfile
): HumanAmplification["viewerMotivationPrimary"] {
  if (value !== "entertainment") {
    return value;
  }
  if (profile.marketCategory === "legal" || profile.marketCategory === "finance") {
    return "business_default";
  }
  if (profile.marketCategory === "health") {
    return "utility";
  }
  if (
    variantStyle === "trust" ||
    profile.brandPersona === "luxury" ||
    profile.brandPersona === "premium"
  ) {
    return "hybrid";
  }
  return value;
}

/**
 * Clamps optional `humanAmplification` only. No-op when missing, empty, or no defined fields.
 * Pure: does not mutate `blueprint`.
 */
export function applyHumanAmplificationVariantGuards(
  blueprint: CreativeBlueprint,
  variantStyle: VariantStyle,
  profile: BusinessContentProfile,
  platform: string
): CreativeBlueprint {
  const ha = blueprint.humanAmplification;
  if (ha === undefined || !hasDefinedHumanAmplificationField(ha)) {
    return blueprint;
  }

  let ceilings = variantNumericMax(variantStyle);
  ceilings = applyProfileNumericCeilings(ceilings, profile);

  if (
    platform === "tiktok" &&
    variantStyle === "direct" &&
    !isTikTokDirectCutBoostBlocked(profile)
  ) {
    ceilings = { ...ceilings, cut: Math.min(1, ceilings.cut + 0.1) };
  }

  const next: HumanAmplification = { ...ha };

  if (ha.conversationalCutAggression !== undefined) {
    const v = clamp01(ha.conversationalCutAggression);
    next.conversationalCutAggression = Math.min(v, ceilings.cut);
  }
  if (ha.awkwardHoldWeight !== undefined) {
    const v = clamp01(ha.awkwardHoldWeight);
    next.awkwardHoldWeight = Math.min(v, ceilings.awkward);
  }
  if (ha.conversationalDensity !== undefined) {
    const v = clamp01(ha.conversationalDensity);
    next.conversationalDensity = Math.min(v, ceilings.density);
  }

  if (ha.productionPolish !== undefined) {
    if (ha.productionPolish === "raw" && isRawPolishForbidden(variantStyle, profile)) {
      next.productionPolish = "balanced";
    }
  }

  if (ha.viewerMotivationPrimary !== undefined) {
    next.viewerMotivationPrimary = remapViewerMotivationIfEntertainment(
      ha.viewerMotivationPrimary,
      variantStyle,
      profile
    );
  }

  return { ...blueprint, humanAmplification: next };
}
