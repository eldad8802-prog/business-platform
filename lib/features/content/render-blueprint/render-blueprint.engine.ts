import type { CreativeBlueprint } from "@/lib/features/content/creative-blueprint/types";
import type {
  RenderBlueprint,
  RenderPresetName,
  TypographyPreset,
  OverlayDensity,
  SceneSpacingLabel,
  CinematicMode,
  VisualFocus,
  TextBehavior,
  CtaAnimationStyle,
  PacingBehavior,
  SoundtrackMood,
  EnergyProfile,
} from "./types";
import { RENDER_PRESETS } from "./render-presets";
import {
  applyCinematicBehavior,
  applyHumanAmplificationRenderDelta,
} from "./render-behavior";

// ─── Business context (minimal — no full profile import needed) ───────────────

/**
 * Minimal business context passed to the render engine.
 * Keeps the render layer decoupled from the full service layer.
 */
export type BusinessContext = {
  marketCategory?: string;
  contentStyle?: string;
  trustLevel?: string;
};

// ─── Identity guards ──────────────────────────────────────────────────────────

/**
 * Authority businesses: legal, finance, and any explicitly authority-style
 * high-trust brand. These must never receive conversion or TikTok aesthetics
 * regardless of what the variant adapter did to pacing or energy.
 */
function isAuthorityBrand(ctx?: BusinessContext): boolean {
  if (!ctx) return false;
  return (
    ctx.marketCategory === "legal" ||
    ctx.marketCategory === "finance" ||
    (ctx.contentStyle === "authority" && ctx.trustLevel === "high")
  );
}

// ─── Preset selection ──────────────────────────────────────────────────────────

type PresetMatch = { name: RenderPresetName; reason: string };

function selectPreset(
  blueprint: CreativeBlueprint,
  platform: string,
  ctx?: BusinessContext
): PresetMatch {
  const {
    visual_strategy,
    visual_energy,
    narration_tone,
    cta_psychology,
    pacing_curve,
    storytelling_model,
    soundtrack_strategy,
    visual_identity,
    attention_strategy,
  } = blueprint;

  const isAuthority = isAuthorityBrand(ctx);

  // ── Priority ordered — first match wins ──────────────────────────────────

  // 1. Luxury: brand strategy drives everything
  if (visual_strategy === "luxury_minimal")
    return { name: "luxury_clean", reason: "visual_strategy=luxury_minimal" };

  // 2. SaaS / UI-heavy
  if (visual_strategy === "ui_visuals")
    return { name: "premium_modern", reason: "visual_strategy=ui_visuals" };

  // 3. [IDENTITY GUARD] Authority brand + authoritative narration → locked before
  //    TikTok or pacing checks. Prevents conversion_fast bleeding onto law/finance/medical.
  if (isAuthority && narration_tone === "authoritative")
    return {
      name: "authority_minimal",
      reason: "isAuthorityBrand+narration_tone=authoritative [identity guard]",
    };

  // 4. TikTok + high energy — platform-specific maximum velocity (non-authority only)
  if (platform === "tiktok" && visual_energy === "high" && !isAuthority)
    return { name: "retail_tiktok", reason: "platform=tiktok + visual_energy=high" };

  // 5. Beauty / wellness — bright_airy lighting + non-high energy
  if (visual_identity?.lightingStyle === "bright_airy" && visual_energy !== "high")
    return { name: "beauty_aesthetic", reason: "lightingStyle=bright_airy" };

  // 6. Urgency + high energy — conversion first
  if (cta_psychology === "urgency" && visual_energy === "high")
    return { name: "conversion_fast", reason: "cta_psychology=urgency + visual_energy=high" };

  // 7. Fast pacing → conversion (guarded: authority brands cannot get conversion_fast
  //    from pacing alone — their authoritative tone must dominate)
  if (pacing_curve === "fast_throughout" && !isAuthority)
    return { name: "conversion_fast", reason: "pacing_curve=fast_throughout" };

  // 8. Local authentic → documentary feel
  if (visual_strategy === "local_authentic")
    return { name: "documentary_real", reason: "visual_strategy=local_authentic" };

  // 9. Trust CTA + calm energy → slow and warm
  if (cta_psychology === "trust" && visual_energy === "calm")
    return { name: "trust_soft", reason: "cta_psychology=trust + visual_energy=calm" };

  // 10. Transformation + warm narration → emotional arc
  if (storytelling_model === "transformation" && narration_tone === "warm")
    return {
      name: "emotional_story",
      reason: "storytelling_model=transformation + narration_tone=warm",
    };

  // 11. Emotional soundtrack regardless of storytelling model
  if (soundtrack_strategy === "emotional")
    return { name: "emotional_story", reason: "soundtrack_strategy=emotional" };

  // 12. High energy — generic local SMB (not TikTok-specific)
  if (visual_energy === "high")
    return { name: "energetic_local", reason: "visual_energy=high" };

  // 13. Calm energy — slow trust default
  if (visual_energy === "calm")
    return { name: "trust_soft", reason: "visual_energy=calm" };

  // 14. [EXPLANATORY PATH] Proof-driven or curiosity-driven narrative →
  //     premium editorial presentation (gives explanatory variants a distinct render identity
  //     when no stronger signal fired above)
  if (
    storytelling_model === "proof_escalation" ||
    attention_strategy === "curiosity_gap"
  )
    return {
      name: "premium_modern",
      reason: `${storytelling_model === "proof_escalation" ? "storytelling_model=proof_escalation" : "attention_strategy=curiosity_gap"} [explanatory path]`,
    };

  // 15. Default
  return { name: "premium_modern", reason: "default fallback" };
}

