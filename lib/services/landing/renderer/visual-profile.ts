/**
 * P3-D · LandingVisualProfile — PRESENTATION ONLY, derived deterministically from the strategy type and
 * the shape of material the blueprint already contains (is there an approved hero image, how many
 * offerings / trust claims). It never changes strategy, objective, conversion, trust authority, content
 * truth or section eligibility — the renderer only decides how already-decided content looks.
 */

export type LandingVisualProfile = {
  /** Overall page composition. */
  composition: "ACTION_LED" | "PROOF_LED" | "CATALOG_LED" | "PLACE_LED" | "STORY_LED";
  heroTreatment: "IMAGE_SPLIT" | "TYPOGRAPHIC_BOLD" | "TYPOGRAPHIC_CALM" | "PROOF_BAND" | "CATALOG_STRIP" | "PLACE_CARD";
  density: "AIRY" | "BALANCED" | "COMPACT";
  cardTreatment: "OUTLINED" | "ELEVATED" | "TILE" | "LIST";
  imageEmphasis: "NONE" | "SUPPORTING" | "PRIMARY";
  contentWidth: "NARROW" | "MEDIUM" | "WIDE";
  ctaEmphasis: "PROMINENT" | "STANDARD" | "NONE";
  trustTreatment: "LEAD_BAND" | "INLINE_LIST" | "QUIET_NOTE";
  /** Section-surface rhythm: which surfaces alternate down the page. */
  rhythm: "ALTERNATE" | "CONTINUOUS" | "BANDED";
  /** Colour family from the existing design tokens (never a free colour). */
  palette: "TEAL" | "SAND" | "SAGE" | "STONE";
};

export type ProfileInput = {
  strategyType: string;
  hasHeroImage: boolean;
  offeringCount: number;
  trustClaimCount: number;
  surfaceOnly: boolean;
};

export function visualProfileFor(i: ProfileInput): LandingVisualProfile {
  const cta = i.surfaceOnly ? "NONE" : undefined;
  switch (i.strategyType) {
    case "REQUEST_QUOTE_FIRST":
      return { composition: "ACTION_LED", heroTreatment: i.hasHeroImage ? "IMAGE_SPLIT" : "TYPOGRAPHIC_BOLD", density: "BALANCED", cardTreatment: "OUTLINED", imageEmphasis: i.hasHeroImage ? "SUPPORTING" : "NONE", contentWidth: "WIDE", ctaEmphasis: cta ?? "PROMINENT", trustTreatment: "INLINE_LIST", rhythm: "ALTERNATE", palette: "TEAL" };
    case "BOOKING_FIRST":
      return { composition: "ACTION_LED", heroTreatment: i.hasHeroImage ? "IMAGE_SPLIT" : "TYPOGRAPHIC_CALM", density: "AIRY", cardTreatment: "TILE", imageEmphasis: i.hasHeroImage ? "SUPPORTING" : "NONE", contentWidth: "MEDIUM", ctaEmphasis: cta ?? "PROMINENT", trustTreatment: "INLINE_LIST", rhythm: "CONTINUOUS", palette: "SAGE" };
    case "CALL_FIRST":
    case "WHATSAPP_FIRST":
    case "LEAD_CAPTURE_FIRST":
      return { composition: "ACTION_LED", heroTreatment: "TYPOGRAPHIC_BOLD", density: "COMPACT", cardTreatment: "LIST", imageEmphasis: i.hasHeroImage ? "SUPPORTING" : "NONE", contentWidth: "MEDIUM", ctaEmphasis: cta ?? "PROMINENT", trustTreatment: "INLINE_LIST", rhythm: "CONTINUOUS", palette: "TEAL" };
    case "TRUST_AUTHORITY_FIRST":
      return { composition: "PROOF_LED", heroTreatment: "PROOF_BAND", density: "AIRY", cardTreatment: "ELEVATED", imageEmphasis: i.hasHeroImage ? "SUPPORTING" : "NONE", contentWidth: "NARROW", ctaEmphasis: cta ?? "STANDARD", trustTreatment: "LEAD_BAND", rhythm: "BANDED", palette: "STONE" };
    case "PRODUCT_DISCOVERY_FIRST":
      return { composition: "CATALOG_LED", heroTreatment: "CATALOG_STRIP", density: "COMPACT", cardTreatment: "TILE", imageEmphasis: "PRIMARY", contentWidth: "WIDE", ctaEmphasis: cta ?? "STANDARD", trustTreatment: "QUIET_NOTE", rhythm: "CONTINUOUS", palette: "SAND" };
    case "SERVICE_DISCOVERY_FIRST":
      return { composition: "STORY_LED", heroTreatment: i.hasHeroImage ? "IMAGE_SPLIT" : "TYPOGRAPHIC_CALM", density: "BALANCED", cardTreatment: i.offeringCount > 4 ? "TILE" : "OUTLINED", imageEmphasis: i.hasHeroImage ? "SUPPORTING" : "NONE", contentWidth: "WIDE", ctaEmphasis: cta ?? "STANDARD", trustTreatment: i.trustClaimCount ? "INLINE_LIST" : "QUIET_NOTE", rhythm: "ALTERNATE", palette: "SAGE" };
    case "LOCAL_VISIT_FIRST":
      return { composition: "PLACE_LED", heroTreatment: "PLACE_CARD", density: "BALANCED", cardTreatment: "ELEVATED", imageEmphasis: i.hasHeroImage ? "PRIMARY" : "NONE", contentWidth: "MEDIUM", ctaEmphasis: cta ?? "PROMINENT", trustTreatment: "QUIET_NOTE", rhythm: "BANDED", palette: "SAND" };
    default:
      // Unknown strategy types never reach here (the render model rejects them first).
      throw new Error(`No visual profile for strategy type ${i.strategyType}`);
  }
}

export const PROFILE_DIMENSIONS = ["composition", "heroTreatment", "density", "cardTreatment", "imageEmphasis", "contentWidth", "ctaEmphasis", "trustTreatment", "rhythm"] as const;
