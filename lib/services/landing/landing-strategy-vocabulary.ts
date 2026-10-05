/**
 * P3-B · Landing strategy vocabulary — CLOSED and versioned. A strategy is a decision plan (what the
 * page is FOR, who it speaks to, what it leads with, how a visitor acts), never copy or a template.
 *
 * Every v1 type was checked against what Dubiz can actually do today (P3-A conversion capabilities):
 * a type exists only if a real path can carry it, or — for the narrative types — if real material
 * can fill it. Types that would imply a capability Dubiz lacks are listed in EXCLUDED_STRATEGY_TYPES
 * with the reason, so nobody adds them back by accident.
 */

export const STRATEGY_ENGINE_VERSION = "p3b.strategy.v1";

export const STRATEGY_TYPES = [
  "REQUEST_QUOTE_FIRST",
  "BOOKING_FIRST",
  "CALL_FIRST",
  "WHATSAPP_FIRST",
  "LEAD_CAPTURE_FIRST",
  "LOCAL_VISIT_FIRST",
  "TRUST_AUTHORITY_FIRST",
  "SERVICE_DISCOVERY_FIRST",
  "PRODUCT_DISCOVERY_FIRST",
] as const;
export type StrategyType = (typeof STRATEGY_TYPES)[number];

/** Not in v1 — each would promise something Dubiz cannot back today. */
export const EXCLUDED_STRATEGY_TYPES: Record<string, string> = {
  OFFER_FIRST: "No offer / promotion has public-use authority (Offer and Coupon carry no public-use model), so a page cannot lead with one.",
  PRODUCT_PURCHASE_FIRST: "DUBIZ_CHECKOUT is not supported and no canonical external shop-link authority exists; buying in store is LOCAL_VISIT_FIRST, browsing is PRODUCT_DISCOVERY_FIRST.",
  ONLINE_BOOKING_FIRST: "DUBIZ_BOOKING is not supported; booking by message (phone / WhatsApp / email, declared by the owner) is BOOKING_FIRST.",
  SOCIAL_PROOF_FIRST: "No sourced testimonial, review or rating system exists; TRUST_AUTHORITY_FIRST uses only public-effective trust claims.",
};

export type VisitorIntent =
  | "NEEDS_A_QUOTE"
  | "WANTS_AN_APPOINTMENT"
  | "READY_TO_TALK"
  | "WANTS_TO_MESSAGE"
  | "LEAVING_DETAILS"
  | "WANTS_TO_VISIT"
  | "EVALUATING_TRUST"
  | "BROWSING_SERVICES"
  | "BROWSING_PRODUCTS";

export type NarrativeApproach =
  | "NEED_TO_QUOTE"
  | "AVAILABILITY_TO_BOOKING"
  | "DIRECT_CONTACT"
  | "LOW_FRICTION_LEAD"
  | "PLACE_AND_HOURS"
  | "PROOF_FIRST"
  | "CATALOG_TOUR";

export type OfferingEmphasis = "QUOTED_SERVICES" | "BOOKABLE_SERVICES" | "SERVICES" | "PRODUCTS" | "FEATURED" | "ALL";
export type TrustEmphasis = "LEADING" | "SUPPORTING" | "MINIMAL";
export type ProofEmphasis = "PROCESS" | "AVAILABILITY" | "RESPONSIVENESS" | "PLACE" | "TRUST_CLAIMS" | "CATALOG_DEPTH";

/** Page sections are STRUCTURE (what the page must contain), never content. */
export const SECTION_CODES = [
  "HERO",
  "PRIMARY_ACTION",
  "QUOTE_PROCESS",
  "BOOKING_INFO",
  "CONTACT_PANEL",
  "LOCATION_AND_HOURS",
  "SERVICES_OVERVIEW",
  "PRODUCTS_SHOWCASE",
  "FEATURED_OFFERINGS",
  "TRUST_PROOF",
  "ABOUT",
  "SERVICE_AREA",
] as const;
export type SectionCode = (typeof SECTION_CODES)[number];

/**
 * Asset needs. Only OFFERING_IMAGE can ever be matched today (an approved asset linked to the
 * offering); the other roles are not modelled on BusinessAsset and are therefore never inferred —
 * above all, an owner / team photo is never assigned from an unclassified or generated image.
 */
export type AssetNeedKind = "OFFERING_IMAGE" | "HERO_IMAGE" | "LOCATION_IMAGE" | "OWNER_OR_TEAM_IMAGE" | "SERVICE_RESULT_IMAGE";

export type StrategyProfile = {
  family: "CONVERSION" | "NARRATIVE";
  /** The P2 objective the strategy converts on (CONVERSION family), or the discovery objective it serves. */
  objective: string;
  visitorIntent: VisitorIntent;
  narrativeApproach: NarrativeApproach;
  offeringEmphasis: OfferingEmphasis;
  trustEmphasis: TrustEmphasis;
  proofEmphasis: ProofEmphasis;
  sections: SectionCode[];
  assetNeeds: { kind: AssetNeedKind; essential: boolean }[];
};

