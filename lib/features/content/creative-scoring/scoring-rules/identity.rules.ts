import type { CreativeBlueprint } from "@/lib/features/content/creative-blueprint/types";
import type { RenderBlueprint } from "@/lib/features/content/render-blueprint/types";
import type { BusinessContentProfile } from "@/lib/services/business-content-profile.service";
import type { VariantStyle } from "@/lib/features/content/creative-blueprint/variant-cinematic-identity";
import type { DimensionResult } from "../types";

// ─── Identity guard (mirrors render engine — scoring layer is independent) ────

function isHighTrustProfessional(profile: BusinessContentProfile): boolean {
  return (
    profile.marketCategory === "legal" ||
    profile.marketCategory === "finance" ||
    (profile.contentStyle === "authority" && profile.trustLevel === "high")
  );
}

// ─── business_identity_preservation ──────────────────────────────────────────
// How well the variant's render identity aligns with what this business is.
// Negative: brand is treated as a category it doesn't belong to.
// Positive: render preset and energy are locked to the correct brand archetype.

export function scoreBusinessIdentityPreservation(
  blueprint: CreativeBlueprint,
  renderBlueprint: RenderBlueprint,
  profile: BusinessContentProfile
): DimensionResult {
  let score = 8.0;
  const strengths: string[] = [];
  const risks: string[] = [];

  const preset = renderBlueprint.preset;
  const isHighTrust = isHighTrustProfessional(profile);
  const isLuxury = profile.brandPersona === "luxury";

  // ── Critical breaches (identity completely wrong) ─────────────────────────

  if (isHighTrust && preset === "conversion_fast") {
    score -= 4.0;
    risks.push(
      `Critical identity breach: authority/professional brand (${profile.marketCategory}) rendered with conversion_fast preset — credibility collapse`
    );
  }

  if (isHighTrust && preset === "retail_tiktok") {
    score -= 4.0;
    risks.push(
      `Critical identity breach: authority brand rendered with retail_tiktok preset — completely misaligned aesthetic`
    );
  }

  if (isHighTrust && blueprint.cta_psychology === "urgency") {
    score -= 3.0;
    risks.push(
      "High-trust professional with urgency CTA — pressure tactics break the trust contract this brand depends on"
    );
  }

  // ── Major breaches ────────────────────────────────────────────────────────

  if (isLuxury && preset === "retail_tiktok") {
    score -= 3.0;
    risks.push("Luxury brand rendered with retail_tiktok aesthetic — brand equity destroyed in one video");
  }

  if (isHighTrust && blueprint.visual_energy === "high") {
    score -= 2.0;
    risks.push(
      "High visual energy for authority/professional brand — energy exceeds the calm dominance these businesses require"
    );
  }

  if (isLuxury && blueprint.visual_energy === "high") {
    score -= 2.0;
    risks.push("Luxury brand with high visual energy — speed conflicts with the deliberate pace luxury identity requires");
  }

  // ── Minor breaches ────────────────────────────────────────────────────────

  if (profile.marketCategory === "beauty" && preset === "authority_minimal") {
    score -= 1.0;
    risks.push("Beauty brand with authority_minimal preset — wrong aesthetic register, beauty expects warmth not austerity");
  }

  // ── Positive alignment signals ────────────────────────────────────────────

  if (isHighTrust && preset === "authority_minimal") {
    score += 2.0;
    strengths.push(
      `Authority identity correctly locked: ${profile.marketCategory || "professional"} brand → authority_minimal preset`
    );
  }

  if (isLuxury && preset === "luxury_clean") {
    score += 2.0;
    strengths.push("Luxury identity preserved: luxury brand → luxury_clean preset with minimal overlay");
  }

  if (isHighTrust && blueprint.narration_tone === "authoritative") {
    score += 1.0;
    strengths.push("Authoritative narration tone preserved — voice character matches brand credibility requirements");
  }

  if (isLuxury && blueprint.visual_energy === "calm") {
    score += 1.0;
    strengths.push("Calm visual energy correctly maintained for luxury brand identity");
  }

  if (profile.contentStyle === "explanation" && blueprint.storytelling_model === "proof_escalation") {
    score += 0.5;
    strengths.push("Educational content style aligned with proof-escalation narrative model");
  }

  return {
    score: Math.min(10, Math.max(0, score)),
    strengths,
    risks,
  };
}

// ─── trust_safety ─────────────────────────────────────────────────────────────
// Identity safety score: how free of credibility-threatening breaches is this variant.
// High = safe to run. Low = risk of real brand damage.
// Distinct from business_identity_preservation — this is specifically about trust damage.

export function scoreTrustSafety(
  blueprint: CreativeBlueprint,
  renderBlueprint: RenderBlueprint,
  profile: BusinessContentProfile,
  variantStyle: VariantStyle
): DimensionResult {
  let score = 8.0;
  const strengths: string[] = [];
  const risks: string[] = [];

  const preset = renderBlueprint.preset;
  const isHighTrust = isHighTrustProfessional(profile);
  const isLuxury = profile.brandPersona === "luxury";

  // ── Critical trust breaches ───────────────────────────────────────────────

  if (isHighTrust && preset === "conversion_fast") {
    score -= 4.0;
    risks.push(
      `Trust critical: conversion_fast preset on ${profile.marketCategory || "authority"} brand — clients won't book a lawyer or financial advisor who feels like a flash sale`
    );
  }

  if (isHighTrust && preset === "retail_tiktok") {
    score -= 4.0;
    risks.push("Trust critical: retail_tiktok preset destroys professional credibility — wrong category entirely");
  }

  if (isHighTrust && blueprint.cta_psychology === "urgency") {
    score -= 3.0;
    risks.push(
      "Trust critical: urgency CTA psychology on authority brand — pressure tactics are the #1 reason high-trust clients disengage"
    );
  }

  // ── Significant trust risks ───────────────────────────────────────────────

  if (isLuxury && preset === "retail_tiktok") {
    score -= 3.0;
    risks.push("Luxury brand with retail_tiktok aesthetic — signals low quality, kills aspirational positioning");
  }

  if (variantStyle === "trust" && blueprint.cta_psychology === "urgency") {
    score -= 2.0;
    risks.push(
      "Trust variant with urgency CTA: the variant's entire arc is undermined — viewer builds trust through the video, then gets hit with pressure at the end"
    );
  }

  if (isHighTrust && blueprint.visual_energy === "high") {
    score -= 2.0;
    risks.push("High visual energy on authority brand — frenetic pacing signals anxiety, not expertise");
  }

  // ── Minor trust risks ─────────────────────────────────────────────────────

  if (isLuxury && blueprint.visual_energy === "high") {
    score -= 1.0;
    risks.push("Luxury brand with high energy — cheapens the brand's controlled aesthetic");
  }

  // ── Positive trust signals ────────────────────────────────────────────────

  if (isHighTrust && preset === "authority_minimal") {
    score += 1.0;
    strengths.push("Authority brand correctly receiving authority_minimal preset — trust architecture intact");
  }

  if (variantStyle === "trust" && blueprint.cta_psychology === "trust") {
    score += 1.0;
    strengths.push("Trust variant with trust CTA psychology — full arc coherence: trust building → trust-aligned close");
  }

  if (isHighTrust && blueprint.narration_tone === "authoritative") {
    score += 0.5;
    strengths.push("Authoritative narration tone for authority brand — vocal character reinforces credibility");
  }

  return {
    score: Math.min(10, Math.max(0, score)),
    strengths,
    risks,
  };
}
