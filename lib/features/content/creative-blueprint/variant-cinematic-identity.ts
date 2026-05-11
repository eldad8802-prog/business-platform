import type { BusinessContentProfile } from "@/lib/services/business-content-profile.service";
import type {
  CreativeBlueprint,
  VisualEnergy,
  SubtitleBehavior,
  PacingCurve,
  AttentionStrategy,
  CtaPsychology,
} from "./types";
import {
  adaptBlueprintForVariant,
  type VariantStyle,
} from "./blueprint-rules/variant.rules";

export type { VariantStyle };

// ─── Business identity guards ─────────────────────────────────────────────────

/**
 * Businesses where aggressive energy or urgency actively harms credibility.
 * For these, the direct variant means sharper authority — not louder urgency.
 */
function isHighTrustProfessional(profile: BusinessContentProfile): boolean {
  return (
    profile.marketCategory === "legal" ||
    profile.marketCategory === "finance" ||
    (profile.contentStyle === "authority" && profile.trustLevel === "high")
  );
}

// ─── visual_energy per variant ────────────────────────────────────────────────

function resolveVariantVisualEnergy(
  base: VisualEnergy,
  variantStyle: VariantStyle,
  profile: BusinessContentProfile,
  platform: string
): VisualEnergy {
  switch (variantStyle) {
    case "direct": {
      // High-trust professionals: energy is capped — credibility depends on control
      if (isHighTrustProfessional(profile)) {
        return base === "high" ? "medium" : base;
      }
      // Luxury / premium: visual energy is a brand decision, variant doesn't override it
      if (profile.brandPersona === "luxury" || profile.brandPersona === "premium") {
        return base;
      }
      // TikTok direct: maximum energy — platform demands it
      if (platform === "tiktok") return "high";
      // Otherwise upgrade one step for conversion focus
      if (base === "calm") return "medium";
      if (base === "medium") return "high";
      return base;
    }

    case "explanatory": {
      // Explanatory needs focused attention, not high stimulation — cap at medium
      if (base === "high") return "medium";
      return base;
    }

    case "trust": {
      // Trust grounds the viewer — high energy breaks the emotional safety contract
      if (base === "high") {
        return isHighTrustProfessional(profile) ? "calm" : "medium";
      }
      return base;
    }

    default:
      return base;
  }
}

// ─── subtitle_behavior per variant ────────────────────────────────────────────

function resolveVariantSubtitleBehavior(
  base: SubtitleBehavior,
  variantStyle: VariantStyle,
  profile: BusinessContentProfile
): SubtitleBehavior {
  switch (variantStyle) {
    case "direct":
      // Message must land on mute — always on
      return "always_on";

    case "explanatory":
      // Highlight key teaching moments, not wall-to-wall text
      if (base === "minimal") return "key_moments";
      return base;

    case "trust":
      // Luxury: minimal interference, visuals breathe
      if (profile.brandPersona === "luxury") return "minimal";
      // Calm authority businesses (legal, finance): key moments only
      if (isHighTrustProfessional(profile)) return "key_moments";
      // High-energy defaults pulled down from always_on
      if (base === "always_on") return "key_moments";
      return base;

    default:
      return base;
  }
}

// ─── Platform-aware guards ────────────────────────────────────────────────────

function applyPlatformGuards(
  blueprint: CreativeBlueprint,
  variantStyle: VariantStyle,
  platform: string
): CreativeBlueprint {
  if (platform !== "tiktok") return blueprint;

  let result = blueprint;

  // TikTok trust: even trust needs hook momentum — slow_then_fast stalls on swipe
  if (variantStyle === "trust") {
    const pace = result.pacing_curve;
    if (pace === "slow_then_fast") {
      result = { ...result, pacing_curve: "steady" as PacingCurve };
    }
  }

  // TikTok explanatory: curiosity_gap lands better than authority_open on short-form
  if (variantStyle === "explanatory") {
    if (result.attention_strategy === "authority_open") {
      result = { ...result, attention_strategy: "curiosity_gap" as AttentionStrategy };
    }
  }

  return result;
}

// ─── Main orchestrator ────────────────────────────────────────────────────────

/**
 * Applies full variant cinematic identity to a base CreativeBlueprint.
 *
 * Layer order:
 *   1. adaptBlueprintForVariant — per-field narrative/audio/visual adapters
 *   2. visual_energy — business-aware energy level per variant
 *   3. subtitle_behavior — variant-specific subtitle strategy
 *   4. platform guards — TikTok-specific pacing and attention overrides
 *
 * Business identity is always preserved: variants shift the blueprint, they
 * don't erase the business type. A law_firm direct variant stays authoritative;
 * a beauty_clinic trust variant stays warm — the variant adjusts degree, not kind.
 */
export function applyVariantCinematicIdentity(
  base: CreativeBlueprint,
  variantStyle: VariantStyle,
  profile: BusinessContentProfile,
  platform: string,
  mode?: string
): CreativeBlueprint {
  // Step 1: per-field narrative/audio/visual field adapters (existing rules layer)
  const step1 = adaptBlueprintForVariant(base, variantStyle, profile);

  // Step 2 + 3: visual_energy and subtitle_behavior (not handled in step 1)
  const step3: CreativeBlueprint = {
    ...step1,
    visual_energy: resolveVariantVisualEnergy(
      base.visual_energy,
      variantStyle,
      profile,
      platform
    ),
    subtitle_behavior: resolveVariantSubtitleBehavior(
      base.subtitle_behavior,
      variantStyle,
      profile
    ),
  };

  // Step 4: protect high-trust professionals from urgency CTA in direct variant
  // "Act before it's too late!" actively undermines the credibility they depend on
  let step4 = step3;
  if (
    variantStyle === "direct" &&
    isHighTrustProfessional(profile) &&
    step4.cta_psychology === "urgency"
  ) {
    step4 = { ...step4, cta_psychology: "trust" as CtaPsychology };
  }

  // Step 5: platform-specific overrides
  return applyPlatformGuards(step4, variantStyle, platform);
}
