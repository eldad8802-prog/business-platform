import type { CreativeBlueprint } from "@/lib/features/content/creative-blueprint/types";
import type { RenderBlueprint } from "@/lib/features/content/render-blueprint/types";
import type { BusinessContentProfile } from "@/lib/services/business-content-profile.service";
import type { VariantStyle } from "@/lib/features/content/creative-blueprint/variant-cinematic-identity";
import type { OutcomeResult } from "../types";

// ─── conversion_probability ───────────────────────────────────────────────────
// Likelihood that this creative drives an immediate direct action:
// DM, click, purchase, booking. Based on urgency architecture, pacing, and offer context.
//
// High: urgency CTA + fast pacing + direct variant + instant sales cycle
// Low: trust variant, long sales cycle, educational intent

export function scoreConversion(
  blueprint: CreativeBlueprint,
  renderBlueprint: RenderBlueprint,
  profile: BusinessContentProfile,
  variantStyle: VariantStyle,
  platform: string
): OutcomeResult {
  let score = 4.0;
  const topSignals: string[] = [];

  // ── CTA psychology (strongest single signal) ──────────────────────────────

  if (blueprint.cta_psychology === "urgency") {
    score += 3.0;
    topSignals.push("urgency CTA psychology — close is designed to activate immediate action");
  } else if (blueprint.cta_psychology === "social_proof") {
    score += 1.0;
    topSignals.push("social_proof CTA — proof reduces hesitation, indirect conversion driver");
  } else if (blueprint.cta_psychology === "trust") {
    score -= 0.5;
    // Trust close delays conversion to next touchpoint
  } else if (blueprint.cta_psychology === "curiosity") {
    score -= 0.5;
    // Curiosity close invites deeper engagement, not immediate action
  }

  // ── Variant style intent ──────────────────────────────────────────────────

  if (variantStyle === "direct") {
    score += 2.0;
    topSignals.push("direct variant — entire arc is built for fast conversion, no friction");
  } else if (variantStyle === "trust") {
    score -= 1.0;
  } else if (variantStyle === "explanatory") {
    score -= 0.5;
  }

  // ── Opening attention strategy ────────────────────────────────────────────

  if (blueprint.attention_strategy === "result_first") {
    score += 1.5;
    topSignals.push("result_first attention strategy — shows the outcome upfront, reduces objection surface");
  } else if (blueprint.interruption_style === "bold_claim") {
    score += 1.0;
    topSignals.push("bold_claim interruption — strong opening statement primes conversion intent");
  }

  // ── Pacing and render preset ──────────────────────────────────────────────

  if (blueprint.pacing_curve === "fast_throughout") {
    score += 1.0;
    topSignals.push("fast_throughout pacing — no dead air, maintains conversion momentum from hook to close");
  }

  if (renderBlueprint.preset === "conversion_fast") {
    score += 1.0;
    topSignals.push("conversion_fast render preset — clip timing and CTA emphasis optimized for action");
  }

  if (renderBlueprint.cta_animation_style === "slide_in") {
    score += 0.5;
  }

  // ── Business context ──────────────────────────────────────────────────────

  if (profile.salesCycle === "instant") {
    score += 1.5;
    topSignals.push("instant sales cycle — business model supports same-session conversion (impulse buy / quick booking)");
  } else if (profile.salesCycle === "short") {
    score += 0.5;
  } else if (profile.salesCycle === "long") {
    score -= 1.5;
    // Long sales cycle means one video can't close — authority/trust more realistic
  }

  if (profile.emotionalDriver === "convenience") {
    score += 0.5;
    topSignals.push("convenience emotional driver — viewer's primary motivation aligns with immediate action");
  } else if (profile.emotionalDriver === "desire") {
    score += 0.5;
  }

  if (profile.offerType === "product") {
    score += 0.5; // products convert faster than services
  }

  // ── Platform ─────────────────────────────────────────────────────────────

  if (platform === "tiktok" && blueprint.visual_energy === "high") {
    score += 0.5;
    topSignals.push("TikTok + high energy — platform-native format maximizes reach, driving higher conversion volume");
  }

  return { score: Math.min(10, Math.max(0, score)), topSignals };
}
