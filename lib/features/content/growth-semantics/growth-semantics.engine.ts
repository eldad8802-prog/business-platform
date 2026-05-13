import type { BusinessContentProfile } from "@/lib/services/business-content-profile.service";
import type { CreativeBlueprint } from "@/lib/features/content/creative-blueprint/types";
import type { RenderBlueprint } from "@/lib/features/content/render-blueprint/types";
import type { VariantStyle } from "@/lib/features/content/creative-blueprint/variant-cinematic-identity";
import type {
  GrowthSemantics,
  GrowthSemanticsInput,
  DominantGrowthProfile,
} from "./types";

import { scoreConversion } from "./outcome-rules/conversion.rules";
import { scoreTrustBuilding } from "./outcome-rules/trust.rules";
import { scoreEngagement } from "./outcome-rules/engagement.rules";
import { scoreRetention } from "./outcome-rules/retention.rules";
import { scoreVirality } from "./outcome-rules/virality.rules";
import { scoreAuthority } from "./outcome-rules/authority.rules";
import {
  computeHumanAmplificationScoreGrowthDeltas,
  HA_GROWTH_REASON_LINE,
} from "@/lib/features/content/human-amplification/human-amplification-score-growth.delta";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function roundTo(n: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}

// ─── Dominant profile ─────────────────────────────────────────────────────────

function deriveDominantProfile(
  outcomes: GrowthSemantics["predicted_outcomes"]
): DominantGrowthProfile {
  const {
    conversion_probability,
    trust_building_strength,
    engagement_potential,
    virality_potential,
    authority_positioning,
  } = outcomes;

  // Group engagement and virality into one "engagement" signal
  const engagementPeak = Math.max(engagement_potential, virality_potential);

  const candidates: [DominantGrowthProfile, number][] = [
    ["conversion", conversion_probability],
    ["trust", trust_building_strength],
    ["engagement", engagementPeak],
    ["authority", authority_positioning],
  ];

  candidates.sort((a, b) => b[1] - a[1]);
  const [topProfile, topScore] = candidates[0];
  const [, secondScore] = candidates[1];

  // Require a clear winner (score >= 6 AND gap >= 1.5) to call a specific profile
  if (topScore >= 6 && topScore - secondScore >= 1.5) {
    return topProfile;
  }

  return "balanced";
}

// ─── Audience reaction model ──────────────────────────────────────────────────

function deriveStopBehavior(blueprint: CreativeBlueprint): string {
  const { attention_strategy, interruption_style, visual_energy } = blueprint;

  if (interruption_style === "bold_claim" && attention_strategy === "result_first") {
    return "Saw the outcome before they could scroll — a claim that demanded verification";
  }
  if (interruption_style === "bold_claim") {
    return "A provocative statement landed before the scroll completed — had to know if it was true";
  }
  if (attention_strategy === "pain_mirror") {
    return "Recognized their exact frustration in the opening line — involuntary recognition stop";
  }
  if (interruption_style === "question" && attention_strategy === "curiosity_gap") {
    return "A direct question opened a loop they couldn't leave unresolved";
  }
  if (attention_strategy === "curiosity_gap") {
    return "A hint at information they wanted — couldn't scroll past without knowing the answer";
  }
  if (interruption_style === "visual_shock") {
    return "An unexpected visual broke the scroll rhythm before the viewer decided whether to stop";
  }
  if (attention_strategy === "authority_open") {
    return "A credibility signal (expertise or proven result) earned 3 extra seconds of consideration";
  }
  if (visual_energy === "high") {
    return "High visual energy disrupted the feed's pace and triggered an involuntary pause";
  }
  return "Opening line or visual created enough curiosity to pause scrolling";
}

function deriveEmotionalResponse(
  blueprint: CreativeBlueprint,
  variantStyle: VariantStyle
): string {
  const { narration_tone, storytelling_model, visual_energy, cta_psychology, soundtrack_strategy } = blueprint;

  if (variantStyle === "trust" && narration_tone === "authoritative") {
    return "Calm confidence — viewer feels the brand knows what it's doing and is not trying to sell";
  }
  if (variantStyle === "trust" && narration_tone === "warm") {
    return "Genuine warmth — viewer feels seen, not pitched; safety without pressure";
  }
  if (narration_tone === "warm" && storytelling_model === "transformation") {
    return "Emotional resonance — sees themselves in the before, aspires to the after; brand becomes the bridge";
  }
  if (narration_tone === "authoritative" && storytelling_model === "proof_escalation") {
    return "Growing conviction — each beat adds credibility; viewer ends feeling this is the obvious choice";
  }
  if (cta_psychology === "urgency" && visual_energy === "high") {
    return "Activation and mild FOMO — feels like action is the natural next step, hesitation has a cost";
  }
  if (
    blueprint.attention_strategy === "pain_mirror" &&
    (storytelling_model === "problem_agitation" || storytelling_model === "objection_collapse")
  ) {
    return "Recognition then relief — own pain is named first, then an exit is offered";
  }
  if (variantStyle === "explanatory" && narration_tone === "confident") {
    return "Intellectual engagement — learned something they didn't know; brand gains quiet authority";
  }
  if (soundtrack_strategy === "emotional") {
    return "Emotional openness primed by music — message arrives into a receptive state before logic kicks in";
  }
  if (visual_energy === "high" && blueprint.interruption_style === "bold_claim") {
    return "High-energy activation — feels energized, wants to do something";
  }
  return "Moderate interest — engaged but not yet emotionally activated";
}

