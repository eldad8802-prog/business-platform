import type { CreativeBlueprint } from "@/lib/features/content/creative-blueprint/types";
import type { RenderBlueprint } from "@/lib/features/content/render-blueprint/types";
import type { VariantStyle } from "@/lib/features/content/creative-blueprint/variant-cinematic-identity";
import type { DimensionResult } from "../types";

// ─── cta_alignment ────────────────────────────────────────────────────────────
// Measures whether the CTA psychology matches what the variant style is trying to do.
// Each variant has a natural CTA register — misalignment breaks the emotional arc.

export function scoreCtaAlignment(
  blueprint: CreativeBlueprint,
  renderBlueprint: RenderBlueprint,
  variantStyle: VariantStyle
): DimensionResult {
  let score = 5.0;
  const strengths: string[] = [];
  const risks: string[] = [];

  const cta = blueprint.cta_psychology;

  // ── Variant-specific CTA expectations ────────────────────────────────────

  if (variantStyle === "direct") {
    if (cta === "urgency") {
      score += 3.0;
      strengths.push("Direct variant with urgency CTA — maximum conversion pressure: variant style and CTA psychology reinforce each other");
    } else if (cta === "social_proof") {
      score += 1.5;
      strengths.push("Direct variant with social_proof CTA — proof-based urgency is a strong secondary CTA for direct content");
    } else if (cta === "trust") {
      score -= 1.0;
      risks.push("Direct variant with trust CTA — soft close under-delivers on direct variant's conversion potential");
    }
    // curiosity: neutral (0 delta)
  }

  if (variantStyle === "explanatory") {
    if (cta === "curiosity") {
      score += 2.5;
      strengths.push("Explanatory variant with curiosity CTA — 'find out more' naturally closes an educational arc");
    } else if (cta === "social_proof") {
      score += 2.0;
      strengths.push("Explanatory variant with social_proof CTA — after educating the viewer, proof validates the decision");
    } else if (cta === "trust") {
      score += 1.0;
      strengths.push("Explanatory variant with trust CTA — acceptable; low-pressure close fits educational tone");
    } else if (cta === "urgency") {
      score -= 1.5;
      risks.push(
        "Explanatory variant with urgency CTA — educational tone builds slow trust; urgency at the close creates whiplash"
      );
    }
  }

  if (variantStyle === "trust") {
    if (cta === "trust") {
      score += 3.0;
      strengths.push("Trust variant with trust CTA psychology — complete arc coherence: trust built throughout, trust-aligned close");
    } else if (cta === "social_proof") {
      score += 1.0;
      strengths.push("Trust variant with social_proof CTA — soft social reinforcement is compatible with trust arc");
    } else if (cta === "urgency") {
      score -= 3.0;
      risks.push(
        "Critical CTA misalignment: trust variant with urgency CTA — the entire trust arc is destroyed at the close. Viewer goes from safety to pressure in one beat."
      );
    } else if (cta === "curiosity") {
      score -= 0.5;
      // Mild misfit — curiosity is uncertain, not trust-reinforcing
    }
  }

  // ── Render CTA reinforcement ──────────────────────────────────────────────
  // Check if the render config actually gives the CTA proper expression.

  const cfg = renderBlueprint.presetConfig;

  if (cfg.lastClipBonus >= 0.3) {
    score += 0.5;
    strengths.push(`CTA receives extended screen time (lastClipBonus: +${cfg.lastClipBonus}s) — viewer has time to act`);
  }

  if (renderBlueprint.cta_animation_style !== "static") {
    score += 0.5;
    strengths.push(`CTA is animated (${renderBlueprint.cta_animation_style}) — visual motion draws attention to the close`);
  }

  return {
    score: Math.min(10, Math.max(0, score)),
    strengths,
    risks,
  };
}
