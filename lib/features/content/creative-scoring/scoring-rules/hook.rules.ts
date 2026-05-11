import type { CreativeBlueprint } from "@/lib/features/content/creative-blueprint/types";
import type { RenderBlueprint } from "@/lib/features/content/render-blueprint/types";
import type { DimensionResult } from "../types";

// ─── hook_strength ────────────────────────────────────────────────────────────
// Measures how compelling and scroll-stopping the opening is.
// Driven by interruption style, attention strategy, and rendered hook config.

export function scoreHookStrength(
  blueprint: CreativeBlueprint,
  renderBlueprint: RenderBlueprint
): DimensionResult {
  let score = 5.0;
  const strengths: string[] = [];
  const risks: string[] = [];

  // ── interruption_style ────────────────────────────────────────────────────

  if (blueprint.interruption_style === "bold_claim") {
    score += 2.0;
    strengths.push("Bold claim interruption — maximum scroll-stopping force, viewer must resolve the statement");
  } else if (blueprint.interruption_style === "visual_shock") {
    score += 1.5;
    strengths.push("Visual shock interruption — unexpected first frame breaks feed pattern");
  } else if (blueprint.interruption_style === "question") {
    score -= 0.5;
    // Soft opener — deliberate but less aggressive
  }

  // ── attention_strategy ────────────────────────────────────────────────────

  if (blueprint.attention_strategy === "result_first") {
    score += 2.0;
    strengths.push("Result-first attention strategy — viewer sees the payoff before the pitch");
  } else if (blueprint.attention_strategy === "pain_mirror") {
    score += 1.5;
    strengths.push("Pain mirror hook — immediate emotional resonance with viewer's lived experience");
  } else if (blueprint.attention_strategy === "curiosity_gap") {
    score += 1.0;
    strengths.push("Curiosity gap opens a loop the viewer feels compelled to close");
  } else if (blueprint.attention_strategy === "authority_open") {
    score -= 0.5;
    // Measured credibility lead — not designed to grab attention aggressively
  }

  // ── rendered hook config ──────────────────────────────────────────────────

  const cfg = renderBlueprint.presetConfig;

  if (cfg.hookFontSize >= 36) {
    score += 1.0;
    strengths.push(`Large hook font (${cfg.hookFontSize}px) — visual statement lands before the viewer reads`);
  } else if (cfg.hookFontSize >= 30) {
    score += 0.5;
  }

  if (cfg.hookBgOpacity >= 0.40) {
    score += 0.5;
    strengths.push("Strong hook overlay contrast — text is unmissable even in motion");
  }

  // ── compound check ────────────────────────────────────────────────────────
  // Bold claim + result_first + large font = maximum opening impact
  if (
    blueprint.interruption_style === "bold_claim" &&
    blueprint.attention_strategy === "result_first" &&
    cfg.hookFontSize >= 34
  ) {
    score += 0.5;
    strengths.push("Triple-stacked hook signal: bold claim + result-first + large font — exceptional opening force");
  }

  // ── low-hook risk ─────────────────────────────────────────────────────────

  if (score < 5) {
    risks.push("Weak hook setup — measured opening may not stop the scroll in a competitive feed");
  }

  return {
    score: Math.min(10, Math.max(0, score)),
    strengths,
    risks,
  };
}
