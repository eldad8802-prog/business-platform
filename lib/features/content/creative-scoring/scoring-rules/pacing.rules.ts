import type { CreativeBlueprint } from "@/lib/features/content/creative-blueprint/types";
import type { RenderBlueprint } from "@/lib/features/content/render-blueprint/types";
import type { VariantStyle } from "@/lib/features/content/creative-blueprint/variant-cinematic-identity";
import type { DimensionResult } from "../types";

// ─── pacing_fit ───────────────────────────────────────────────────────────────
// Measures whether the pacing architecture matches the variant's purpose.
// Direct should move. Explanatory needs breathing room. Trust should feel spacious.

export function scorePacingFit(
  blueprint: CreativeBlueprint,
  renderBlueprint: RenderBlueprint,
  variantStyle: VariantStyle
): DimensionResult {
  let score = 6.0;
  const strengths: string[] = [];
  const risks: string[] = [];

  const pacing = blueprint.pacing_curve;
  const sceneSpacing = renderBlueprint.scene_spacing;
  const subtitleRhythm = renderBlueprint.subtitle_rhythm;

  // ── Direct variant: needs to move fast ────────────────────────────────────

  if (variantStyle === "direct") {
    if (pacing === "fast_throughout") {
      score += 2.0;
      strengths.push("Direct variant with fast_throughout pacing — relentless forward momentum, no dead air");
    }
    if (sceneSpacing === "tight") {
      score += 1.0;
      strengths.push("Tight scene spacing — clips cut before attention can drift");
    } else if (sceneSpacing === "standard") {
      score += 0.5;
    } else if (sceneSpacing === "generous") {
      score -= 1.0;
      risks.push("Direct variant with generous scene spacing — too much breathing room for a variant meant to drive action");
    }
    if (subtitleRhythm === "punchy" || subtitleRhythm === "burst") {
      score += 0.5;
      strengths.push(`${subtitleRhythm} subtitle rhythm — text delivery matches the direct variant's pace`);
    }
    if (pacing === "slow_then_fast") {
      score -= 1.5;
      risks.push("Direct variant starts slow (slow_then_fast) — weak opening undercuts the direct variant's core promise");
    }
  }

  // ── Explanatory variant: needs space to absorb ────────────────────────────

  if (variantStyle === "explanatory") {
    if (sceneSpacing === "generous") {
      score += 2.0;
      strengths.push("Generous scene spacing — viewer has time to process each educational beat before the next one");
    } else if (sceneSpacing === "extended") {
      score += 1.5;
      strengths.push("Extended scene spacing — breathing room for concept absorption");
    } else if (sceneSpacing === "tight") {
      score -= 1.0;
      risks.push("Tight scene spacing on explanatory variant — clips cut before information can land");
    }
    if (subtitleRhythm === "slow" || subtitleRhythm === "medium") {
      score += 1.5;
      strengths.push(`${subtitleRhythm} subtitle rhythm — readable pace for educational content`);
    } else if (subtitleRhythm === "burst") {
      score -= 1.5;
      risks.push("Burst subtitle rhythm on explanatory variant — text flashes too fast for educational absorption");
    }
    if (pacing === "fast_throughout") {
      score -= 2.0;
      risks.push("Explanatory variant with fast_throughout pacing — too rushed for education, viewer can't absorb the value");
    }
    if (pacing === "slow_then_fast" || pacing === "fast_then_slow") {
      score += 1.0;
      strengths.push(`${pacing} pacing — dynamic rhythm supports the build-up/reveal structure of educational content`);
    }
  }

  // ── Trust variant: needs measured, unhurried delivery ────────────────────

  if (variantStyle === "trust") {
    if (sceneSpacing === "extended" || sceneSpacing === "generous") {
      score += 1.5;
      strengths.push(`${sceneSpacing} scene spacing — spacious delivery signals that the brand is not in a hurry, reinforcing trust`);
    }
    if (pacing === "steady") {
      score += 1.0;
      strengths.push("Steady pacing — consistent rhythm reads as reliable, predictable, trustworthy");
    } else if (pacing === "slow_then_fast") {
      score += 0.5;
      // Gentle build-up is fine for trust
    } else if (pacing === "fast_throughout") {
      score -= 2.0;
      risks.push(
        "Trust variant with fast_throughout pacing — urgency contradicts trust-building; viewer feels rushed, not reassured"
      );
    }
    if (subtitleRhythm === "burst") {
      score -= 1.5;
      risks.push("Burst subtitle rhythm on trust variant — frenetic text delivery feels anxious, not trustworthy");
    } else if (subtitleRhythm === "slow" || subtitleRhythm === "medium") {
      score += 0.5;
      strengths.push(`${subtitleRhythm} subtitle rhythm — calm text pace reinforces the trust arc`);
    }
  }

  return {
    score: Math.min(10, Math.max(0, score)),
    strengths,
    risks,
  };
}