function deriveLikelyAction(
  blueprint: CreativeBlueprint,
  variantStyle: VariantStyle,
  platform: string,
  outcomes: GrowthSemantics["predicted_outcomes"]
): string {
  const { conversion_probability, trust_building_strength, virality_potential, authority_positioning, engagement_potential } = outcomes;

  if (conversion_probability >= 7.5) {
    return "Direct action (DM, click, or booking) — conversion signal strong enough to move viewer within the session";
  }
  if (virality_potential >= 7.0) {
    return `Share or tag on ${platform} — content resonates strongly enough to pass to someone else`;
  }
  if (authority_positioning >= 7.0 && trust_building_strength >= 6.0) {
    return "Follow and bookmark — viewer positions this brand as a go-to source, intends to return";
  }
  if (trust_building_strength >= 7.0) {
    return "Save for later or follow — not ready to convert now, but brand enters the consideration set";
  }
  if (engagement_potential >= 7.5) {
    return "Comment or react — content activated an opinion, question, or emotional response that needed expression";
  }
  if (variantStyle === "explanatory") {
    return "Profile visit or save — received educational value, wants to find more from this source";
  }
  if (blueprint.cta_psychology === "curiosity") {
    return "Profile visit or swipe-up — curiosity close converts scrollers into explorers";
  }
  return "Passive view-through — moderate impression, limited immediate action intent";
}

// ─── Growth reasoning builder ─────────────────────────────────────────────────
// Produces specific, non-generic growth signal explanations.
// Identifies stacks (aligned signals) and suppressors (competing signals).

