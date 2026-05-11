import type { RenderBlueprint } from "@/lib/features/content/render-blueprint/types";
import type { VariantStyle } from "@/lib/features/content/creative-blueprint/variant-cinematic-identity";
import type { DimensionResult } from "../types";

// ─── cinematic_distinction ────────────────────────────────────────────────────
// Measures how visually and cinematically distinct this variant is.
// Low distinction = variants look the same in the feed = wasted campaign diversity.
// Driven by: how many behavioral modifiers fired, preset specificity, render config differentiation.

export function scoreCinematicDistinction(
  renderBlueprint: RenderBlueprint,
  variantStyle: VariantStyle
): DimensionResult {
  let score = 4.0;
  const strengths: string[] = [];
  const risks: string[] = [];

  const modCount = renderBlueprint.behavior_modifiers_reasoning.length;
  const isDefaultFallback = renderBlueprint.preset_reasoning.includes("default fallback");
  const sceneSpacing = renderBlueprint.scene_spacing;
  const subtitleRhythm = renderBlueprint.subtitle_rhythm;
  const cinematicMode = renderBlueprint.cinematic_mode;

  // ── Behavioral modifier richness ───────────────────────────────────────────
  // Modifiers are the primary signal of how much creative differentiation is happening.

  if (modCount >= 6) {
    score += 2.0;
    strengths.push(
      `${modCount} behavioral modifiers active — high cinematic expressiveness. Clip timing, hook size, subtitle rhythm, and overlay weights are all differentiated.`
    );
  } else if (modCount >= 4) {
    score += 1.5;
    strengths.push(`${modCount} behavioral modifiers fired — meaningful cinematic differentiation across timing and overlay dimensions`);
  } else if (modCount >= 2) {
    score += 1.0;
    strengths.push(`${modCount} behavioral modifiers applied — some render differentiation active`);
  } else if (modCount === 1) {
    score += 0.5;
  } else {
    score -= 0.5;
    risks.push("No behavioral modifiers fired — this variant and the base render are cinematically identical");
  }

  // ── Preset specificity ────────────────────────────────────────────────────

  if (!isDefaultFallback) {
    score += 1.5;
    strengths.push(`Preset selected by specific signal match ("${renderBlueprint.preset_reasoning}") — distinct render identity, not a generic fallback`);
  } else {
    score -= 0.5;
    risks.push("Default fallback preset — no strong visual signal differentiated this variant at the render level");
  }

  // ── Config differentiation signals ────────────────────────────────────────

  if (sceneSpacing === "generous" || sceneSpacing === "tight") {
    score += 1.0;
    strengths.push(`Non-standard scene spacing (${sceneSpacing}) — timing is distinctly different from the neutral default`);
  } else if (sceneSpacing === "extended") {
    score += 0.5;
  }

  if (subtitleRhythm === "burst" || subtitleRhythm === "slow") {
    score += 0.5;
    strengths.push(`${subtitleRhythm} subtitle rhythm — text delivery is distinctly paced, not mid-range default`);
  }

  if (cinematicMode === "cinematic" || cinematicMode === "raw") {
    score += 0.5;
    strengths.push(`${cinematicMode} cinematic mode — distinct visual register (not clean/editorial default)`);
  }

  // ── Variant-style inherent distinction ────────────────────────────────────

  if (variantStyle === "trust" && sceneSpacing === "generous") {
    score += 0.5;
    strengths.push("Trust variant with generous spacing — spacious render creates visible contrast vs direct/explanatory variants");
  }

  if (variantStyle === "direct" && modCount >= 3) {
    score += 0.5;
    strengths.push("Direct variant with multiple modifiers — urgency/hook signals create clear visual contrast from other variants");
  }

  if (variantStyle === "explanatory" && sceneSpacing === "generous" && subtitleRhythm === "slow") {
    score += 0.5;
    strengths.push("Explanatory variant with slow subtitle rhythm + generous spacing — distinctly educational visual character");
  }

  // ── Low-distinction risk ──────────────────────────────────────────────────

  if (score < 5) {
    risks.push(
      "Low cinematic distinction — this variant may appear indistinguishable from the others in a multi-variant campaign. Differentiation value is low."
    );
  }

  return {
    score: Math.min(10, Math.max(0, score)),
    strengths,
    risks,
  };
}
