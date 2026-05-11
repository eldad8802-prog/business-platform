/**
 * render-behavior.ts — Cinematic Translation Layer
 *
 * Maps psychological blueprint fields to Creatomate-actionable config overrides.
 * The preset is the visual identity anchor; this layer modulates it.
 *
 * Design principles:
 * - Overrides are bounded deltas, not replacements — preset character is preserved.
 * - Each rule is independent and auditable (returns its reasoning string).
 * - Multiple rules can stack; final values are clamped to safe ranges.
 */

import type { RenderPresetConfig, SubtitleRhythm } from "./types";
import type { CreativeBlueprint } from "@/lib/features/content/creative-blueprint/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const RHYTHM_ORDER: SubtitleRhythm[] = ["slow", "medium", "punchy", "burst"];

function upgradeRhythm(r: SubtitleRhythm): SubtitleRhythm {
  const i = RHYTHM_ORDER.indexOf(r);
  return i < RHYTHM_ORDER.length - 1 ? RHYTHM_ORDER[i + 1] : r;
}

function downgradeRhythm(r: SubtitleRhythm): SubtitleRhythm {
  const i = RHYTHM_ORDER.indexOf(r);
  return i > 0 ? RHYTHM_ORDER[i - 1] : r;
}

// ─── Cinematic translation rules ──────────────────────────────────────────────

/**
 * Applies cinematic behavior modifiers derived from psychological blueprint fields.
 *
 * Call order: runs AFTER preset selection, BEFORE intelligence dimension derivation.
 * The returned config is used as the final presetConfig for the RenderBlueprint.
 */
