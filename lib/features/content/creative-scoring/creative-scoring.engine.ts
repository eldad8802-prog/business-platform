import type { BusinessContentProfile } from "@/lib/services/business-content-profile.service";
import type { CreativeBlueprint } from "@/lib/features/content/creative-blueprint/types";
import type { RenderBlueprint } from "@/lib/features/content/render-blueprint/types";
import type { VariantStyle } from "@/lib/features/content/creative-blueprint/variant-cinematic-identity";
import type { CreativeScore, ScoringInput } from "./types";

import { scoreHookStrength } from "./scoring-rules/hook.rules";
import {
  scoreBusinessIdentityPreservation,
  scoreTrustSafety,
} from "./scoring-rules/identity.rules";
import {
  scoreRenderCoherence,
  scoreEmotionalClarity,
} from "./scoring-rules/coherence.rules";
import { scoreCtaAlignment } from "./scoring-rules/cta.rules";
import { scorePacingFit } from "./scoring-rules/pacing.rules";
import { scorePlatformFit } from "./scoring-rules/platform.rules";
import { scoreCinematicDistinction } from "./scoring-rules/differentiation.rules";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function roundTo(n: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}

// ─── Recommendation derivation ────────────────────────────────────────────────

function deriveRecommendation(
  dims: CreativeScore["dimensions"],
  variantStyle: VariantStyle,
  profile: BusinessContentProfile
): CreativeScore["recommendation"] {
  const { hook_strength, trust_safety, emotional_clarity, pacing_fit, cta_alignment } = dims;

  // best_for_conversion: direct with strong hook AND CTA alignment
  if (variantStyle === "direct" && hook_strength >= 7 && cta_alignment >= 7) {
    return "best_for_conversion";
  }

  // best_for_trust: trust variant with safe profile and trust-aligned CTA
  if (variantStyle === "trust" && trust_safety >= 7 && cta_alignment >= 6) {
    return "best_for_trust";
  }

  // best_for_education: explanatory with sufficient clarity and measured pacing
  if (variantStyle === "explanatory" && emotional_clarity >= 6 && pacing_fit >= 6) {
    return "best_for_education";
  }

  // Non-style-specific: any variant with a dominant conversion signal
  if (hook_strength >= 7 && cta_alignment >= 6) {
    return "best_for_conversion";
  }

  // Any variant where trust safety dominates strongly
  if (trust_safety >= 8.5) {
    return "best_for_trust";
  }

  return "balanced";
}

// ─── Reasoning builder ────────────────────────────────────────────────────────
// Produces a non-generic single-paragraph reasoning from actual pipeline data.