export const STRATEGY_PROFILES: Record<StrategyType, StrategyProfile> = {
  REQUEST_QUOTE_FIRST: {
    family: "CONVERSION", objective: "REQUEST_QUOTE", visitorIntent: "NEEDS_A_QUOTE", narrativeApproach: "NEED_TO_QUOTE",
    offeringEmphasis: "QUOTED_SERVICES", trustEmphasis: "SUPPORTING", proofEmphasis: "PROCESS",
    sections: ["HERO", "QUOTE_PROCESS", "SERVICES_OVERVIEW", "TRUST_PROOF", "SERVICE_AREA", "PRIMARY_ACTION"],
    assetNeeds: [{ kind: "SERVICE_RESULT_IMAGE", essential: false }, { kind: "OFFERING_IMAGE", essential: false }],
  },
  BOOKING_FIRST: {
    family: "CONVERSION", objective: "BOOK", visitorIntent: "WANTS_AN_APPOINTMENT", narrativeApproach: "AVAILABILITY_TO_BOOKING",
    offeringEmphasis: "BOOKABLE_SERVICES", trustEmphasis: "SUPPORTING", proofEmphasis: "AVAILABILITY",
    sections: ["HERO", "BOOKING_INFO", "SERVICES_OVERVIEW", "LOCATION_AND_HOURS", "TRUST_PROOF", "PRIMARY_ACTION"],
    assetNeeds: [{ kind: "OFFERING_IMAGE", essential: false }, { kind: "LOCATION_IMAGE", essential: false }],
  },
  CALL_FIRST: {
    family: "CONVERSION", objective: "CALL", visitorIntent: "READY_TO_TALK", narrativeApproach: "DIRECT_CONTACT",
    offeringEmphasis: "SERVICES", trustEmphasis: "SUPPORTING", proofEmphasis: "RESPONSIVENESS",
    sections: ["HERO", "PRIMARY_ACTION", "SERVICES_OVERVIEW", "SERVICE_AREA", "TRUST_PROOF", "CONTACT_PANEL"],
    assetNeeds: [{ kind: "HERO_IMAGE", essential: false }],
  },
  WHATSAPP_FIRST: {
    family: "CONVERSION", objective: "WHATSAPP", visitorIntent: "WANTS_TO_MESSAGE", narrativeApproach: "DIRECT_CONTACT",
    offeringEmphasis: "SERVICES", trustEmphasis: "SUPPORTING", proofEmphasis: "RESPONSIVENESS",
    sections: ["HERO", "PRIMARY_ACTION", "SERVICES_OVERVIEW", "TRUST_PROOF", "CONTACT_PANEL"],
    assetNeeds: [{ kind: "HERO_IMAGE", essential: false }],
  },
  LEAD_CAPTURE_FIRST: {
    family: "CONVERSION", objective: "LEAVE_LEAD", visitorIntent: "LEAVING_DETAILS", narrativeApproach: "LOW_FRICTION_LEAD",
    offeringEmphasis: "ALL", trustEmphasis: "SUPPORTING", proofEmphasis: "PROCESS",
    sections: ["HERO", "PRIMARY_ACTION", "ABOUT", "SERVICES_OVERVIEW", "TRUST_PROOF"],
    assetNeeds: [{ kind: "HERO_IMAGE", essential: false }],
  },
  LOCAL_VISIT_FIRST: {
    family: "CONVERSION", objective: "VISIT_STORE", visitorIntent: "WANTS_TO_VISIT", narrativeApproach: "PLACE_AND_HOURS",
    offeringEmphasis: "FEATURED", trustEmphasis: "SUPPORTING", proofEmphasis: "PLACE",
    sections: ["HERO", "LOCATION_AND_HOURS", "FEATURED_OFFERINGS", "ABOUT", "PRIMARY_ACTION"],
    assetNeeds: [{ kind: "LOCATION_IMAGE", essential: false }, { kind: "OFFERING_IMAGE", essential: false }],
  },
  TRUST_AUTHORITY_FIRST: {
    family: "NARRATIVE", objective: "TRUST", visitorIntent: "EVALUATING_TRUST", narrativeApproach: "PROOF_FIRST",
    offeringEmphasis: "FEATURED", trustEmphasis: "LEADING", proofEmphasis: "TRUST_CLAIMS",
    sections: ["HERO", "TRUST_PROOF", "ABOUT", "FEATURED_OFFERINGS", "PRIMARY_ACTION"],
    assetNeeds: [{ kind: "OWNER_OR_TEAM_IMAGE", essential: false }],
  },
  SERVICE_DISCOVERY_FIRST: {
    family: "NARRATIVE", objective: "DISCOVER_SERVICES", visitorIntent: "BROWSING_SERVICES", narrativeApproach: "CATALOG_TOUR",
    offeringEmphasis: "SERVICES", trustEmphasis: "MINIMAL", proofEmphasis: "CATALOG_DEPTH",
    sections: ["HERO", "SERVICES_OVERVIEW", "FEATURED_OFFERINGS", "ABOUT", "PRIMARY_ACTION"],
    assetNeeds: [{ kind: "OFFERING_IMAGE", essential: false }],
  },
  PRODUCT_DISCOVERY_FIRST: {
    family: "NARRATIVE", objective: "DISCOVER_PRODUCTS", visitorIntent: "BROWSING_PRODUCTS", narrativeApproach: "CATALOG_TOUR",
    offeringEmphasis: "PRODUCTS", trustEmphasis: "MINIMAL", proofEmphasis: "CATALOG_DEPTH",
    sections: ["HERO", "PRODUCTS_SHOWCASE", "FEATURED_OFFERINGS", "LOCATION_AND_HOURS", "PRIMARY_ACTION"],
    assetNeeds: [{ kind: "OFFERING_IMAGE", essential: true }],
  },
};

/** The dimensions two strategies must differ on to count as genuinely different. */
export const DIVERSITY_DIMENSIONS = [
  "primaryObjective",
  "conversionChannel",
  "visitorIntent",
  "offeringEmphasis",
  "trustEmphasis",
  "narrativeApproach",
  "leadSection",
  "proofEmphasis",
] as const;
export type DiversityDimension = (typeof DIVERSITY_DIMENSIONS)[number];
/** Two kept strategies must differ on at least this many of the 8 dimensions. */
export const MIN_DIVERSITY_DISTANCE = 4;
export const MAX_STRATEGIES = 3;
