import type { CreativeBlueprint } from "@/lib/features/content/creative-blueprint/types";
import type { RenderBlueprint } from "@/lib/features/content/render-blueprint/types";
import type { BusinessContentProfile } from "@/lib/services/business-content-profile.service";
import type { VariantStyle } from "@/lib/features/content/creative-blueprint/variant-cinematic-identity";

// ─── Public output ────────────────────────────────────────────────────────────

export type CreativeScore = {
  total: number; // 0–100 (equal-weighted average of 9 dimensions × 10)

  dimensions: {
    hook_strength: number;                   // 0–10
    business_identity_preservation: number;  // 0–10
    emotional_clarity: number;               // 0–10
    pacing_fit: number;                      // 0–10
    render_coherence: number;                // 0–10
    cta_alignment: number;                   // 0–10
    platform_fit: number;                    // 0–10
    trust_safety: number;                    // 0–10
    cinematic_distinction: number;           // 0–10
  };

  strengths: string[];
  risks: string[];

  recommendation:
    | "best_for_conversion"
    | "best_for_trust"
    | "best_for_education"
    | "balanced";

  reasoning: string;
};

// ─── Internal ─────────────────────────────────────────────────────────────────

export type ScoringInput = {
  variantBlueprint: CreativeBlueprint;
  renderBlueprint: RenderBlueprint;
  profile: BusinessContentProfile;
  variantStyle: VariantStyle;
  platform: string;
};

export type DimensionResult = {
  score: number;    // 0–10 (float, clamped before use)
  strengths: string[];
  risks: string[];
};
