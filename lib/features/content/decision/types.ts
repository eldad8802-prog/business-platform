import type { BusinessContentProfile } from "@/lib/services/business-content-profile.service";

export type Goal = "leads" | "trust" | "exposure" | "sales";

export type ContentAngle =
  | "show_result"
  | "explain"
  | "show_difference"
  | "attention"
  | "trust"
  | "cta";

export type SelectedFormat = "reel" | "video" | "image" | "post";

export type SelectedPlatform = "instagram" | "tiktok" | "facebook";

export type Mode = "ai" | "camera" | "voice";

export type DirectionInput = {
  id?: string;
  title?: string;
  description?: string;
  whyItFits?: string;
  type?: string;
  strategy?: string;
  tone?: string;
  pace?: string;
  recommendedFormat?: SelectedFormat;
  score?: number;
};

/** Marketing content archetype — orthogonal to video length (SHORT/MID/FULL). */
export type ContentType =
  | "PROMO"
  | "EDUCATIONAL"
  | "TRUST"
  | "PROBLEM_SOLUTION"
  | "DEMONSTRATION"
  | "OFFER";

export type VideoLengthType = "SHORT" | "MID" | "FULL";

export type HookStyle =
  | "pattern_break"
  | "pain_first"
  | "result_first"
  | "trust_first"
  | "offer_first";

export type CtaType =
  | "message_now"
  | "book_now"
  | "buy_now"
  | "follow"
  | "learn_more";

export type Intent = "message" | "book" | "follow" | "learn_more";

export type Pace = "fast" | "medium" | "slow";

/** Mirrors profile narrative template family for transparency in v1. */
export type TemplateType = NonNullable<BusinessContentProfile["contentStyle"]>;

export type VisualMode = "high" | "medium" | "low";

export type DecisionKey =
  | "ctaStyle"
  | "videoType"
  | "durationSeconds"
  | "structure"
  | "pace"
  | "hookStyle"
  | "tone";

/**
 * Explainability rule identifiers — stable product-level IDs.
 * MVP-0 is intentionally minimal (CTA + video/duration only).
 */
export type RuleId =
  | "cta.intent_override"
  | "cta.default_by_goal_leads"
  | "cta.default_by_goal_trust"
  | "cta.default_by_goal_exposure"
  | "cta.default_by_goal_sales"
  | "video.profile_recommended_default"
  | "video.format_video_forces_full"
  | "video.reel_caps_full_duration"
  | "video.pain_longform_escalation"
  | "video.explanation_short_to_mid";

export type DecisionInsightDriver = {
  key:
    | "goal"
    | "intent"
    | "intentResolved"
    | "selectedFormat"
    | "business.recommendedVideoType"
    | "business.salesCycle"
    | "business.trustLevel"
    | "indicator.painMatched"
    | "indicator.explanationMatched";
  value: string | number | boolean;
  role: "input" | "profile" | "derived";
};

export type DecisionInsight = {
  decisionKey: DecisionKey;
  value: string | number | boolean | string[];
  drivers: DecisionInsightDriver[];
  rulesFired: RuleId[];
  confidence: "high" | "medium" | "low";
  note?: string;
};

export type DecisionInsightsBundle = {
  decisionSummary: string;
  cards: DecisionInsight[];
};

export type DecisionInput = {
  goal?: Goal;
  intent?: Intent | string;
  contentAngle?: ContentAngle;
  contentGoalPrompt?: string;
  selectedFormat?: SelectedFormat;
  selectedPlatform?: SelectedPlatform;
  selectedDirection?: DirectionInput;
  brandTone?: string;
};

/** Fields consumed by `buildVideoPlan` today (legacy contract). */
export type LegacyVideoPlanMapping = {
  videoType: VideoLengthType;
  durationSeconds: number;
  structure: string[];
  pace: Pace;
  hookStyle: HookStyle;
  ctaStyle: CtaType;
};

export type ContentDecision = {
  primaryGoal: Goal;
  contentType: ContentType;
  videoType: VideoLengthType;
  structure: string[];
  hookStyle: HookStyle;
  pace: Pace;
  targetDurationSeconds: number;
  tone: string;
  ctaType: CtaType;
  templateType: TemplateType;
  visualMode: VisualMode;
  decisionReason: string;
  businessFit: string;
  platformFit: string;
  legacyMapping: LegacyVideoPlanMapping;
  decisionInsights?: DecisionInsightsBundle;
};