function buildGrowthReasoning(
  blueprint: CreativeBlueprint,
  renderBlueprint: RenderBlueprint,
  variantStyle: VariantStyle,
  platform: string,
  outcomes: GrowthSemantics["predicted_outcomes"],
  conversionSignals: string[],
  trustSignals: string[],
  engagementSignals: string[],
  authoritySignals: string[],
  viralitySignals: string[],
  retentionSignals: string[]
): string[] {
  const reasons: string[] = [];

  const {
    conversion_probability,
    trust_building_strength,
    engagement_potential,
    retention_strength,
    virality_potential,
    authority_positioning,
  } = outcomes;

  // Describe the dominant profile with its key stack
  if (conversion_probability >= 7) {
    const stack = conversionSignals.slice(0, 2).join(" + ");
    reasons.push(`Conversion pathway: ${stack} — behavioral intent is immediate action`);
  }

  if (trust_building_strength >= 7) {
    const stack = trustSignals.slice(0, 2).join(" + ");
    reasons.push(`Trust architecture: ${stack} — each impression deposits credibility`);
  }

  if (authority_positioning >= 7) {
    const stack = authoritySignals.slice(0, 2).join(" + ");
    reasons.push(`Authority positioning: ${stack} — this content advances expert-brand status`);
  }

  if (virality_potential >= 6.5) {
    const stack = viralitySignals.slice(0, 2).join(" + ");
    reasons.push(`Viral potential: ${stack} — share motivation is present`);
  } else if (engagement_potential >= 7) {
    const stack = engagementSignals.slice(0, 2).join(" + ");
    reasons.push(`Engagement driver: ${stack} — in-feed reaction is the primary expected outcome`);
  }

  if (retention_strength >= 7) {
    const top = retentionSignals[0];
    if (top) reasons.push(`Retention signal: ${top}`);
  }

  // Cross-dimension tensions (suppressors)
  if (blueprint.cta_psychology === "urgency" && trust_building_strength < 5) {
    reasons.push(
      "Trust suppressed: urgency CTA trades credibility for conversion pressure — not suitable for long-cycle or authority-dependent businesses"
    );
  }

  if (conversion_probability < 5 && variantStyle === "direct" && blueprint.cta_psychology !== "urgency") {
    reasons.push(
      "Conversion below direct-variant potential: direct variant without urgency CTA limits immediate action — appropriate only if trust/authority is the real goal here"
    );
  }

  if (platform === "tiktok" && trust_building_strength > conversion_probability + 2) {
    reasons.push(
      "Trust-heavy content on TikTok: the platform rewards speed and energy, not patience — trust building will happen slowly here and reach fewer people than a conversion-optimized format"
    );
  }

  if (conversion_probability >= 7 && trust_building_strength >= 7) {
    reasons.push(
      "Dual-signal variant: both conversion and trust are elevated — uncommon; likely works because proof-based narrative satisfies both the skeptic and the ready buyer"
    );
  }

  // Always add the dominant profile summary as the last reasoning item
  const dominant = deriveDominantProfile(outcomes);
  if (dominant !== "balanced") {
    const dominantScore: Record<string, number> = {
      conversion: conversion_probability,
      trust: trust_building_strength,
      engagement: Math.max(engagement_potential, virality_potential),
      authority: authority_positioning,
    };
    reasons.push(
      `Dominant growth profile: ${dominant} (score: ${dominantScore[dominant]?.toFixed(1)}) — this is what the video is primarily trying to do`
    );
  } else {
    reasons.push(
      "Balanced growth profile — no single outcome dominates; spread may indicate a well-rounded variant or an unfocused one depending on campaign intent"
    );
  }

  return reasons;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function buildGrowthSemantics({
  variantBlueprint,
  renderBlueprint,
  profile,
  variantStyle,
  platform,
}: GrowthSemanticsInput): GrowthSemantics {
  // ── Score each outcome dimension ──────────────────────────────────────────

  const conversionResult = scoreConversion(variantBlueprint, renderBlueprint, profile, variantStyle, platform);
  const trustResult = scoreTrustBuilding(variantBlueprint, renderBlueprint, profile, variantStyle);
  const engagementResult = scoreEngagement(variantBlueprint, renderBlueprint, profile, variantStyle, platform);
  const retentionResult = scoreRetention(variantBlueprint, renderBlueprint, profile, variantStyle);
  const viralityResult = scoreVirality(variantBlueprint, renderBlueprint, profile, platform);
  const authorityResult = scoreAuthority(variantBlueprint, renderBlueprint, profile);

  // ── Assemble outcomes (round to 1 decimal, clamp 0-10) ────────────────────

  const predicted_outcomes_base: GrowthSemantics["predicted_outcomes"] = {
    conversion_probability:  roundTo(clamp(conversionResult.score, 0, 10), 1),
    trust_building_strength: roundTo(clamp(trustResult.score, 0, 10), 1),
    engagement_potential:    roundTo(clamp(engagementResult.score, 0, 10), 1),
    retention_strength:      roundTo(clamp(retentionResult.score, 0, 10), 1),
    virality_potential:      roundTo(clamp(viralityResult.score, 0, 10), 1),
    authority_positioning:   roundTo(clamp(authorityResult.score, 0, 10), 1),
  };

  const dominant_growth_profile = deriveDominantProfile(predicted_outcomes_base);

  const { outcomeDelta, affected: haGrowthAffected } = computeHumanAmplificationScoreGrowthDeltas(
    variantBlueprint,
    { profile, variantStyle, platform, renderBlueprint }
  );

  const predicted_outcomes: GrowthSemantics["predicted_outcomes"] = {
    conversion_probability: roundTo(
      clamp(predicted_outcomes_base.conversion_probability + outcomeDelta.conversion_probability, 0, 10),
      1
    ),
    trust_building_strength: roundTo(
      clamp(predicted_outcomes_base.trust_building_strength + outcomeDelta.trust_building_strength, 0, 10),
      1
    ),
    engagement_potential: roundTo(
      clamp(predicted_outcomes_base.engagement_potential + outcomeDelta.engagement_potential, 0, 10),
      1
    ),
    retention_strength: roundTo(
      clamp(predicted_outcomes_base.retention_strength + outcomeDelta.retention_strength, 0, 10),
      1
    ),
    virality_potential: roundTo(
      clamp(predicted_outcomes_base.virality_potential + outcomeDelta.virality_potential, 0, 10),
      1
    ),
    authority_positioning: roundTo(
      clamp(predicted_outcomes_base.authority_positioning + outcomeDelta.authority_positioning, 0, 10),
      1
    ),
  };

  const audience_reaction_model = {
    likely_stop_behavior:      deriveStopBehavior(variantBlueprint),
    likely_emotional_response: deriveEmotionalResponse(variantBlueprint, variantStyle),
    likely_action:             deriveLikelyAction(variantBlueprint, variantStyle, platform, predicted_outcomes),
  };

  const growth_reasoning = [
    ...buildGrowthReasoning(
      variantBlueprint,
      renderBlueprint,
      variantStyle,
      platform,
      predicted_outcomes_base,
      conversionResult.topSignals,
      trustResult.topSignals,
      engagementResult.topSignals,
      authorityResult.topSignals,
      viralityResult.topSignals,
      retentionResult.topSignals
    ),
    ...(haGrowthAffected ? [HA_GROWTH_REASON_LINE] : []),
  ];

  return {
    predicted_outcomes,
    dominant_growth_profile,
    audience_reaction_model,
    growth_reasoning,
  };
}