// ─── Intelligence dimension derivation ────────────────────────────────────────

function deriveTypographyPreset(preset: RenderPresetName): TypographyPreset {
  if (preset === "retail_tiktok")                                    return "tiktok_punch";
  if (preset === "luxury_clean")                                     return "elegant_minimal";
  if (preset === "authority_minimal")                                return "authority_strong";
  if (preset === "conversion_fast" || preset === "energetic_local") return "bold_impact";
  return "clean_readable";
}

function deriveOverlayDensity(preset: RenderPresetName): OverlayDensity {
  if (preset === "luxury_clean")                                      return "minimal";
  if (preset === "trust_soft" || preset === "emotional_story")       return "light";
  if (preset === "retail_tiktok" || preset === "conversion_fast")    return "high";
  return "medium";
}

function deriveSceneSpacing(delta: number): SceneSpacingLabel {
  if (delta >= 0.5)  return "generous";
  if (delta >= 0.3)  return "extended";
  if (delta < 0)     return "tight";
  return "standard";
}

function deriveCinematicMode(preset: RenderPresetName): CinematicMode {
  if (preset === "luxury_clean")      return "cinematic";
  if (preset === "documentary_real")  return "raw";
  if (preset === "premium_modern")    return "editorial";
  return "clean";
}

function deriveVisualFocus(preset: RenderPresetName, subtitleFontSize: number): VisualFocus {
  if (subtitleFontSize >= 34)                                        return "text";
  if (preset === "luxury_clean" || preset === "documentary_real")   return "subject";
  return "balanced";
}

function deriveTextBehavior(preset: RenderPresetName): TextBehavior {
  if (preset === "retail_tiktok") return "word_burst";
  return "full_phrase";
}

function deriveCtaAnimationStyle(preset: RenderPresetName): CtaAnimationStyle {
  if (preset === "luxury_clean")                                    return "fade_in";
  if (preset === "conversion_fast" || preset === "retail_tiktok")  return "slide_in";
  if (preset === "trust_soft")                                      return "emphasis_hold";
  return "static";
}

function derivePacingBehavior(blueprint: CreativeBlueprint): PacingBehavior {
  switch (blueprint.pacing_curve) {
    case "fast_throughout": return "consistent";
    case "fast_then_slow":  return "decelerating";
    case "slow_then_fast":  return "accelerating";
    default:                return "consistent";
  }
}

function deriveSoundtrackMood(blueprint: CreativeBlueprint): SoundtrackMood {
  switch (blueprint.soundtrack_strategy) {
    case "none":      return "none";
    case "energetic": return "energetic";
    case "emotional": return "emotional";
    case "subtle":    return "calm";
    default:          return "calm";
  }
}

function deriveEnergyProfile(blueprint: CreativeBlueprint): EnergyProfile {
  switch (blueprint.visual_energy) {
    case "high":  return "high";
    case "calm":  return "low";
    default:      return "medium";
  }
}

// ─── Public API ────────────────────────────────────────────────────────────────

export function buildRenderBlueprint(
  blueprint: CreativeBlueprint,
  platform: string,
  ctx?: BusinessContext,
  variantStyle?: string
): RenderBlueprint {
  const { name, reason } = selectPreset(blueprint, platform, ctx);
  const baseConfig = RENDER_PRESETS[name];

  // Apply cinematic translation: psychological fields → config overrides
  const { config: cinematicConfig, modifiers } = applyCinematicBehavior(
    baseConfig,
    blueprint,
    variantStyle
  );

  const { config, haModifiers } = applyHumanAmplificationRenderDelta(
    cinematicConfig,
    blueprint,
    variantStyle
  );

  const behavior_modifiers_reasoning =
    haModifiers.length > 0 ? [...modifiers, ...haModifiers] : modifiers;

  return {
    preset: name,
    presetConfig: config,

    subtitle_rhythm:    config.subtitleRhythm,
    motion_intensity:   config.motionIntensity,
    transition_preset:  config.transitionPreset,

    typography_preset:  deriveTypographyPreset(name),
    overlay_density:    deriveOverlayDensity(name),
    scene_spacing:      deriveSceneSpacing(config.clipDurationDelta),
    intro_behavior:     name === "luxury_clean" ? "fade_in" : "hook_immediate",
    outro_behavior:     "cta_hold",
    cinematic_mode:     deriveCinematicMode(name),
    visual_focus:       deriveVisualFocus(name, config.subtitleFontSize),
    text_behavior:      deriveTextBehavior(name),
    cta_animation_style: deriveCtaAnimationStyle(name),
    pacing_behavior:    derivePacingBehavior(blueprint),
    soundtrack_mood:    deriveSoundtrackMood(blueprint),
    energy_profile:     deriveEnergyProfile(blueprint),

    preset_reasoning: reason,
    behavior_modifiers_reasoning,
  };
}
