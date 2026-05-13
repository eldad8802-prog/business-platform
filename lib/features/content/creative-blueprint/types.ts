import type { BusinessContentProfile } from "@/lib/services/business-content-profile.service";
import type {
  ContentDecision,
  Mode,
  SelectedFormat,
  SelectedPlatform,
  Goal,
  ContentAngle,
  DirectionInput,
} from "@/lib/features/content/decision";

// ─── Input ────────────────────────────────────────────────────────────────────

export type CreativeBlueprintInput = {
  businessProfile: BusinessContentProfile;
  decision: ContentDecision;
  mode?: Mode;
  selectedFormat?: SelectedFormat;
  selectedPlatform?: SelectedPlatform;
  goal?: Goal;
  contentAngle?: ContentAngle;
  selectedDirection?: DirectionInput;
  audienceTypes?: string[];
  contentGoalPrompt?: string;
};

// ─── Visual ───────────────────────────────────────────────────────────────────

export type VisualStrategy =
  | "stock_footage"       // high visual strength, aspirational or demonstrative
  | "motion_graphics"     // low visual / tech / SaaS / abstract
  | "ui_visuals"          // screen recording, app demo, dashboard walkthrough
  | "typography_heavy"    // text-driven, finance / law / education
  | "local_authentic"     // user films themselves or their space (camera mode)
  | "luxury_minimal"      // clean, high-end, very sparse
  | "hybrid";             // mix of above

export type VisualEnergy = "high" | "medium" | "calm";

export type VisualIdentity = {
  colorMood: "warm" | "cool" | "neutral" | "bold" | "monochrome";
  lightingStyle: "bright_airy" | "moody_dramatic" | "clean_studio" | "natural" | "minimal";
  compositionStyle: "dynamic_cuts" | "steady_beauty" | "documentary" | "graphic" | "intimate";
};

// ─── Audio ────────────────────────────────────────────────────────────────────

export type NarrationStrategy =
  | "on_camera"   // person speaks directly to camera
  | "voiceover"   // recorded narration over visuals
  | "text_only"   // no spoken word, text overlays carry content
  | "hybrid";     // mix of voiceover + on-camera moments

export type NarrationTone =
  | "confident"      // strong, declarative, no hedging
  | "warm"           // caring, close, empathetic
  | "urgent"         // time-sensitive, action-driven
  | "authoritative"  // expert-level, calm dominance
  | "intimate";      // personal, close, confessional

export type SoundtrackStrategy = "none" | "subtle" | "energetic" | "emotional";

export type SoundtrackGenre =
  | "corporate"   // safe, professional, neutral
  | "local"       // warm, human, community-feeling
  | "emotional"   // strings, piano, cinematic pull
  | "energetic"   // beats, upbeat, fast
  | "calm";       // minimal, ambient, breathing room

// ─── Narrative ────────────────────────────────────────────────────────────────

export type StorytellingModel =
  | "transformation"       // before → after, visible change
  | "authority"            // establish expertise first, then offer
  | "proof_escalation"     // small proof → bigger proof → irresistible conclusion
  | "objection_collapse"   // surface objection → destroy it → offer
  | "problem_agitation"    // name pain → amplify it → offer relief
  | "local_trust"          // community feel, human, nearby, real
  | "expert_dominance"     // confident expert speaks, audience listens
  | "curiosity_gap"        // hint at something, build interest, reveal slowly
  | "documentary_realism"; // raw, real, unpolished authenticity

export type AttentionStrategy =
  | "pattern_break"    // something unexpected stops the scroll
  | "pain_mirror"      // reflects viewer's pain immediately
  | "result_first"     // show the outcome before anything else
  | "authority_open"   // leads with credibility signal
  | "curiosity_gap";   // opens a loop the viewer needs to close

// ─── Emotional Arc ────────────────────────────────────────────────────────────

export type EmotionLabel =
  | "interruption"    // 0–2s: stop the scroll
  | "curiosity"       // 2–5s: what is this?
  | "identification"  // 5–10s: this is about me
  | "pain"            // pain or problem resonance
  | "revelation"      // the turn — here's something new
  | "proof"           // evidence, credibility
  | "desire"          // I want this
  | "trust"           // I believe this
  | "urgency"         // act now
  | "action";         // CTA moment

export type EmotionalStage = {
  startSecond: number;
  endSecond: number;
  emotion: EmotionLabel;
  intensity: "low" | "medium" | "high";
  note: string;
};

export type InterruptionStyle =
  | "visual_shock"   // unexpected image/cut
  | "verbal_hook"    // strong opening line that lands hard
  | "bold_claim"     // makes a statement no one expected
  | "question";      // opens with a direct question to the viewer

export type PacingCurve =
  | "fast_throughout"   // constant energy, no breathing room
  | "fast_then_slow"    // hook fast, hold on payoff
  | "slow_then_fast"    // build up, then escalate
  | "steady";           // consistent rhythm throughout

// ─── Platform ─────────────────────────────────────────────────────────────────

export type CaptionStrategy = "short_punch" | "storytelling" | "keyword_rich";

export type SubtitleBehavior =
  | "always_on"    // subtitles on all the time
  | "key_moments"  // subtitles only on important phrases
  | "minimal";     // rarely used, visuals lead

export type CtaPsychology =
  | "urgency"       // limited time, act now
  | "trust"         // safe choice, low risk
  | "curiosity"     // find out more, what's next
  | "social_proof"; // others are doing this

export type PlatformBehavior = {
  hookWindowSeconds: number;     // time before user swipes away
  captionStrategy: CaptionStrategy;
  hashtagCount: number;
  orientationNote: string;       // e.g. "vertical 9:16 only"
};

// ─── Human / cultural / entertainment amplification (Phase 1A) ───────────────
// Optional layer on top of marketing/cinematic blueprint. All fields optional;
// omit the whole object or leave fields unset for full backward compatibility (no-op).

export type HumanAmplification = {
  conversationalCutAggression?: number;
  awkwardHoldWeight?: number;
  conversationalDensity?: number;
  productionPolish?: "raw" | "balanced" | "polished";
  viewerMotivationPrimary?:
    | "business_default"
    | "entertainment"
    | "utility"
    | "hybrid";
};

// ─── Blueprint ───────────────────────────────────────────────────────────────

export type CreativeBlueprint = {
  // Visual layer
  visual_strategy: VisualStrategy;
  visual_energy: VisualEnergy;
  visual_identity: VisualIdentity;

  // Audio layer
  narration_strategy: NarrationStrategy;
  narration_tone: NarrationTone;
  soundtrack_strategy: SoundtrackStrategy;
  soundtrack_genre: SoundtrackGenre;

  // Narrative layer
  storytelling_model: StorytellingModel;
  attention_strategy: AttentionStrategy;

  // Emotional arc
  emotional_arc: EmotionalStage[];
  interruption_style: InterruptionStyle;

  // Execution
  pacing_curve: PacingCurve;
  subtitle_behavior: SubtitleBehavior;
  cta_psychology: CtaPsychology;

  // Platform
  platform_behavior: PlatformBehavior;

  // Meta
  blueprint_reasoning: string;
  confidence: "high" | "medium" | "low";

  /** Human/cultural/entertainment knobs; undefined = no change vs pre–Phase 1A behavior */
  humanAmplification?: HumanAmplification;
};