export function applyCinematicBehavior(
  base: RenderPresetConfig,
  blueprint: CreativeBlueprint,
  variantStyle?: string
): { config: RenderPresetConfig; modifiers: string[] } {
  // Work on a shallow copy — we accumulate delta overrides
  let c: RenderPresetConfig = { ...base };
  const m: string[] = [];

  // ── cta_psychology ────────────────────────────────────────────────────────
  // Controls CTA weight, clip tempo, and urgency feel.

  if (blueprint.cta_psychology === "urgency") {
    c.ctaBgOpacity     = clamp(c.ctaBgOpacity + 0.08, 0, 0.9);
    c.clipDurationDelta = round2(c.clipDurationDelta - 0.08);
    c.lastClipBonus    = round2(c.lastClipBonus + 0.15);
    c.subtitleRhythm   = upgradeRhythm(c.subtitleRhythm);
    m.push("cta_psychology=urgency → stronger CTA, tighter clips, faster subtitle rhythm");
  }

  if (blueprint.cta_psychology === "trust") {
    c.clipDurationDelta = round2(c.clipDurationDelta + 0.10);
    c.ctaBgOpacity     = clamp(c.ctaBgOpacity - 0.05, 0, 0.9);
    c.lastClipBonus    = round2(c.lastClipBonus + 0.20);
    m.push("cta_psychology=trust → spacious clips, softer CTA, extended hold on close");
  }

  if (blueprint.cta_psychology === "curiosity") {
    c.firstClipBonus = round2(c.firstClipBonus + 0.15);
    c.hookBgOpacity  = clamp(c.hookBgOpacity - 0.05, 0, 0.9);
    m.push("cta_psychology=curiosity → slower hook reveal, lighter hook overlay");
  }

  if (blueprint.cta_psychology === "social_proof") {
    c.lastClipBonus = round2(c.lastClipBonus + 0.20);
    c.ctaBgOpacity  = clamp(c.ctaBgOpacity + 0.05, 0, 0.9);
    m.push("cta_psychology=social_proof → extended proof hold, reinforced CTA");
  }

  // ── attention_strategy ────────────────────────────────────────────────────
  // Controls hook character and opening momentum.

  if (blueprint.attention_strategy === "result_first") {
    c.hookFontSize   = clamp(c.hookFontSize + 2, 20, 56);
    c.firstClipBonus = round2(c.firstClipBonus - 0.10);
    m.push("attention_strategy=result_first → bolder hook, faster opening delivery");
  }

  if (blueprint.attention_strategy === "curiosity_gap") {
    c.firstClipBonus = round2(c.firstClipBonus + 0.20);
    c.hookBgOpacity  = clamp(c.hookBgOpacity - 0.05, 0, 0.9);
    m.push("attention_strategy=curiosity_gap → slower reveal, lighter hook for intrigue");
  }

  if (blueprint.attention_strategy === "pain_mirror") {
    c.hookBgOpacity = clamp(c.hookBgOpacity + 0.05, 0, 0.9);
    c.hookFontSize  = clamp(c.hookFontSize + 1, 20, 56);
    m.push("attention_strategy=pain_mirror → reinforced hook presence for emotional resonance");
  }

  if (blueprint.attention_strategy === "authority_open") {
    c.hookBgOpacity = clamp(c.hookBgOpacity + 0.03, 0, 0.9);
    m.push("attention_strategy=authority_open → steady credibility hook");
  }

  // ── interruption_style ────────────────────────────────────────────────────
  // Controls the delivery character of the opening statement.

  if (blueprint.interruption_style === "bold_claim") {
    c.hookFontSize   = clamp(c.hookFontSize + 4, 20, 56);
    c.hookBgOpacity  = clamp(c.hookBgOpacity + 0.08, 0, 0.9);
    c.firstClipBonus = round2(c.firstClipBonus - 0.10);
    m.push("interruption_style=bold_claim → large hook font, strong overlay, fast delivery");
  }

  if (blueprint.interruption_style === "question") {
    c.hookFontSize   = clamp(c.hookFontSize - 2, 20, 56);
    c.hookBgOpacity  = clamp(c.hookBgOpacity - 0.05, 0, 0.9);
    c.firstClipBonus = round2(c.firstClipBonus + 0.10);
    m.push("interruption_style=question → lighter hook, more time to read the question");
  }

  // ── storytelling_model ────────────────────────────────────────────────────
  // Controls the structural pacing and subtitle emphasis.

  if (blueprint.storytelling_model === "proof_escalation") {
    c.clipDurationDelta = round2(c.clipDurationDelta + 0.10);
    c.subtitleBgOpacity = clamp(c.subtitleBgOpacity + 0.05, 0, 0.9);
    m.push("storytelling_model=proof_escalation → longer shots for proof absorption, clearer subtitles");
  }

  if (blueprint.storytelling_model === "objection_collapse") {
    c.hookFontSize  = clamp(c.hookFontSize + 2, 20, 56);
    c.hookBgOpacity = clamp(c.hookBgOpacity + 0.05, 0, 0.9);
    m.push("storytelling_model=objection_collapse → assertive hook to surface the objection");
  }

  if (
    blueprint.storytelling_model === "local_trust" ||
    blueprint.storytelling_model === "documentary_realism"
  ) {
    c.subtitleBgOpacity = clamp(c.subtitleBgOpacity - 0.05, 0, 0.9);
    c.clipDurationDelta = round2(c.clipDurationDelta + 0.10);
    m.push("storytelling_model=local_trust/documentary → rawer feel, lighter overlay, slower cuts");
  }

  if (blueprint.storytelling_model === "expert_dominance") {
    c.hookBgOpacity = clamp(c.hookBgOpacity + 0.04, 0, 0.9);
    m.push("storytelling_model=expert_dominance → reinforced authority presence on hook");
  }

  // ── variant style structural overrides ───────────────────────────────────
  // Applied last — establishes the overall structural character of the variant.

  if (variantStyle === "explanatory") {
    c.clipDurationDelta = round2(c.clipDurationDelta + 0.15);
    c.subtitleRhythm    = downgradeRhythm(c.subtitleRhythm);
    m.push("variantStyle=explanatory → longer shots for educational absorption, calmer subtitle pacing");
  }

  if (variantStyle === "trust") {
    c.clipDurationDelta = round2(c.clipDurationDelta + 0.08);
    m.push("variantStyle=trust → extra breathing room per shot");
  }

  // ── Final bounds clamp ────────────────────────────────────────────────────
  // Prevent modifier stacking from exceeding safe ranges.
  c.clipDurationDelta = clamp(c.clipDurationDelta, -0.4, 0.9);
  c.firstClipBonus    = clamp(c.firstClipBonus, -0.3, 1.0);
  c.lastClipBonus     = clamp(c.lastClipBonus, 0, 1.0);
  c.hookFontSize      = clamp(c.hookFontSize, 20, 56);
  c.hookBgOpacity     = clamp(c.hookBgOpacity, 0, 0.9);
  c.subtitleBgOpacity = clamp(c.subtitleBgOpacity, 0, 0.9);
  c.ctaBgOpacity      = clamp(c.ctaBgOpacity, 0, 0.9);

  return { config: c, modifiers: m };
}
