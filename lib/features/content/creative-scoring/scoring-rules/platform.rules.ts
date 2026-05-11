import type { CreativeBlueprint } from "@/lib/features/content/creative-blueprint/types";
import type { RenderBlueprint } from "@/lib/features/content/render-blueprint/types";
import type { BusinessContentProfile } from "@/lib/services/business-content-profile.service";
import type { VariantStyle } from "@/lib/features/content/creative-blueprint/variant-cinematic-identity";
import type { DimensionResult } from "../types";

// ─── platform_fit ─────────────────────────────────────────────────────────────
// Measures how well the creative approach matches the platform's native norms.
// TikTok is the most demanding — wrong energy kills reach before the hook lands.

export function scorePlatformFit(
  blueprint: CreativeBlueprint,
  renderBlueprint: RenderBlueprint,
  profile: BusinessContentProfile,
  variantStyle: VariantStyle,
  platform: string
): DimensionResult {
  let score = 6.0;
  const strengths: string[] = [];
  const risks: string[] = [];

  const preset = renderBlueprint.preset;
  const subtitleRhythm = renderBlueprint.subtitle_rhythm;
  const energy = blueprint.visual_energy;

  // ── TikTok ────────────────────────────────────────────────────────────────

  if (platform === "tiktok") {
    if (energy === "high") {
      score += 2.5;
      strengths.push("High visual energy on TikTok — matches the platform's scroll-stopping velocity requirement");
    } else if (energy === "medium") {
      score += 0.5;
    } else if (energy === "calm") {
      score -= 3.0;
      risks.push(
        "Calm visual energy on TikTok — this will not compete. TikTok's algorithm rewards high engagement in the first 2 seconds; calm pacing won't survive the feed."
      );
    }

    if (preset === "retail_tiktok") {
      score += 2.0;
      strengths.push("retail_tiktok preset — platform-native render identity: punchy text, maximum motion, native aesthetic");
    } else if (preset === "luxury_clean" || preset === "authority_minimal") {
      score -= 2.0;
      risks.push(
        `${preset} preset on TikTok — this aesthetic belongs to premium/professional channels, not TikTok's discovery feed`
      );
    } else if (preset === "trust_soft") {
      score -= 1.5;
      risks.push("trust_soft preset on TikTok — slow and warm doesn't match TikTok's expected energy register");
    }

    if (subtitleRhythm === "burst" || subtitleRhythm === "punchy") {
      score += 1.0;
      strengths.push(`${subtitleRhythm} subtitle rhythm — fast text delivery is native to TikTok viewing patterns`);
    } else if (subtitleRhythm === "slow") {
      score -= 1.0;
      risks.push("Slow subtitle rhythm on TikTok — text lingers too long for the platform's scroll pace");
    }

    if (blueprint.pacing_curve === "fast_throughout") {
      score += 1.0;
      strengths.push("Fast_throughout pacing on TikTok — no dead air, matches platform's attention curve");
    }

    if (variantStyle === "explanatory") {
      score -= 1.0;
      risks.push(
        "Explanatory variant on TikTok — educational content is harder to land here; TikTok rewards dopamine over depth"
      );
    }
  }

  // ── Instagram ─────────────────────────────────────────────────────────────

  if (platform === "instagram") {
    if (energy === "high" || energy === "medium") {
      score += 1.0;
      strengths.push("Instagram Reels rewards energy — medium/high visual energy is native to the format");
    }

    if (profile.marketCategory === "beauty" && preset === "beauty_aesthetic") {
      score += 1.0;
      strengths.push("Beauty brand on Instagram with beauty_aesthetic preset — channel, brand, and render are fully aligned");
    }

    if (preset === "retail_tiktok") {
      score -= 0.5;
      // Slightly TikTok-native but still works on Instagram Reels
    }
  }

  // ── Facebook ──────────────────────────────────────────────────────────────

  if (platform === "facebook") {
    if (variantStyle === "trust" || variantStyle === "explanatory") {
      score += 0.5;
      strengths.push("Trust/explanatory content works well on Facebook — older demographic skews toward longer consideration");
    }
    if (energy === "calm" || energy === "medium") {
      score += 0.5;
    }
    if (preset === "retail_tiktok") {
      score -= 1.0;
      risks.push("retail_tiktok preset on Facebook — platform aesthetic mismatch, too aggressive for Facebook's content norms");
    }
  }

  return {
    score: Math.min(10, Math.max(0, score)),
    strengths,
    risks,
  };
}