function buildReasoning(
  variantStyle: VariantStyle,
  profile: BusinessContentProfile,
  blueprint: CreativeBlueprint,
  renderBlueprint: RenderBlueprint,
  strengths: string[],
  risks: string[]
): string {
  const parts: string[] = [];
  const presetLabel = renderBlueprint.preset.replace(/_/g, " ");
  const modCount = renderBlueprint.behavior_modifiers_reasoning.length;
  const businessLabel =
    profile.marketCategory
      ? `${profile.marketCategory} brand`
      : profile.brandPersona
      ? `${profile.brandPersona} brand`
      : "business";

  // 1. Variant + preset identity anchor
  parts.push(
    `${capitalize(variantStyle)} variant for ${businessLabel}: ${presetLabel} preset via "${renderBlueprint.preset_reasoning}"`
  );

  // 2. Behavioral modifier activity
  if (modCount >= 5) {
    const firstTwo = renderBlueprint.behavior_modifiers_reasoning.slice(0, 2).join("; ");
    parts.push(`${modCount} cinematic modifiers active — high render expressiveness (${firstTwo})`);
  } else if (modCount >= 2) {
    parts.push(
      `${modCount} behavioral modifiers applied — ${renderBlueprint.behavior_modifiers_reasoning[0]}`
    );
  } else if (modCount === 0) {
    parts.push("No behavioral modifiers fired — raw preset defaults, no creative-render adaptation");
  }

  // 3. Top strength (if any are meaningful)
  if (strengths.length > 0) {
    parts.push(`Strength: ${strengths[0]}`);
  }

  // 4. Main risk (if any)
  if (risks.length > 0) {
    parts.push(`Risk: ${risks[0]}`);
  }

  return parts.join(". ") + ".";
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function scoreVariant({
  variantBlueprint,
  renderBlueprint,
  profile,
  variantStyle,
  platform,
}: ScoringInput): CreativeScore {
  // ── Score each dimension ──────────────────────────────────────────────────

  const hookResult = scoreHookStrength(variantBlueprint, renderBlueprint);
  const identityResult = scoreBusinessIdentityPreservation(variantBlueprint, renderBlueprint, profile);
  const clarityResult = scoreEmotionalClarity(variantBlueprint);
  const pacingResult = scorePacingFit(variantBlueprint, renderBlueprint, variantStyle);
  const coherenceResult = scoreRenderCoherence(variantBlueprint, renderBlueprint, profile, variantStyle);
  const ctaResult = scoreCtaAlignment(variantBlueprint, renderBlueprint, variantStyle);
  const platformResult = scorePlatformFit(variantBlueprint, renderBlueprint, profile, variantStyle, platform);
  const trustResult = scoreTrustSafety(variantBlueprint, renderBlueprint, profile, variantStyle);
  const distinctionResult = scoreCinematicDistinction(renderBlueprint, variantStyle);

  // ── Assemble dimensions (round to 1 decimal, clamp 0-10) ─────────────────

  const dimensions: CreativeScore["dimensions"] = {
    hook_strength:                  roundTo(clamp(hookResult.score, 0, 10), 1),
    business_identity_preservation: roundTo(clamp(identityResult.score, 0, 10), 1),
    emotional_clarity:              roundTo(clamp(clarityResult.score, 0, 10), 1),
    pacing_fit:                     roundTo(clamp(pacingResult.score, 0, 10), 1),
    render_coherence:               roundTo(clamp(coherenceResult.score, 0, 10), 1),
    cta_alignment:                  roundTo(clamp(ctaResult.score, 0, 10), 1),
    platform_fit:                   roundTo(clamp(platformResult.score, 0, 10), 1),
    trust_safety:                   roundTo(clamp(trustResult.score, 0, 10), 1),
    cinematic_distinction:          roundTo(clamp(distinctionResult.score, 0, 10), 1),
  };

  // ── Total: equal-weighted average of all 9 dimensions (0–100) ────────────

  const dimValues = Object.values(dimensions);
  const total = Math.round((dimValues.reduce((a, b) => a + b, 0) / (dimValues.length * 10)) * 100);

  // ── Merge strengths and risks ─────────────────────────────────────────────

  const strengths = [
    ...hookResult.strengths,
    ...identityResult.strengths,
    ...clarityResult.strengths,
    ...pacingResult.strengths,
    ...coherenceResult.strengths,
    ...ctaResult.strengths,
    ...platformResult.strengths,
    ...trustResult.strengths,
    ...distinctionResult.strengths,
  ];

  const risks = [
    ...hookResult.risks,
    ...identityResult.risks,
    ...clarityResult.risks,
    ...pacingResult.risks,
    ...coherenceResult.risks,
    ...ctaResult.risks,
    ...platformResult.risks,
    ...trustResult.risks,
    ...distinctionResult.risks,
  ];

  const recommendation = deriveRecommendation(dimensions, variantStyle, profile);

  const reasoning = buildReasoning(
    variantStyle,
    profile,
    variantBlueprint,
    renderBlueprint,
    strengths,
    risks
  );

  return {
    total,
    dimensions,
    strengths,
    risks,
    recommendation,
    reasoning,
  };
}
