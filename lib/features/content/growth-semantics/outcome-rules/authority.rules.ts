import type { CreativeBlueprint } from "@/lib/features/content/creative-blueprint/types";
import type { RenderBlueprint } from "@/lib/features/content/render-blueprint/types";
import type { BusinessContentProfile } from "@/lib/services/business-content-profile.service";
import type { OutcomeResult } from "../types";

// ─── authority_positioning ────────────────────────────────────────────────────
// How much this content advances the brand's position as the expert/go-to source.
// Authority is not about conversion — it's about occupying the "obviously the best"
// position in the viewer's mental map of this category.
//
// Authority is built by: proof, calm expertise, credentialing, and premium presentation.
// Authority is NOT built by: urgency, frenetic energy, or discount-oriented content.

export function scoreAuthority(
  blueprint: CreativeBlueprint,
  renderBlueprint: RenderBlueprint,
  profile: BusinessContentProfile
): OutcomeResult {
  let score = 4.0;
  const topSignals: string[] = [];

  // ── Narration tone (biggest driver) ──────────────────────────────────────

  if (blueprint.narration_tone === "authoritative") {
    score += 3.0;
    topSignals.push("authoritative narration tone — expert-level calm dominance is the strongest single authority signal");
  } else if (blueprint.narration_tone === "confident") {
    score += 1.5;
    topSignals.push("confident narration — declarative voice builds credibility without over-claiming");
  }

  // ── Storytelling model ────────────────────────────────────────────────────

  if (blueprint.storytelling_model === "expert_dominance") {
    score += 2.5;
    topSignals.push("expert_dominance narrative model — the entire arc is structured to establish and reinforce expertise");
  } else if (blueprint.storytelling_model === "proof_escalation") {
    score += 2.0;
    topSignals.push("proof_escalation model — rising stack of credentials/results systematically builds authority perception");
  } else if (blueprint.storytelling_model === "authority") {
    score += 2.0;
    topSignals.push("authority narrative model — credentialing comes first, offer comes after");
  }

  // ── Attention strategy ────────────────────────────────────────────────────

  if (blueprint.attention_strategy === "authority_open") {
    score += 2.0;
    topSignals.push("authority_open attention strategy — opens with a credibility signal before the pitch; authority-first framing");
  } else if (blueprint.attention_strategy === "result_first") {
    score += 1.0;
    topSignals.push("result_first attention strategy — outcomes-first framing positions brand as proven and results-driven");
  }

  // ── Render identity ───────────────────────────────────────────────────────

  if (renderBlueprint.preset === "authority_minimal") {
    score += 2.0;
    topSignals.push("authority_minimal render preset — visual restraint is the aesthetic of institutional authority");
  } else if (renderBlueprint.preset === "premium_modern") {
    score += 1.0;
    topSignals.push("premium_modern render preset — editorial aesthetic positions brand in the high-quality thought-leader register");
  } else if (renderBlueprint.preset === "documentary_real") {
    score += 0.5;
    // Raw = honest = some authority, especially for local/service businesses
  } else if (renderBlueprint.preset === "retail_tiktok") {
    score -= 1.5;
    // Retail aesthetic is incompatible with authority positioning
  } else if (renderBlueprint.preset === "conversion_fast") {
    score -= 0.5;
    // Conversion preset reads as sales, not expertise
  }

  // ── Visual energy ─────────────────────────────────────────────────────────

  if (blueprint.visual_energy === "calm") {
    score += 1.0;
    topSignals.push("calm visual energy — composed pacing signals that the brand is not scrambling for attention");
  } else if (blueprint.visual_energy === "high") {
    score -= 0.5;
    // Loud content can command attention but authority is quiet
  }

  // ── CTA psychology ────────────────────────────────────────────────────────

  if (blueprint.cta_psychology === "social_proof") {
    score += 1.5;
    topSignals.push("social_proof CTA — others' validation is a core authority signal; 'everyone comes to us'");
  } else if (blueprint.cta_psychology === "urgency") {
    score -= 1.0;
    topSignals.push("urgency CTA suppresses authority — pressure tactics signal sales anxiety, not earned expertise");
  }

  // ── Render scene spacing ──────────────────────────────────────────────────

  if (renderBlueprint.scene_spacing === "generous") {
    score += 0.5;
    topSignals.push("generous scene spacing — unhurried pacing projects the confidence of a brand that doesn't need to rush");
  }

  // ── Business context ──────────────────────────────────────────────────────

  if (profile.marketCategory === "legal" || profile.marketCategory === "finance") {
    score += 1.0;
    topSignals.push(
      `${profile.marketCategory} market category — authority is the category's primary purchase driver; every authority signal is directly monetizable`
    );
  } else if (profile.marketCategory === "health" || profile.marketCategory === "education") {
    score += 0.5;
    topSignals.push("health/education category — expertise positioning has direct impact on viewer's willingness to engage");
  }

  if (profile.emotionalDriver === "status") {
    score += 0.5;
    topSignals.push("status emotional driver — viewers aspire to be associated with the best; authority signals directly satisfy this");
  }

  return { score: Math.min(10, Math.max(0, score)), topSignals };
}
