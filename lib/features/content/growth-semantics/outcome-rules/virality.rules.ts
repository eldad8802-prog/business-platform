import type { CreativeBlueprint } from "@/lib/features/content/creative-blueprint/types";
import type { RenderBlueprint } from "@/lib/features/content/render-blueprint/types";
import type { BusinessContentProfile } from "@/lib/services/business-content-profile.service";
import type { OutcomeResult } from "../types";

// ─── virality_potential ───────────────────────────────────────────────────────
// Probability this content gets shared, duetted, stitched, or tagged.
// Virality is NOT about being good — it's about being shareable.
//
// Shareable content: bold claims people debate, pain that resonates widely,
// transformations people want their friends to see, and content that feels native to
// the platform's viral mechanics (TikTok duets, Instagram saves/shares).
//
// Virality is rare — base score starts low. Only specific combinations earn high scores.

export function scoreVirality(
  blueprint: CreativeBlueprint,
  renderBlueprint: RenderBlueprint,
  profile: BusinessContentProfile,
  platform: string
): OutcomeResult {
  let score = 3.0;
  const topSignals: string[] = [];

  // ── Platform is the single biggest modifier ────────────────────────────────

  if (platform === "tiktok") {
    score += 1.5;
    topSignals.push("TikTok platform — the primary viral distribution channel; duet/stitch/FYP mechanics amplify share probability");
  } else if (platform === "instagram") {
    score += 0.5;
    // Instagram saves go viral through shares/reposts but lower base velocity
  } else if (platform === "facebook") {
    score -= 0.5;
    // Facebook virality is mostly groups; lower for SMB content
  }

  // ── Interruption style (what makes someone share) ─────────────────────────

  if (blueprint.interruption_style === "bold_claim") {
    score += 2.0;
    topSignals.push("bold_claim interruption — provocative statements are the #1 share trigger: 'did you see this?'");
  } else if (blueprint.interruption_style === "visual_shock") {
    score += 2.0;
    topSignals.push("visual_shock interruption — unexpected visuals break feed patterns and trigger screen-capture shares");
  } else if (blueprint.interruption_style === "question") {
    score += 0.5;
    // Questions invite comment more than shares
  }

  // ── Attention strategy ────────────────────────────────────────────────────

  if (blueprint.attention_strategy === "pain_mirror") {
    score += 1.5;
    topSignals.push("pain_mirror strategy — 'this is exactly my life' content gets tagged to friends experiencing the same problem");
  } else if (blueprint.attention_strategy === "curiosity_gap") {
    score += 1.5;
    topSignals.push("curiosity_gap strategy — 'you have to see how this ends' is a fundamental share behavior");
  } else if (blueprint.attention_strategy === "result_first") {
    score += 0.5;
    // Results can inspire shares but less compulsively
  }

  // ── Storytelling model ────────────────────────────────────────────────────

  if (blueprint.storytelling_model === "transformation") {
    score += 1.5;
    topSignals.push("transformation model — before/after content is highly shareable across all platforms");
  } else if (blueprint.storytelling_model === "objection_collapse") {
    score += 1.0;
    topSignals.push("objection_collapse model — debatable claims generate shares to people who need convincing");
  } else if (blueprint.storytelling_model === "problem_agitation") {
    score += 0.5;
    // Relatable pain = shares to commiserate
  }

  // ── Render preset and energy ──────────────────────────────────────────────

  if (renderBlueprint.preset === "retail_tiktok") {
    score += 1.5;
    topSignals.push("retail_tiktok render preset — native platform aesthetic gets favored by TikTok's algorithm, increasing organic reach");
  }

  if (blueprint.visual_energy === "high") {
    score += 1.0;
    topSignals.push("high visual energy — fast, stimulating content matches viral content's typical pattern");
  } else if (blueprint.visual_energy === "calm") {
    score -= 1.0;
    // Calm content rarely goes viral
  }

  // ── Business emotional driver ─────────────────────────────────────────────

  if (profile.emotionalDriver === "status") {
    score += 1.0;
    topSignals.push("status emotional driver — aspirational identity content has strong share-for-self-image motivation");
  } else if (profile.emotionalDriver === "desire") {
    score += 0.5;
    topSignals.push("desire emotional driver — 'I want this' content gets shared to hint at own desires");
  }

  // ── Suppressors ───────────────────────────────────────────────────────────

  if (renderBlueprint.preset === "authority_minimal") {
    score -= 1.0;
    // Authority aesthetics are respected but rarely shared
  }

  if (blueprint.narration_tone === "authoritative" && platform === "tiktok") {
    score -= 0.5;
    // Authority voice on TikTok feels formal, lower share rate
  }

  return { score: Math.min(10, Math.max(0, score)), topSignals };
}
