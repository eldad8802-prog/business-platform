import type { CreativeBlueprintInput, CreativeBlueprint } from "./types";
import {
  resolveVisualStrategy,
  resolveVisualEnergy,
  resolveVisualIdentity,
} from "./blueprint-rules/visual.rules";
import {
  resolveNarrationStrategy,
  resolveNarrationTone,
  resolveSoundtrackStrategy,
  resolveSoundtrackGenre,
} from "./blueprint-rules/audio.rules";
import {
  resolveStorytellingModel,
  resolveAttentionStrategy,
} from "./blueprint-rules/narrative.rules";
import {
  resolveEmotionalArc,
  resolveInterruptionStyle,
  resolvePacingCurve,
} from "./blueprint-rules/emotional-arc.rules";
import {
  resolvePlatformBehavior,
  resolveSubtitleBehavior,
  resolveCtaPsychology,
} from "./blueprint-rules/platform.rules";

function buildBlueprintReasoning(
  input: CreativeBlueprintInput,
  blueprint: Omit<CreativeBlueprint, "blueprint_reasoning" | "confidence">
): string {
  const { businessProfile: p, mode, selectedPlatform, goal } = input;

  const parts: string[] = [];

  parts.push(
    `סוג עסק: ${p.marketCategory} / ${p.brandPersona} / ${p.emotionalDriver}`
  );

  parts.push(
    `אסטרטגיה ויזואלית: ${blueprint.visual_strategy} (אנרגיה: ${blueprint.visual_energy})`
  );

  parts.push(
    `נרטיב: ${blueprint.storytelling_model} | כניסה: ${blueprint.attention_strategy} | הפרעה: ${blueprint.interruption_style}`
  );

  parts.push(
    `שמע: קריינות ${blueprint.narration_strategy} / טון ${blueprint.narration_tone} / מוזיקה ${blueprint.soundtrack_strategy} (${blueprint.soundtrack_genre})`
  );

  parts.push(
    `פלטפורמה: ${selectedPlatform ?? "לא הוגדר"} / CTA psychology: ${blueprint.cta_psychology} / כתוביות: ${blueprint.subtitle_behavior}`
  );

  parts.push(
    `קצב: ${blueprint.pacing_curve} | arc: ${blueprint.emotional_arc.length} שלבים`
  );

  if (mode) {
    parts.push(`מצב יצירה: ${mode}`);
  }

  if (goal) {
    parts.push(`מטרה עסקית: ${goal}`);
  }

  return parts.join(" | ");
}

function resolveConfidence(
  input: CreativeBlueprintInput
): CreativeBlueprint["confidence"] {
  const { businessProfile: p, mode, selectedPlatform, goal } = input;

  let score = 0;

  // Strong signals increase confidence
  if (p.marketCategory !== "other") score++;
  if (p.brandPersona !== "friendly") score++; // friendly is the generic default
  if (mode) score++;
  if (selectedPlatform) score++;
  if (goal) score++;
  if (p.visualStrength !== "medium") score++; // medium is the default
  if (p.trustLevel !== "medium") score++;

  if (score >= 6) return "high";
  if (score >= 4) return "medium";
  return "low";
}

/**
 * Builds a complete CreativeBlueprint from business profile + content decision.
 * Pure function: no DB, no fetch, no side effects.
 * Returns undefined only if critical inputs are missing.
 */
export function buildCreativeBlueprint(
  input: CreativeBlueprintInput
): CreativeBlueprint {
  const {
    businessProfile,
    decision,
    mode,
    selectedFormat,
    selectedPlatform,
    goal,
    contentAngle,
  } = input;

  // ── Visual ────────────────────────────────────────────────────────────────
  const visual_strategy = resolveVisualStrategy(businessProfile, mode);
  const visual_energy = resolveVisualEnergy(businessProfile, selectedPlatform);
  const visual_identity = resolveVisualIdentity(businessProfile);

  // ── Audio ─────────────────────────────────────────────────────────────────
  const narration_strategy = resolveNarrationStrategy(businessProfile, mode);
  const narration_tone = resolveNarrationTone(businessProfile);
  const soundtrack_strategy = resolveSoundtrackStrategy(businessProfile, mode);
  const soundtrack_genre = resolveSoundtrackGenre(businessProfile);

  // ── Narrative ─────────────────────────────────────────────────────────────
  const storytelling_model = resolveStorytellingModel(
    businessProfile,
    decision,
    goal,
    contentAngle
  );
  const attention_strategy = resolveAttentionStrategy(businessProfile, decision);

  // ── Emotional Arc ─────────────────────────────────────────────────────────
  const emotional_arc = resolveEmotionalArc(businessProfile, decision);
  const interruption_style = resolveInterruptionStyle(businessProfile, decision);
  const pacing_curve = resolvePacingCurve(businessProfile, decision);

  // ── Platform ──────────────────────────────────────────────────────────────
  const platform_behavior = resolvePlatformBehavior(selectedPlatform, selectedFormat);
  const subtitle_behavior = resolveSubtitleBehavior(businessProfile, selectedPlatform);
  const cta_psychology = resolveCtaPsychology(businessProfile, decision, goal);

  const partial: Omit<CreativeBlueprint, "blueprint_reasoning" | "confidence"> = {
    visual_strategy,
    visual_energy,
    visual_identity,
    narration_strategy,
    narration_tone,
    soundtrack_strategy,
    soundtrack_genre,
    storytelling_model,
    attention_strategy,
    emotional_arc,
    interruption_style,
    pacing_curve,
    platform_behavior,
    subtitle_behavior,
    cta_psychology,
  };

  const blueprint_reasoning = buildBlueprintReasoning(input, partial);
  const confidence = resolveConfidence(input);

  return {
    ...partial,
    blueprint_reasoning,
    confidence,
  };
}
