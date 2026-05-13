import type { BusinessContentProfile } from "@/lib/services/business-content-profile.service";
import type { CreativeBlueprint, HumanAmplification } from "@/lib/features/content/creative-blueprint/types";
import type { RenderBlueprint } from "@/lib/features/content/render-blueprint/types";
import type { VariantStyle } from "@/lib/features/content/creative-blueprint/variant-cinematic-identity";
import type { CreativeScore } from "@/lib/features/content/creative-scoring/types";
import type { GrowthSemantics } from "@/lib/features/content/growth-semantics/types";

const DIM_KEYS = [
  "hook_strength",
  "business_identity_preservation",
  "emotional_clarity",
  "pacing_fit",
  "render_coherence",
  "cta_alignment",
  "platform_fit",
  "trust_safety",
  "cinematic_distinction",
] as const satisfies readonly (keyof CreativeScore["dimensions"])[];

const OUTCOME_KEYS = [
  "conversion_probability",
  "trust_building_strength",
  "engagement_potential",
  "retention_strength",
  "virality_potential",
  "authority_positioning",
] as const satisfies readonly (keyof GrowthSemantics["predicted_outcomes"])[];

export type HaScoreGrowthContext = {
  profile: BusinessContentProfile;
  variantStyle: VariantStyle;
  platform: string;
  renderBlueprint: RenderBlueprint;
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function hasDefinedHumanAmplificationField(ha: HumanAmplification): boolean {
  return (
    ha.conversationalCutAggression !== undefined ||
    ha.awkwardHoldWeight !== undefined ||
    ha.conversationalDensity !== undefined ||
    ha.productionPolish !== undefined ||
    ha.viewerMotivationPrimary !== undefined
  );
}

function isHumanAmplificationNeutral(ha: HumanAmplification): boolean {
  if (ha.conversationalCutAggression !== undefined && ha.conversationalCutAggression !== 0) {
    return false;
  }
  if (ha.awkwardHoldWeight !== undefined && ha.awkwardHoldWeight !== 0) {
    return false;
  }
  if (ha.conversationalDensity !== undefined && ha.conversationalDensity !== 0) {
    return false;
  }
  if (ha.productionPolish !== undefined && ha.productionPolish !== "balanced") {
    return false;
  }
  if (
    ha.viewerMotivationPrimary !== undefined &&
    ha.viewerMotivationPrimary !== "business_default"
  ) {
    return false;
  }
  return true;
}

export function isHumanAmplificationScoreGrowthNoOp(blueprint: CreativeBlueprint): boolean {
  const ha = blueprint.humanAmplification;
  if (ha === undefined || !hasDefinedHumanAmplificationField(ha) || isHumanAmplificationNeutral(ha)) {
    return true;
  }
  return false;
}

function regulated(profile: BusinessContentProfile): boolean {
  const c = profile.marketCategory;
  return c === "legal" || c === "finance" || c === "health";
}

function luxuryPremium(profile: BusinessContentProfile): boolean {
  return profile.brandPersona === "luxury" || profile.brandPersona === "premium";
}

function authorityHeavy(profile: BusinessContentProfile): boolean {
  return profile.contentStyle === "authority" || regulated(profile);
}

function zeroDims(): Record<(typeof DIM_KEYS)[number], number> {
  const o = {} as Record<(typeof DIM_KEYS)[number], number>;
  for (const k of DIM_KEYS) o[k] = 0;
  return o;
}

function zeroOutcomes(): Record<(typeof OUTCOME_KEYS)[number], number> {
  const o = {} as Record<(typeof OUTCOME_KEYS)[number], number>;
  for (const k of OUTCOME_KEYS) o[k] = 0;
  return o;
}

/**
 * Phase 1D — bounded HA deltas for score dimensions and growth outcomes.
 * Pure: does not mutate blueprint.
 */
export function computeHumanAmplificationScoreGrowthDeltas(
  blueprint: CreativeBlueprint,
  ctx: HaScoreGrowthContext
): {
  dimensionDelta: Record<(typeof DIM_KEYS)[number], number>;
  outcomeDelta: Record<(typeof OUTCOME_KEYS)[number], number>;
  affected: boolean;
} {
  if (isHumanAmplificationScoreGrowthNoOp(blueprint)) {
    return { dimensionDelta: zeroDims(), outcomeDelta: zeroOutcomes(), affected: false };
  }

  const ha = blueprint.humanAmplification!;
  const { profile, variantStyle, platform, renderBlueprint } = ctx;
  const reg = regulated(profile);
  const lux = luxuryPremium(profile);
  const authH = authorityHeavy(profile);
  const isTrust = variantStyle === "trust";
  const isDirect = variantStyle === "direct";
  const isExplanatory = variantStyle === "explanatory";

  const dimensionDelta = zeroDims();
  const outcomeDelta = zeroOutcomes();

  if (ha.conversationalCutAggression !== undefined) {
    const a = ha.conversationalCutAggression;
    if (isDirect) dimensionDelta.pacing_fit += 0.1 * a;
    if (isExplanatory) dimensionDelta.pacing_fit -= 0.08 * a;
    if (isTrust) dimensionDelta.pacing_fit -= 0.06 * a;
    if (platform === "tiktok" && !reg) {
      dimensionDelta.cinematic_distinction += 0.06 * a;
    }
    const engC = reg ? 0.02 * a : 0.08 * a;
    const virC = reg ? 0.02 * a : 0.06 * a;
    outcomeDelta.engagement_potential += engC;
    outcomeDelta.virality_potential += virC;
    if (isDirect && !reg) {
      outcomeDelta.conversion_probability += 0.05 * a;
    }
  }

  if (ha.awkwardHoldWeight !== undefined) {
    const w = ha.awkwardHoldWeight;
    if (isTrust || isExplanatory) dimensionDelta.pacing_fit += 0.08 * w;
    if (isDirect) dimensionDelta.pacing_fit -= 0.05 * w;
    if (isTrust || reg) dimensionDelta.trust_safety += 0.06 * w;
    outcomeDelta.retention_strength += 0.1 * w;
    if (isTrust || reg) {
      outcomeDelta.trust_building_strength += 0.08 * w;
    }
  }

  if (ha.conversationalDensity !== undefined) {
    const d = ha.conversationalDensity;
    if (isExplanatory) dimensionDelta.emotional_clarity -= 0.07 * d;
    if (isDirect) dimensionDelta.emotional_clarity += 0.05 * d;
    if (isExplanatory && renderBlueprint.subtitle_rhythm === "burst") {
      dimensionDelta.pacing_fit -= 0.05 * d;
    }
    let engD = 0.07 * d;
    if (reg) engD *= 2 / 7;
    outcomeDelta.engagement_potential += engD;
    if (authH) {
      outcomeDelta.authority_positioning -= 0.05 * d;
    }
  }

  if (ha.productionPolish !== undefined) {
    switch (ha.productionPolish) {
      case "raw":
        if (lux) dimensionDelta.trust_safety -= 0.06;
        if (
          renderBlueprint.preset === "documentary_real" ||
          renderBlueprint.preset === "retail_tiktok"
        ) {
          dimensionDelta.render_coherence += 0.04;
        }
        break;
      case "polished":
        dimensionDelta.trust_safety += 0.08;
        dimensionDelta.render_coherence += 0.06;
        outcomeDelta.trust_building_strength += 0.06;
        if (authH) {
          outcomeDelta.authority_positioning += 0.05;
        }
        break;
      default:
        break;
    }
  }

  if (ha.viewerMotivationPrimary !== undefined) {
    switch (ha.viewerMotivationPrimary) {
      case "utility":
        dimensionDelta.pacing_fit += 0.03;
        dimensionDelta.emotional_clarity += 0.04;
        outcomeDelta.conversion_probability += 0.1;
        if (reg) outcomeDelta.trust_building_strength += 0.05;
        break;
      case "entertainment": {
        if (isTrust) dimensionDelta.pacing_fit -= 0.04;
        if (!reg) dimensionDelta.emotional_clarity += 0.05;
        const engE = reg ? 0.03 : 0.08;
        const virE = reg ? 0.02 : 0.06;
        outcomeDelta.engagement_potential += engE;
        outcomeDelta.virality_potential += virE;
        if (!isDirect) {
          let convPen = -0.06;
          if (authH) convPen = Math.max(convPen, -0.03);
          outcomeDelta.conversion_probability += convPen;
        }
        if (isTrust) {
          outcomeDelta.trust_building_strength -= 0.04;
        }
        break;
      }
      case "hybrid":
        dimensionDelta.emotional_clarity += 0.03;
        outcomeDelta.engagement_potential += 0.04;
        outcomeDelta.virality_potential += 0.04;
        outcomeDelta.conversion_probability += 0.04;
        break;
      default:
        break;
    }
  }

  for (const k of DIM_KEYS) {
    dimensionDelta[k] = clamp(round2(dimensionDelta[k]), -0.25, 0.25);
  }
  for (const k of OUTCOME_KEYS) {
    outcomeDelta[k] = clamp(round2(outcomeDelta[k]), -0.3, 0.3);
  }

  if (isTrust) {
    outcomeDelta.virality_potential = clamp(outcomeDelta.virality_potential, -0.3, 0.04);
    outcomeDelta.engagement_potential = clamp(outcomeDelta.engagement_potential, -0.3, 0.05);
  }

  let l1 = 0;
  for (const k of DIM_KEYS) l1 += Math.abs(dimensionDelta[k]);
  for (const k of OUTCOME_KEYS) l1 += Math.abs(outcomeDelta[k]);
  if (l1 > 1.2 && l1 > 0) {
    const s = 1.2 / l1;
    for (const k of DIM_KEYS) dimensionDelta[k] = round2(dimensionDelta[k] * s);
    for (const k of OUTCOME_KEYS) outcomeDelta[k] = round2(outcomeDelta[k] * s);
    for (const k of DIM_KEYS) dimensionDelta[k] = clamp(dimensionDelta[k], -0.25, 0.25);
    for (const k of OUTCOME_KEYS) outcomeDelta[k] = clamp(outcomeDelta[k], -0.3, 0.3);
    if (isTrust) {
      outcomeDelta.virality_potential = clamp(outcomeDelta.virality_potential, -0.3, 0.04);
      outcomeDelta.engagement_potential = clamp(outcomeDelta.engagement_potential, -0.3, 0.05);
    }
  }

  const affected = DIM_KEYS.some((k) => dimensionDelta[k] !== 0) || OUTCOME_KEYS.some((k) => outcomeDelta[k] !== 0);

  return { dimensionDelta, outcomeDelta, affected };
}

export const HA_SCORE_STRENGTH_LINE =
  "Human amplification: bounded pacing and outcome adjustments applied within guardrails.";

export const HA_GROWTH_REASON_LINE =
  "Human amplification: bounded outcome adjustments applied within guardrails.";
