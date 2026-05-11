import type { CreativeBlueprint } from "@/lib/features/content/creative-blueprint/types";
import type { RenderBlueprint } from "@/lib/features/content/render-blueprint/types";
import type { BusinessContentProfile } from "@/lib/services/business-content-profile.service";
import type { VariantStyle } from "@/lib/features/content/creative-blueprint/variant-cinematic-identity";
import type { OutcomeResult } from "../types";

// ─── engagement_potential ─────────────────────────────────────────────────────
// How much this creative activates in-feed reactions: likes, comments, saves, DMs,
// and algorithm engagement signals. Distinct from conversion (which is off-platform action)
// and retention (which is about saving / returning).
//
// Engagement is driven by: emotional resonance, debate-triggering claims,
// curiosity loops, and platform-native formats.

export function scoreEngagement(
  blueprint: CreativeBlueprint,
  renderBlueprint: RenderBlueprint,
  profile: BusinessContentProfile,
  variantStyle: VariantStyle,
  platform: string
): OutcomeResult {
  let score = 5.0;
  const topSignals: string[] = [];

  // ── Visual energy ─────────────────────────────────────────────────────────

  if (blueprint.visual_energy === "high") {
    score += 2.0;
    topSignals.push("high visual energy — keeps viewer cognitively active, increasing interaction impulse");
  } else if (blueprint.visual_energy === "calm") {
    score -= 0.5;
  }

  // ── Attention strategy ────────────────────────────────────────────────────

  if (blueprint.attention_strategy === "curiosity_gap") {
    score += 2.0;
    topSignals.push("curiosity_gap attention strategy — unresolved tension drives comments, saves, and shares to resolve it");
  } else if (blueprint.attention_strategy === "pain_mirror") {
    score += 1.5;
    topSignals.push("pain_mirror attention strategy — viewer recognition of their own problem activates comments and tags");
  } else if (blueprint.attention_strategy === "result_first") {
    score += 0.5;
    // Result-first converts more than engages
  }

  // ── Interruption style ────────────────────────────────────────────────────

  if (blueprint.interruption_style === "question") {
    score += 1.5;
    topSignals.push("question interruption style — direct question to viewer is the highest comment-activation format");
  } else if (blueprint.interruption_style === "bold_claim") {
    score += 1.0;
    topSignals.push("bold_claim interruption — provocative statements invite agreement, disagreement, and debate in comments");
  }

  // ── Storytelling model ────────────────────────────────────────────────────

  if (blueprint.storytelling_model === "objection_collapse") {
    score += 1.0;
    topSignals.push("objection_collapse model — surfacing objections triggers viewer's own objections → comments");
  } else if (blueprint.storytelling_model === "curiosity_gap") {
    score += 1.5;
    topSignals.push("curiosity_gap storytelling model — layered mystery sustains engagement through the full video");
  } else if (blueprint.storytelling_model === "problem_agitation") {
    score += 1.0;
    topSignals.push("problem_agitation model — amplified pain activates strong emotional responses");
  }

  // ── CTA psychology ────────────────────────────────────────────────────────

  if (blueprint.cta_psychology === "curiosity") {
    score += 1.0;
    topSignals.push("curiosity CTA — 'find out more' naturally drives saves and profile visits");
  } else if (blueprint.cta_psychology === "social_proof") {
    score += 0.5;
    // Social proof triggers comments about own experiences
  }

  // ── Platform context ──────────────────────────────────────────────────────

  if (platform === "tiktok") {
    score += 1.5;
    topSignals.push("TikTok platform — duet/stitch/comment culture amplifies engagement mechanics; algorithm rewards high interaction rate");
  } else if (platform === "instagram") {
    score += 0.5;
    // Reels engagement is strong but lower comment culture than TikTok
  }

  if (platform === "tiktok" && renderBlueprint.preset === "retail_tiktok") {
    score += 0.5;
    topSignals.push("retail_tiktok preset on TikTok — native format maximizes algorithm engagement scoring");
  }

  // ── Subtitle rhythm ───────────────────────────────────────────────────────

  if (renderBlueprint.subtitle_rhythm === "punchy" || renderBlueprint.subtitle_rhythm === "burst") {
    score += 0.5;
    topSignals.push("fast subtitle rhythm — high readability keeps viewers watching longer → higher engagement rate");
  }

  // ── Business emotional driver ─────────────────────────────────────────────

  if (profile.emotionalDriver === "desire") {
    score += 0.5;
    topSignals.push("desire emotional driver — aspirational content reliably triggers saves and shares among target audience");
  } else if (profile.emotionalDriver === "pain") {
    score += 0.5;
    topSignals.push("pain emotional driver — relatable suffering activates tag-a-friend and comment behavior");
  } else if (profile.emotionalDriver === "status") {
    score += 0.5;
    topSignals.push("status emotional driver — aspirational identity content triggers shares to signal self-image");
  }

  return { score: Math.min(10, Math.max(0, score)), topSignals };
}
