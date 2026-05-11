import type { CreativeBlueprint } from "@/lib/features/content/creative-blueprint/types";
import type { RenderBlueprint } from "@/lib/features/content/render-blueprint/types";
import type { BusinessContentProfile } from "@/lib/services/business-content-profile.service";
import type { VariantStyle } from "@/lib/features/content/creative-blueprint/variant-cinematic-identity";
import type { OutcomeResult } from "../types";

// ─── trust_building_strength ──────────────────────────────────────────────────
// How much brand credibility this creative deposits per impression.
// High = viewer becomes meaningfully more likely to trust and consider the business.
// Not about immediate conversion — about changing the viewer's perception of the brand.
//
// Trust is built through: calm authority, warm voice, patient pacing, proof, safety CTA.
// Trust is destroyed by: urgency pressure, frenetic energy, cheap aesthetics on premium brands.

function isHighTrustProfessional(profile: BusinessContentProfile): boolean {
  return (
    profile.marketCategory === "legal" ||
    profile.marketCategory === "finance" ||
    (profile.contentStyle === "authority" && profile.trustLevel === "high")
  );
}

export function scoreTrustBuilding(
  blueprint: CreativeBlueprint,
  renderBlueprint: RenderBlueprint,
  profile: BusinessContentProfile,
  variantStyle: VariantStyle
): OutcomeResult {
  let score = 4.0;
  const topSignals: string[] = [];

  // ── Variant intent ────────────────────────────────────────────────────────

  if (variantStyle === "trust") {
    score += 3.0;
    topSignals.push("trust variant — the entire arc is built to reduce resistance and establish safety");
  }

  // ── Narration tone ────────────────────────────────────────────────────────

  if (blueprint.narration_tone === "authoritative") {
    score += 2.0;
    topSignals.push("authoritative narration tone — expert voice signals calm dominance, highest trust register for professional businesses");
  } else if (blueprint.narration_tone === "warm") {
    score += 1.5;
    topSignals.push("warm narration tone — caring voice creates emotional safety, viewer feels seen not sold to");
  } else if (blueprint.narration_tone === "intimate") {
    score += 1.5;
    topSignals.push("intimate narration tone — personal closeness builds individual-level trust bond");
  }

  // ── CTA psychology ────────────────────────────────────────────────────────

  if (blueprint.cta_psychology === "trust") {
    score += 2.0;
    topSignals.push("trust CTA psychology — close reinforces safety and low-pressure commitment");
  } else if (blueprint.cta_psychology === "social_proof") {
    score += 1.0;
    topSignals.push("social_proof CTA — others' validation reduces individual risk perception");
  } else if (blueprint.cta_psychology === "urgency") {
    score -= 2.0;
    topSignals.push("urgency CTA actively suppresses trust — pressure at the close signals desperation over confidence");
  }

  // ── Storytelling model ────────────────────────────────────────────────────

  if (blueprint.storytelling_model === "local_trust") {
    score += 1.5;
    topSignals.push("local_trust narrative model — community feel and human presence are primary trust builders");
  } else if (blueprint.storytelling_model === "proof_escalation") {
    score += 1.5;
    topSignals.push("proof_escalation model — rising stack of evidence builds rational trust that survives skepticism");
  } else if (blueprint.storytelling_model === "documentary_realism") {
    score += 1.5;
    topSignals.push("documentary_realism model — raw authenticity signals nothing to hide, trust through transparency");
  }

  // ── Visual energy ─────────────────────────────────────────────────────────

  if (blueprint.visual_energy === "calm") {
    score += 1.0;
    topSignals.push("calm visual energy — composed pacing reads as confidence, not anxiety");
  } else if (blueprint.visual_energy === "high" && isHighTrustProfessional(profile)) {
    score -= 2.0;
    topSignals.push("high energy on authority brand actively destroys trust — frenetic movement signals panic, not expertise");
  }

  // ── Render configuration ──────────────────────────────────────────────────

  if (renderBlueprint.preset === "authority_minimal") {
    score += 2.0;
    topSignals.push("authority_minimal render preset — visual restraint signals that the brand earns attention, not demands it");
  } else if (renderBlueprint.preset === "trust_soft") {
    score += 1.5;
    topSignals.push("trust_soft render preset — warm, spacious render creates the visual feel of a safe brand");
  } else if (renderBlueprint.preset === "documentary_real") {
    score += 1.0;
    topSignals.push("documentary_real preset — raw visual aesthetic says 'we have nothing to hide'");
  } else if (renderBlueprint.preset === "conversion_fast") {
    score -= 1.5;
  } else if (renderBlueprint.preset === "retail_tiktok") {
    score -= 1.0;
  }

  if (renderBlueprint.scene_spacing === "generous" || renderBlueprint.scene_spacing === "extended") {
    score += 0.5;
    topSignals.push("spacious scene timing — unhurried delivery signals a brand that is not desperate for the close");
  }

  // ── Business context ──────────────────────────────────────────────────────

  if (isHighTrustProfessional(profile)) {
    score += 1.0;
    topSignals.push(
      `high-trust professional category (${profile.marketCategory}) — trust is the primary currency of this business; every trust signal compounds`
    );
  }

  if (profile.emotionalDriver === "trust" || profile.emotionalDriver === "security") {
    score += 0.5;
    topSignals.push("security/trust emotional driver — viewer is already primed to weigh trust signals heavily");
  }

  if (profile.salesCycle === "long" || profile.salesCycle === "medium") {
    score += 0.5;
    topSignals.push("medium/long sales cycle — trust accumulates across touchpoints; this video contributes to a longer consideration arc");
  }

  return { score: Math.min(10, Math.max(0, score)), topSignals };
}
