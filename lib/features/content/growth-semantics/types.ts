import type { CreativeBlueprint } from "@/lib/features/content/creative-blueprint/types";
import type { RenderBlueprint } from "@/lib/features/content/render-blueprint/types";
import type { BusinessContentProfile } from "@/lib/services/business-content-profile.service";
import type { VariantStyle } from "@/lib/features/content/creative-blueprint/variant-cinematic-identity";

// ─── Public output ────────────────────────────────────────────────────────────

export type DominantGrowthProfile =
  | "conversion"
  | "trust"
  | "engagement"
  | "authority"
  | "balanced";

export type GrowthSemantics = {
  predicted_outcomes: {
    conversion_probability: number;   // 0–10: likelihood this drives a direct action (DM/click/buy)
    trust_building_strength: number;  // 0–10: brand credibility accumulation per view
    engagement_potential: number;     // 0–10: likes/comments/reactions triggered
    retention_strength: number;       // 0–10: watch-through, saves, and return visits
    virality_potential: number;       // 0–10: share/tag/repost probability
    authority_positioning: number;    // 0–10: expert/go-to status signal per impression
  };

  dominant_growth_profile: DominantGrowthProfile;

  audience_reaction_model: {
    likely_stop_behavior: string;      // why the viewer stops scrolling
    likely_emotional_response: string; // what they feel during the video
    likely_action: string;             // what they do after watching
  };

  growth_reasoning: string[]; // specific, auditable explanations for each key outcome
};

// ─── Internal ─────────────────────────────────────────────────────────────────

export type GrowthSemanticsInput = {
  variantBlueprint: CreativeBlueprint;
  renderBlueprint: RenderBlueprint;
  profile: BusinessContentProfile;
  variantStyle: VariantStyle;
  platform: string;
};

export type OutcomeResult = {
  score: number;       // 0–10 (float, clamped before use)
  topSignals: string[]; // 1–3 key signal descriptions driving this score
};
