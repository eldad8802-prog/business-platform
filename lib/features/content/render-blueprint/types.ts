// ─── Preset names ──────────────────────────────────────────────────────────────
export type RenderPresetName =
  | "trust_soft"
  | "conversion_fast"
  | "luxury_clean"
  | "beauty_aesthetic"
  | "documentary_real"
  | "retail_tiktok"
  | "authority_minimal"
  | "energetic_local"
  | "emotional_story"
  | "premium_modern";

// ─── Intelligence dimensions ───────────────────────────────────────────────────

/** Phase 2 — subtitle word-burst splitting not yet implemented */
export type SubtitleRhythm = "slow" | "medium" | "punchy" | "burst";

export type MotionIntensity = "minimal" | "low" | "medium" | "high";

/** Phase 2 — transition effects require Creatomate template support */
export type TransitionPreset = "cut" | "fade" | "slow_fade" | "dissolve";

export type OverlayDensity = "minimal" | "light" | "medium" | "high";
export type VisualFocus = "subject" | "text" | "balanced";
export type SceneSpacingLabel = "tight" | "standard" | "extended" | "generous";
export type CinematicMode = "raw" | "clean" | "cinematic" | "editorial";
export type TypographyPreset =
  | "bold_impact"
  | "clean_readable"
  | "elegant_minimal"
  | "tiktok_punch"
  | "authority_strong";
export type SubtitlePosition = "bottom_low" | "bottom_standard" | "bottom_high";
/** Phase 2 — word_burst not yet implemented in adapter */
export type TextBehavior = "full_phrase" | "word_burst" | "emphasis_only";
export type CtaAnimationStyle = "static" | "fade_in" | "slide_in" | "emphasis_hold";
export type IntroBehavior = "hook_immediate" | "fade_in";
export type OutroBehavior = "cta_hold" | "fade_out";
export type EnergyProfile = "low" | "medium" | "high" | "variable";
export type PacingBehavior =
  | "consistent"
  | "accelerating"
  | "decelerating"
  | "dynamic";
export type SoundtrackMood = "none" | "calm" | "emotional" | "energetic" | "corporate";

// ─── Preset config (Creatomate-actionable values) ──────────────────────────────

export type RenderPresetConfig = {
  // Hook text overlay
  hookFontSize: number;     // px, clamped 20–56 in adapter
  hookBgOpacity: number;    // 0.0–0.9
  hookBorderRadius: number; // px
  hookPaddingX: number;     // px
  hookPaddingY: number;     // px

  // Subtitle text overlays
  subtitleFontSize: number;                   // px, clamped 20–56
  subtitleFontWeight: "400" | "600" | "700" | "900";
  subtitleBgOpacity: number;                  // 0.0 = no bg (luxury), up to 0.9
  subtitleY: string;                          // e.g. "82%", "85%", "88%"

  // CTA text overlay
  ctaFontSize: number;   // px
  ctaBgOpacity: number;  // 0.0–0.9

  // Timing deltas applied to every clip (adapter recalculates all dependent timings)
  clipDurationDelta: number;  // ±seconds per clip (positive = slower, negative = faster)
  firstClipBonus: number;     // extra seconds on hook clip (index 0)
  lastClipBonus: number;      // extra seconds on CTA clip (last index)

  // Phase 2 stubs — carried as Creative Variables for future learning
  transitionPreset: TransitionPreset;
  motionIntensity: MotionIntensity;
  subtitleRhythm: SubtitleRhythm;
};

// ─── RenderBlueprint ───────────────────────────────────────────────────────────

export type RenderBlueprint = {
  preset: RenderPresetName;
  presetConfig: RenderPresetConfig;

  // Intelligence dimensions — Creative Variable store (Learning Engine input in future)
  subtitle_rhythm: SubtitleRhythm;
  motion_intensity: MotionIntensity;
  transition_preset: TransitionPreset;
  typography_preset: TypographyPreset;
  overlay_density: OverlayDensity;
  scene_spacing: SceneSpacingLabel;
  intro_behavior: IntroBehavior;
  outro_behavior: OutroBehavior;
  cinematic_mode: CinematicMode;
  visual_focus: VisualFocus;
  text_behavior: TextBehavior;
  cta_animation_style: CtaAnimationStyle;
  pacing_behavior: PacingBehavior;
  soundtrack_mood: SoundtrackMood;
  energy_profile: EnergyProfile;

  // Auditable reasoning
  preset_reasoning: string;
  // Which psychological fields modified the preset config and how
  behavior_modifiers_reasoning: string[];
};
