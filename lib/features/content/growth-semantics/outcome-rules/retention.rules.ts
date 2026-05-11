import type { CreativeBlueprint } from "@/lib/features/content/creative-blueprint/types";
import type { RenderBlueprint } from "@/lib/features/content/render-blueprint/types";
import type { BusinessContentProfile } from "@/lib/services/business-content-profile.service";
import type { VariantStyle } from "@/lib/features/content/creative-blueprint/variant-cinematic-identity";
import type { OutcomeResult } from "../types";

// ─── retention_strength ───────────────────────────────────────────────────────
// Whether this content creates lasting impressions: watch-through completion,
// saves to revisit later, and profile-level loyalty (following, returning to see more).
//
// Retention is NOT about immediate action — it's about whether this video
// makes the viewer want to stay with the brand over time.
//
// High retention: curiosity loops that reward patience, emotional journeys,
// educational payoffs, and intimate storytelling that builds attachment.

export function scoreRetention(
  blueprint: CreativeBlueprint,
  renderBlueprint: RenderBlueprint,
  profile: BusinessContentProfile,
  variantStyle: VariantStyle
): OutcomeResult {
  let score = 4.5;
  const topSignals: string[] = [];

  // ── Storytelling model ────────────────────────────────────────────────────

  if (blueprint.storytelling_model === "transformation") {
    score += 2.0;
    topSignals.push("transformation model — before→after arc compels viewers to watch to the end and remember the brand");
  } else if (blueprint.storytelling_model === "proof_escalation") {
    score += 2.0;
    topSignals.push("proof_escalation model — rising stakes keep viewers watching as each beat adds value");
  } else if (blueprint.storytelling_model === "curiosity_gap") {
    score += 2.0;
    topSignals.push("curiosity_gap model — unresolved tension is the strongest watch-completion driver; the answer is at the end");
  } else if (blueprint.storytelling_model === "local_trust") {
    score += 1.5;
    topSignals.push("local_trust model — community/human narrative creates attachment and return behavior");
  } else if (blueprint.storytelling_model === "expert_dominance") {
    score += 1.0;
    topSignals.push("expert_dominance model — authoritative delivery builds habit of returning to this source");
  }

  // ── Attention strategy ────────────────────────────────────────────────────

  if (blueprint.attention_strategy === "curiosity_gap") {
    score += 2.0;
    topSignals.push("curiosity_gap attention strategy — the open loop from the first 2 seconds holds viewers to the close");
  } else if (blueprint.attention_strategy === "pain_mirror") {
    score += 0.5;
    // Pain identification creates recall, but doesn't guarantee completion
  }

  // ── Narration tone ────────────────────────────────────────────────────────

  if (blueprint.narration_tone === "intimate") {
    score += 1.5;
    topSignals.push("intimate narration — personal closeness creates individual attachment; viewers follow to continue the relationship");
  } else if (blueprint.narration_tone === "warm") {
    score += 1.0;
    topSignals.push("warm narration — caring voice encourages follow behavior and return visits");
  }

  // ── Variant style ─────────────────────────────────────────────────────────

  if (variantStyle === "explanatory") {
    score += 1.5;
    topSignals.push("explanatory variant — educational payoff is the highest driver of save behavior and follow intention");
  } else if (variantStyle === "trust") {
    score += 0.5;
    // Trust builds brand affinity → some return behavior
  } else if (variantStyle === "direct") {
    score -= 0.5;
    // Direct variants are designed for action, not loyalty
  }

  // ── CTA psychology ────────────────────────────────────────────────────────

  if (blueprint.cta_psychology === "curiosity") {
    score += 1.5;
    topSignals.push("curiosity CTA — 'find out more' is a save-and-return invitation");
  } else if (blueprint.cta_psychology === "trust") {
    score += 0.5;
    // Low-pressure close = brand is comfortable letting viewer think → return likelihood
  }

  // ── Soundtrack ────────────────────────────────────────────────────────────

  if (blueprint.soundtrack_strategy === "emotional") {
    score += 1.0;
    topSignals.push("emotional soundtrack — music creates memory anchoring; viewers associate the feeling with the brand");
  } else if (blueprint.soundtrack_strategy === "subtle") {
    score += 0.5;
  }

  // ── Pacing ────────────────────────────────────────────────────────────────

  if (blueprint.pacing_curve === "fast_then_slow") {
    score += 1.0;
    topSignals.push("fast_then_slow pacing — opens fast to hook, slows down for payoff, reward structure increases watch completion");
  } else if (blueprint.pacing_curve === "fast_throughout") {
    score -= 0.5;
    // Fast throughout = high churn after action moment
  }

  // ── Business context ──────────────────────────────────────────────────────

  if (profile.salesCycle === "long" || profile.salesCycle === "medium") {
    score += 0.5;
    topSignals.push("medium/long sales cycle — retention is the primary value of content when the decision takes time");
  }

  if (profile.emotionalDriver === "trust") {
    score += 0.5;
    topSignals.push("trust emotional driver — viewer's decision process requires repeated exposures; retention = future conversion");
  }

  if (profile.contentStyle === "explanation") {
    score += 0.5;
    // Educational content style = viewers expect to learn, increases completion rate
  }

  return { score: Math.min(10, Math.max(0, score)), topSignals };
}
