import type { CreativeBlueprint } from "@/lib/features/content/creative-blueprint/types";
import type { RenderBlueprint } from "@/lib/features/content/render-blueprint/types";
import type { BusinessContentProfile } from "@/lib/services/business-content-profile.service";
import type { VariantStyle } from "@/lib/features/content/creative-blueprint/variant-cinematic-identity";
import type { DimensionResult } from "../types";

// ─── render_coherence ─────────────────────────────────────────────────────────
// Measures alignment between what the blueprint signals and what the render delivers.
// High = many psychological fields translated into actual render config changes.
// Low = preset selected by fallback, few modifiers active, weak creative-render link.

export function scoreRenderCoherence(
  blueprint: CreativeBlueprint,
  renderBlueprint: RenderBlueprint,
  profile: BusinessContentProfile,
  variantStyle: VariantStyle
): DimensionResult {
  let score = 5.0;
  const strengths: string[] = [];
  const risks: string[] = [];

  const preset = renderBlueprint.preset;
  const modCount = renderBlueprint.behavior_modifiers_reasoning.length;
  const isDefaultFallback = renderBlueprint.preset_reasoning.includes("default fallback");

  // ── Preset selection quality ───────────────────────────────────────────────

  if (!isDefaultFallback) {
    score += 2.0;
    strengths.push(
      `Preset selected by strong signal match: "${renderBlueprint.preset_reasoning}" — not a fallback`
    );
  } else {
    score -= 1.0;
    risks.push(
      "Preset selected by default fallback — no dominant visual signal strong enough to override. Render identity may be generic."
    );
  }

  // ── Behavioral modifier richness ───────────────────────────────────────────

  if (modCount >= 6) {
    score += 2.0;
    strengths.push(`${modCount} behavioral modifiers active — psychological blueprint fully translated into render config`);
  } else if (modCount >= 4) {
    score += 1.5;
    strengths.push(`${modCount} behavioral modifiers fired — meaningful cinematic-creative alignment`);
  } else if (modCount >= 2) {
    score += 0.5;
  } else if (modCount === 0) {
    score -= 0.5;
    risks.push("No behavioral modifiers fired — variant inherits raw preset with zero psychological adaptation");
  }

  // ── Preset-to-intent alignment ────────────────────────────────────────────

  if (
    (profile.marketCategory === "legal" || profile.marketCategory === "finance") &&
    preset === "authority_minimal"
  ) {
    score += 2.0;
    strengths.push("Identity-locked coherence: authority brand → authority_minimal preset — creative intent and render identity match perfectly");
  }

  if (blueprint.visual_strategy === "luxury_minimal" && preset === "luxury_clean") {
    score += 2.0;
    strengths.push("Luxury strategy coherence: luxury_minimal visual strategy → luxury_clean render — locked aesthetic identity");
  }

  if (blueprint.cta_psychology === "urgency" && preset === "conversion_fast") {
    score += 1.5;
    strengths.push("Conversion coherence: urgency CTA psychology → conversion_fast preset — consistent conversion pressure");
  }

  if (blueprint.storytelling_model === "transformation" && preset === "emotional_story") {
    score += 1.5;
    strengths.push("Narrative coherence: transformation storytelling → emotional_story preset — arc and render aligned");
  }

  if (blueprint.visual_strategy === "local_authentic" && preset === "documentary_real") {
    score += 1.5;
    strengths.push("Authenticity coherence: local_authentic visual strategy → documentary_real preset — feel matches intent");
  }

  if (blueprint.visual_strategy === "ui_visuals" && preset === "premium_modern") {
    score += 1.0;
    strengths.push("SaaS coherence: ui_visuals strategy → premium_modern preset — editorial feel for product demo");
  }

  // ── Variant intent vs preset mismatch ─────────────────────────────────────

  if (variantStyle === "direct" && preset === "trust_soft") {
    score -= 1.0;
    risks.push("Render mismatch: direct variant receiving trust_soft preset — slow/warm render conflicts with direct intent");
  }

  if (variantStyle === "trust" && preset === "conversion_fast") {
    score -= 2.0;
    risks.push("Critical render mismatch: trust variant receiving conversion_fast preset — emotional arc and render are in opposition");
  }

  return {
    score: Math.min(10, Math.max(0, score)),
    strengths,
    risks,
  };
}

// ─── emotional_clarity ────────────────────────────────────────────────────────
// Measures how clearly the emotional arc reads — whether the signals reinforce
// each other or create noise. High = viewer knows exactly how to feel.

export function scoreEmotionalClarity(
  blueprint: CreativeBlueprint
): DimensionResult {
  let score = 5.0;
  const strengths: string[] = [];
  const risks: string[] = [];

  // ── Storytelling model ────────────────────────────────────────────────────

  if (blueprint.storytelling_model === "transformation") {
    score += 2.0;
    strengths.push("Transformation narrative model — viewer follows a clear before → after emotional journey");
  } else if (blueprint.storytelling_model === "proof_escalation") {
    score += 1.5;
    strengths.push("Proof escalation model — emotional clarity through rational conviction: small proof → big proof → irresistible");
  } else if (blueprint.storytelling_model === "local_trust") {
    score += 1.0;
    strengths.push("Local trust narrative — relatable, human arc that builds genuine emotional connection");
  } else if (blueprint.storytelling_model === "curiosity_gap") {
    score += 1.0;
    strengths.push("Curiosity-gap model — controlled emotional tension that keeps viewer engaged until the reveal");
  }

  // ── Narration tone clarity ────────────────────────────────────────────────

  if (blueprint.narration_tone === "intimate") {
    score += 1.5;
    strengths.push("Intimate narration tone — personal and direct, viewer feels spoken to individually");
  } else if (blueprint.narration_tone === "warm") {
    score += 1.0;
    strengths.push("Warm narration tone — caring character gives emotional clarity and approachability");
  }

  // ── Soundtrack reinforcement ──────────────────────────────────────────────

  if (blueprint.soundtrack_strategy === "emotional") {
    score += 1.0;
    strengths.push("Emotional soundtrack strategy — audio layer actively reinforces the emotional arc");
  }

  // ── Energy-tone alignment ─────────────────────────────────────────────────

  if (blueprint.visual_energy === "high" && blueprint.narration_tone === "urgent") {
    score += 1.0;
    strengths.push("Visual energy and narration tone aligned: high energy + urgency — consistent conversion signal");
  }

  if (
    blueprint.visual_energy === "calm" &&
    (blueprint.narration_tone === "warm" || blueprint.narration_tone === "intimate")
  ) {
    score += 1.0;
    strengths.push("Visual energy and narration aligned: calm energy + warm/intimate tone — emotional space is coherent");
  }

  // ── Signal conflicts (clarity-reducing) ──────────────────────────────────

  if (blueprint.visual_energy === "high" && blueprint.narration_tone === "warm") {
    score -= 1.5;
    risks.push(
      "Energy-tone conflict: high visual energy vs warm narration — fast cuts undercut the emotional warmth the voiceover is trying to build"
    );
  }

  if (blueprint.visual_energy === "high" && blueprint.narration_tone === "intimate") {
    score -= 1.0;
    risks.push(
      "Energy-intimacy conflict: high energy vs intimate tone — intimacy needs breathing room, fast pacing fights it"
    );
  }

  if (
    blueprint.storytelling_model === "objection_collapse" &&
    blueprint.narration_tone === "intimate"
  ) {
    score -= 0.5;
    risks.push("Tone mismatch: objection_collapse storytelling needs confident delivery, not intimate voice");
  }

  return {
    score: Math.min(10, Math.max(0, score)),
    strengths,
    risks,
  };
}
