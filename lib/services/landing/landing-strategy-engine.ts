import { CHANNEL_PREFERENCE_ORDER, type CapabilityState, type ConversionPath } from "@/lib/services/conversion/conversion-resolver";
import type { LandingBusinessContext, LandingOffering } from "./landing-business-context";
import {
  DIVERSITY_DIMENSIONS,
  MAX_STRATEGIES,
  MIN_DIVERSITY_DISTANCE,
  STRATEGY_ENGINE_VERSION,
  STRATEGY_PROFILES,
  STRATEGY_TYPES,
  type AssetNeedKind,
  type DiversityDimension,
  type SectionCode,
  type StrategyProfile,
  type StrategyType,
} from "./landing-strategy-vocabulary";
import { explainStrategy } from "./landing-strategy-explain";

/**
 * P3-B · Landing strategy engine — PURE and DETERMINISTIC (no clock, no randomness, no model call).
 *
 *   LandingBusinessContext → candidates (one per closed type) → viability → score → owner authority
 *   → diversity filter → 1..3 strategies (recommended, alternative, alternative)
 *
 * Boundaries this file keeps:
 *   - CTA capability is never decided here: every action comes from the P3-A conversion resolver's
 *     paths. PLATFORM_UNPROVEN carries a strategy only when the OWNER chose that objective × channel.
 *   - The owner's primary objective, when it can be served, is the recommended strategy. Evidence may
 *     add alternatives and a surfaced divergence; it never silently replaces the owner.
 *   - Evidence is "usedForDecision"; only `publishable` material is "allowedForPublication".
 *   - The output is a MACHINE_PROPOSAL. It is not stored, and it is not owner-confirmed knowledge.
 *   - Truth beats quota: fewer than three genuinely different strategies are returned as they are.
 */

export type EvidenceAuthority = "OWNER_CONFIRMED" | "PUBLIC_APPROVED" | "DERIVED" | "CAPABILITY" | "CATALOG";

export type StrategyEvidence = {
  code: string;
  params: Record<string, string | number>;
  authority: EvidenceAuthority;
  weight: number;
  usedForDecision: true;
  allowedForPublication: boolean;
};

export type StrategyConversion =
  | { kind: "ACTION"; objective: string; channel: string; state: CapabilityState; source: "OWNER_SELECTED" | "RESOLVED_USABLE"; platformUnproven: boolean }
  | { kind: "SURFACE_ONLY"; reason: "NO_USABLE_CONVERSION_PATH" };

export type OfferingPick = {
  kind: "SERVICE" | "PRODUCT";
  id: number;
  /** The owner's own catalog name (publishable as catalog, as entered). */
  name: string;
  selectedBecause: ("OWNER_FEATURED" | "INTERNAL_DEMAND" | "MATCHES_EMPHASIS" | "ACTIVE")[];
  ownerFeatured: boolean;
  /** INTERNAL ordering input only. Never "most popular" / "best seller" wording. */
  internalDemandRank: number | null;
};

/** `required`: the first three sections carry the strategy and must have their data to publish; later
 *  sections are optional — a future composer omits them while `dataAvailable` is false. */
export type SectionPlan = { section: SectionCode; priority: number; required: boolean; dataAvailable: boolean; missing: string[] };
const REQUIRED_SECTIONS = 3;
export type AssetNeed = {
  kind: AssetNeedKind;
  essential: boolean;
  /** AVAILABLE = public-approved assets matched; UNCLASSIFIED_CANDIDATES = approved owner uploads exist but
   *  the role is not modelled (owner must tag later); MISSING = nothing usable. Never inferred. */
  availability: "AVAILABLE" | "UNCLASSIFIED_CANDIDATES" | "MISSING";
  assetIds: number[];
};

export type LandingStrategy = {
  id: string;
  strategyType: StrategyType;
  position: "RECOMMENDED" | "ALTERNATIVE";
  authority: "MACHINE_PROPOSAL";
  objective: string;
  visitorIntent: StrategyProfile["visitorIntent"];
  primaryConversion: StrategyConversion;
  secondaryConversion: StrategyConversion | null;
  ownerObjectiveAlignment: "OWNER_PRIMARY" | "OWNER_SECONDARY" | "NONE";
  offeringFocus: { emphasis: StrategyProfile["offeringEmphasis"]; primary: OfferingPick[]; supporting: OfferingPick[] };
  trustFocus: { emphasis: StrategyProfile["trustEmphasis"]; publicTrustClaimIds: number[]; providedByBusinessLabelRequired: boolean };
  narrativeApproach: StrategyProfile["narrativeApproach"];
  proofEmphasis: StrategyProfile["proofEmphasis"];
  recommendedSections: SectionPlan[];
  assetNeeds: AssetNeed[];
  evidence: StrategyEvidence[];
  reasons: string[];
  /** Owner-facing explanation of WHY this direction was proposed. Not marketing copy. */
  ownerExplanation: string;
  blockers: string[];
  missingInputs: string[];
  publicationConstraints: string[];
  /** Exactly what a future composer may publish for this strategy (ids into LandingBusinessContext.publishable). */
  publishable: { factKeys: string[]; statementIds: number[]; trustClaimIds: number[]; assetIds: number[]; offeringRefs: { kind: string; id: number }[] };
  publication: { ready: boolean; missing: string[] };
  support: "STRONG" | "MODERATE" | "WEAK";
  /** The fields a later AI composer may NOT change. */
  aiBoundary: { mayCompose: string[]; mustNotChange: string[] };
};

export type NotSelected = { strategyType: StrategyType; reason: "NOT_VIABLE" | "TOO_SIMILAR" | "LOWER_RANK"; blockers: string[]; similarTo?: StrategyType; distance?: number };

export type LandingStrategySet = {
  version: typeof STRATEGY_ENGINE_VERSION;
  contextVersion: string;
  businessId: number;
  generatedAt: string;
  authority: "MACHINE_PROPOSAL";
  decidedBy: "DETERMINISTIC_RULES";
  readiness: {
    strategy: { canGenerateStrategies: boolean; strategyReady: boolean; blockingReasons: string[]; degradedReasons: string[]; missingInputs: string[] };
    publication: { publishReady: boolean; blockingReasons: string[]; missingInputs: string[] };
  };
  strategies: LandingStrategy[];
  notSelected: NotSelected[];
  diversity: { minDistance: number; dimensions: readonly DiversityDimension[]; pairs: { a: StrategyType; b: StrategyType; distance: number; differsOn: DiversityDimension[] }[] };
  conflicts: { code: string; detail: string[] }[];
  missingInputs: string[];
};

const USABLE: CapabilityState[] = ["AVAILABLE", "AVAILABLE_UNOBSERVED"];
const TRUST_POSITIONING = ["EXPERTISE", "LOCAL_TRUST", "SPECIALIZATION", "PREMIUM", "PERSONAL_SERVICE"];

const AI_BOUNDARY = {
  mayCompose: ["narrative copy", "section content", "layout blueprint"],
  mustNotChange: ["strategyType", "primaryConversion", "secondaryConversion", "trustFocus", "publishable", "evidence", "publicationConstraints", "authority"],
};

type Candidate = Omit<LandingStrategy, "position" | "ownerExplanation" | "id"> & { score: number; evidenceScore: number; viable: boolean };

const pathRank = (p: ConversionPath) => (p.channel ? CHANNEL_PREFERENCE_ORDER.indexOf(p.channel) : 99);

/** The best path for an objective: the owner's own choice (even PLATFORM_UNPROVEN), else the best USABLE path. */
function conversionFor(ctx: LandingBusinessContext, objective: string): { conversion: StrategyConversion | null; blockers: string[] } {
  const conv = ctx.identity.conversion;
  const ownerPref = conv.preference.find((p) => p.objective === objective);
  if (ownerPref && ownerPref.resolvedChannel && ownerPref.state !== "UNRESOLVED" && (USABLE.includes(ownerPref.state) || ownerPref.state === "PLATFORM_UNPROVEN")) {
    return {
      conversion: { kind: "ACTION", objective, channel: ownerPref.resolvedChannel, state: ownerPref.state, source: "OWNER_SELECTED", platformUnproven: ownerPref.state === "PLATFORM_UNPROVEN" },
      blockers: [],
    };
  }
  const paths = conv.paths.filter((p) => p.objective === objective && p.terminal);
  const best = paths.filter((p) => USABLE.includes(p.state)).sort((a, b) => pathRank(a) - pathRank(b))[0];
  if (best) return { conversion: { kind: "ACTION", objective, channel: best.channel!, state: best.state, source: "RESOLVED_USABLE", platformUnproven: false }, blockers: [] };
  return { conversion: null, blockers: [...new Set(paths.flatMap((p) => p.blocking))].sort() };
}

/** The action a narrative strategy hands the visitor: the owner's effective primary, else the best usable path, else SURFACE_ONLY. */
function narrativeConversion(ctx: LandingBusinessContext, prefer: string[]): StrategyConversion {
  const conv = ctx.identity.conversion;
  if (typeof conv.effectivePrimary === "object" && conv.effectivePrimary.channel) {
    const own = conversionFor(ctx, conv.effectivePrimary.objective);
    if (own.conversion) return own.conversion;
  }
  for (const objective of [...prefer, ...conv.recommendations.map((r) => r.objective)]) {
    const c = conversionFor(ctx, objective);
    if (c.conversion && c.conversion.kind === "ACTION" && !c.conversion.platformUnproven) return c.conversion;
  }
  return { kind: "SURFACE_ONLY", reason: "NO_USABLE_CONVERSION_PATH" };
}

function pickOfferings(ctx: LandingBusinessContext, emphasis: StrategyProfile["offeringEmphasis"]): { primary: OfferingPick[]; supporting: OfferingPick[] } {
  const active = ctx.offerings.active.filter((o) => o.publiclyPresentable);
  const matches = (o: LandingOffering): boolean => {
    switch (emphasis) {
      case "QUOTED_SERVICES": return o.kind === "SERVICE" && o.priceMode === "QUOTE_REQUIRED";
      case "BOOKABLE_SERVICES": return o.kind === "SERVICE" && o.internalDemand.completedBookings > 0;
      case "SERVICES": return o.kind === "SERVICE";
      case "PRODUCTS": return o.kind === "PRODUCT";
      case "FEATURED": return o.ownerFeatured;
      case "ALL": return true;
    }
  };
  let pool = active.filter(matches);
  // A narrower emphasis with nothing in it falls back to the matching kind, never to invented items.
  if (!pool.length && (emphasis === "QUOTED_SERVICES" || emphasis === "BOOKABLE_SERVICES")) pool = active.filter((o) => o.kind === "SERVICE");
  if (!pool.length && emphasis === "FEATURED") pool = active;
  const demandOrder = [...active].filter((o) => o.internalDemand.signals > 0).sort((a, b) => b.internalDemand.signals - a.internalDemand.signals || a.kind.localeCompare(b.kind) || a.id - b.id);
  const rankOf = (o: LandingOffering) => { const i = demandOrder.findIndex((d) => d.kind === o.kind && d.id === o.id); return i < 0 ? null : i + 1; };
  const ordered = [...pool].sort((a, b) =>
    Number(b.ownerFeatured) - Number(a.ownerFeatured) || b.internalDemand.signals - a.internalDemand.signals || a.kind.localeCompare(b.kind) || a.id - b.id);
  const pick = (o: LandingOffering): OfferingPick => ({
    kind: o.kind,
    id: o.id,
    name: o.name,
    ownerFeatured: o.ownerFeatured,
    internalDemandRank: rankOf(o),
    selectedBecause: [
      ...(o.ownerFeatured ? ["OWNER_FEATURED" as const] : []),
      ...(o.internalDemand.signals > 0 ? ["INTERNAL_DEMAND" as const] : []),
      ...(matches(o) && emphasis !== "ALL" ? ["MATCHES_EMPHASIS" as const] : []),
      "ACTIVE" as const,
    ],
  });
  return { primary: ordered.slice(0, 3).map(pick), supporting: ordered.slice(3, 8).map(pick) };
}

function sectionPlan(ctx: LandingBusinessContext, sections: SectionCode[], conversion: StrategyConversion): SectionPlan[] {
  const pub = ctx.publishable;
  const fact = (k: string) => pub.facts.some((f) => f.key === k);
  const statement = (d: string) => pub.statements.some((s) => s.dimension === d);
  const need = (section: SectionCode): string[] => {
    switch (section) {
      case "HERO": return fact("BUSINESS_NAME") ? [] : ["PUBLIC_BUSINESS_NAME"];
      case "PRIMARY_ACTION":
      case "CONTACT_PANEL": return conversion.kind === "ACTION" ? [] : ["USABLE_CONVERSION_PATH"];
      case "LOCATION_AND_HOURS": return [...(fact("PUBLIC_ADDRESS") ? [] : ["PUBLIC_ADDRESS"]), ...(fact("OPENING_HOURS") ? [] : ["PUBLIC_OPENING_HOURS"])];
      case "SERVICES_OVERVIEW": return ctx.offerings.counts.activeServices ? [] : ["ACTIVE_SERVICES"];
      case "PRODUCTS_SHOWCASE": return ctx.offerings.counts.activeProducts ? [] : ["ACTIVE_PRODUCTS"];
      case "FEATURED_OFFERINGS": return ctx.offerings.counts.featured ? [] : ["OWNER_FEATURED_OFFERINGS"];
      case "TRUST_PROOF": return pub.trustClaims.length ? [] : ["PUBLIC_TRUST_CLAIM"];
      case "ABOUT": return statement("DESCRIPTION") ? [] : ["PUBLIC_DESCRIPTION"];
      case "SERVICE_AREA": return statement("SERVICE_AREA") ? [] : ["PUBLIC_SERVICE_AREA"];
      case "QUOTE_PROCESS":
      case "BOOKING_INFO": return [];
    }
  };
  return sections.map((section, i) => { const missing = need(section); return { section, priority: i + 1, required: i < REQUIRED_SECTIONS, dataAvailable: missing.length === 0, missing }; });
}

function assetPlan(ctx: LandingBusinessContext, needs: StrategyProfile["assetNeeds"], offeringRefs: { kind: string; id: number }[]): AssetNeed[] {
  const approved = ctx.assets.publicApproved;
  return needs.map(({ kind, essential }) => {
    if (kind === "OFFERING_IMAGE") {
      const ids = approved.filter((a) => a.role === "OFFERING_IMAGE" && a.linkedOfferings.some((l) => offeringRefs.some((r) => r.kind === l.kind && r.id === l.id))).map((a) => a.id);
      return { kind, essential, availability: ids.length ? "AVAILABLE" : "MISSING", assetIds: ids };
    }
    // Roles are not modelled: a real owner upload MAY fit, but it is never assigned automatically, and a
    // generated image is never a candidate for a person, a place or a result.
    const candidates = approved.filter((a) => a.origin === "OWNER_UPLOAD" && a.role === "UNCLASSIFIED").map((a) => a.id);
    return { kind, essential, availability: candidates.length ? "UNCLASSIFIED_CANDIDATES" : "MISSING", assetIds: [] };
  });
}

function buildCandidate(ctx: LandingBusinessContext, type: StrategyType): Candidate {
  const profile = STRATEGY_PROFILES[type];
  const sig = (s: string) => ctx.supportedSignals.includes(s);
  const declared = (d: string) => ctx.owner.declarations.includes(d);
  const evidence: StrategyEvidence[] = [];
  const add = (code: string, weight: number, authority: EvidenceAuthority, allowedForPublication: boolean, params: Record<string, string | number> = {}) =>
    evidence.push({ code, params, authority, weight, usedForDecision: true, allowedForPublication });
  const blockers: string[] = [];
  const publicClaims = ctx.publishable.trustClaims;

  // ── owner authority ──
  const ownerPrimary = ctx.owner.primaryObjective?.code === profile.objective;
  const ownerSecondary = ctx.owner.secondaryObjectives.some((o) => o.code === profile.objective);
  if (ownerPrimary) add("OWNER_PRIMARY_OBJECTIVE", 100, "OWNER_CONFIRMED", false, { objective: profile.objective });
  else if (ownerSecondary) add("OWNER_SECONDARY_OBJECTIVE", 40, "OWNER_CONFIRMED", false, { objective: profile.objective });

  // ── conversion + viability ──
  let primaryConversion: StrategyConversion;
  let secondaryConversion: StrategyConversion | null = null;
  if (profile.family === "CONVERSION") {
    const c = conversionFor(ctx, profile.objective);
    if (!c.conversion) {
      blockers.push("NO_USABLE_PATH_FOR_OBJECTIVE", ...c.blockers);
      primaryConversion = { kind: "SURFACE_ONLY", reason: "NO_USABLE_CONVERSION_PATH" };
    } else {
      primaryConversion = c.conversion;
      if (c.conversion.kind === "ACTION") {
        add("USABLE_PATH", c.conversion.state === "AVAILABLE" ? 5 : 0, "CAPABILITY", false, { objective: profile.objective, channel: c.conversion.channel, state: c.conversion.state });
        // PLATFORM_UNPROVEN carries a strategy only because the owner chose it (conversionFor guarantees it).
        if (c.conversion.platformUnproven) add("OWNER_SELECTED_PLATFORM_UNPROVEN_CHANNEL", 0, "OWNER_CONFIRMED", false, { channel: c.conversion.channel });
      }
    }
  } else {
    primaryConversion = narrativeConversion(ctx, type === "PRODUCT_DISCOVERY_FIRST" ? ["VISIT_STORE"] : []);
    if (primaryConversion.kind === "SURFACE_ONLY") add("SURFACE_ONLY_NO_CTA", -10, "CAPABILITY", false);
    if (type === "PRODUCT_DISCOVERY_FIRST") {
      const buy = conversionFor(ctx, "BUY");
      if (buy.conversion && buy.conversion.kind === "ACTION" && buy.conversion.channel === "IN_PERSON") secondaryConversion = buy.conversion;
    }
  }

  // ── evidence per type ──
  switch (type) {
    case "REQUEST_QUOTE_FIRST":
      if (sig("QUOTE_PRICING")) add("QUOTE_PRICING_SUPPORTED", 30, "DERIVED", false, { quoteRequired: ctx.offerings.counts.quoteRequired });
      if (declared("QUOTES_ON_REQUEST")) add("DECLARED_QUOTES_ON_REQUEST", 5, "OWNER_CONFIRMED", false);
      if (sig("FULFILLMENT_MODE:AT_CUSTOMER")) add("SERVICES_AT_CUSTOMER", 10, "DERIVED", false);
      break;
    case "BOOKING_FIRST":
      if (sig("BOOKING_DEMAND")) add("COMPLETED_BOOKINGS_SUPPORTED", 30, "DERIVED", false, { completedBookings: ctx.demand.completedBookings });
      if (ctx.owner.audience.includes("APPOINTMENT_CUSTOMERS")) add("AUDIENCE_APPOINTMENT_CUSTOMERS", 10, "OWNER_CONFIRMED", false);
      if (declared("BOOKING_BY_MESSAGE")) add("DECLARED_BOOKING_BY_MESSAGE", 5, "OWNER_CONFIRMED", false);
      break;
    case "CALL_FIRST":
      if (sig("FULFILLMENT_MODE:AT_CUSTOMER")) add("SERVICES_AT_CUSTOMER", 10, "DERIVED", false);
      if (ctx.identity.conversion.recommendations.some((r) => r.objective === "CALL")) add("RESOLVER_SUGGESTS_CALL", 10, "DERIVED", false);
      break;
    case "WHATSAPP_FIRST":
      if (declared("WHATSAPP_ON_PUBLIC_PHONE")) add("DECLARED_WHATSAPP_ON_PUBLIC_PHONE", 5, "OWNER_CONFIRMED", false);
      if (ctx.identity.conversion.recommendations.some((r) => r.objective === "WHATSAPP")) add("RESOLVER_SUGGESTS_WHATSAPP", 10, "DERIVED", false);
      break;
    case "LEAD_CAPTURE_FIRST":
      if (primaryConversion.kind === "ACTION" && primaryConversion.channel === "DUBIZ_FORM") add("WEBSITE_FORM_LIVE", 15, "CAPABILITY", false);
      if (ctx.owner.audience.includes("BUSINESSES")) add("AUDIENCE_BUSINESSES", 10, "OWNER_CONFIRMED", false);
      break;
    case "LOCAL_VISIT_FIRST":
      if (declared("ACCEPTS_VISITS")) add("DECLARED_ACCEPTS_VISITS", 20, "OWNER_CONFIRMED", false);
      if (sig("FULFILLMENT_MODE:AT_BUSINESS")) add("SERVICES_AT_BUSINESS", 10, "DERIVED", false);
      if (ctx.owner.audience.some((a) => a === "LOCAL_CUSTOMERS" || a === "WALK_IN_CUSTOMERS")) add("AUDIENCE_LOCAL_OR_WALK_IN", 10, "OWNER_CONFIRMED", false);
      break;
    case "TRUST_AUTHORITY_FIRST": {
      // Only PUBLIC-EFFECTIVE trust counts. Owner-asserted-but-unapproved, undocumented licences, CRM
      // counts and claim-like text never make this strategy (they are not in `publishable`).
      if (!publicClaims.length) blockers.push("NO_PUBLIC_EFFECTIVE_TRUST_CLAIM");
      else add("PUBLIC_TRUST_CLAIMS", Math.min(publicClaims.length, 3) * 15, "PUBLIC_APPROVED", true, { count: publicClaims.length });
      const positioning = ctx.owner.positioning.filter((p) => TRUST_POSITIONING.includes(p));
      if (positioning.length && publicClaims.length) add("TRUST_POSITIONING", 10, "OWNER_CONFIRMED", false, { codes: positioning.join(",") });
      if (ctx.publishable.facts.some((f) => f.key === "PUBLIC_ADDRESS")) add("PUBLIC_ADDRESS_APPROVED", 5, "PUBLIC_APPROVED", true);
      break;
    }
    case "SERVICE_DISCOVERY_FIRST": {
      const n = ctx.offerings.counts.activeServices;
      if (n < 3) blockers.push("FEWER_THAN_3_ACTIVE_SERVICES");
      else add("ACTIVE_SERVICES", n >= 6 ? 20 : 10, "CATALOG", true, { activeServices: n });
      if (n >= 3 && sig("CATEGORY_BREADTH:BROAD")) add("BROAD_CATEGORIES", 10, "DERIVED", false);
      if (n >= 3 && ctx.offerings.mix === "SERVICE_LED") add("SERVICE_LED_MIX", 10, "DERIVED", false);
      if (n >= 3 && ctx.offerings.active.some((o) => o.kind === "SERVICE" && o.ownerFeatured)) add("OWNER_FEATURED_SERVICES", 5, "OWNER_CONFIRMED", true);
      break;
    }
    case "PRODUCT_DISCOVERY_FIRST": {
      const n = ctx.offerings.counts.activeProducts;
      if (n < 3) blockers.push("FEWER_THAN_3_ACTIVE_PRODUCTS");
      else add("ACTIVE_PRODUCTS", n >= 6 ? 20 : 10, "CATALOG", true, { activeProducts: n });
      if (n >= 3 && ctx.offerings.mix === "PRODUCT_LED") add("PRODUCT_LED_MIX", 15, "DERIVED", false);
      if (n >= 3 && ctx.offerings.active.some((o) => o.kind === "PRODUCT" && o.ownerFeatured)) add("OWNER_FEATURED_PRODUCTS", 5, "OWNER_CONFIRMED", true);
      break;
    }
  }

  // ── focus, sections, assets ──
  const offeringFocus = { emphasis: profile.offeringEmphasis, ...pickOfferings(ctx, profile.offeringEmphasis) };
  if (offeringFocus.primary.some((o) => o.internalDemandRank !== null)) add("INTERNAL_DEMAND_ORDERS_OFFERINGS", 0, "DERIVED", false);
  const offeringRefs = [...offeringFocus.primary, ...offeringFocus.supporting].map((o) => ({ kind: o.kind, id: o.id }));
  const recommendedSections = sectionPlan(ctx, profile.sections, primaryConversion);
  const assetNeeds = assetPlan(ctx, profile.assetNeeds, offeringRefs);
  const verificationLabel = publicClaims.some((c) => c.label === "PROVIDED_BY_BUSINESS");

  const evidenceScore = evidence.filter((e) => e.code !== "OWNER_PRIMARY_OBJECTIVE" && e.code !== "OWNER_SECONDARY_OBJECTIVE").reduce((s, e) => s + e.weight, 0);
  const score = evidence.reduce((s, e) => s + e.weight, 0);
  const viable = blockers.length === 0;

  const missingInputs = [...new Set([
    ...recommendedSections.flatMap((s) => s.missing),
    ...assetNeeds.filter((a) => a.availability !== "AVAILABLE").map((a) => `ASSET:${a.kind}`),
  ])].sort();
  const publicationMissing = [...new Set([
    ...(primaryConversion.kind === "SURFACE_ONLY" ? ["USABLE_CONVERSION_PATH"] : []),
    ...(ctx.publishable.facts.some((f) => f.key === "BUSINESS_NAME") ? [] : ["PUBLIC_BUSINESS_NAME"]),
    ...(ctx.publishable.statements.some((s) => s.dimension === "DESCRIPTION") ? [] : ["PUBLIC_DESCRIPTION"]),
    ...assetNeeds.filter((a) => a.essential && a.availability !== "AVAILABLE").map((a) => `ASSET:${a.kind}`),
    ...(ctx.identity.readiness.hasBlockingConflicts ? ["RESOLVE_BLOCKING_CONFLICTS"] : []),
    ...recommendedSections.filter((s) => s.required).flatMap((s) => s.missing),
  ])].sort();

  const publicationConstraints = [
    primaryConversion.kind === "ACTION" ? "CTA_ONLY_FROM_PRIMARY_CONVERSION" : "NO_CTA_SURFACE_ONLY",
    "TRUST_ONLY_PUBLIC_EFFECTIVE_CLAIMS",
    ...(verificationLabel ? ["LABEL_PROVIDED_BY_BUSINESS"] : []),
    "NO_DEMAND_OR_POPULARITY_WORDING",
    "NO_TESTIMONIALS_REVIEWS_OR_RATINGS",
    "NO_CUSTOMER_COUNTS_EXCEPT_APPROVED_CLAIM",
    "OFFERINGS_AS_OWNER_CATALOG_ONLY",
    "ASSETS_PUBLIC_APPROVED_ONLY",
    "NO_INFERRED_PEOPLE_OR_PLACE_IMAGES",
    ...(ctx.identity.trust.claimLikeStatements.some((c) => c.publicUseApproved) ? ["CLAIM_LIKE_TEXT_EXCLUDED_UNTIL_OWNER_REVIEW"] : []),
    ...(primaryConversion.kind === "ACTION" && primaryConversion.platformUnproven ? ["CHANNEL_PLATFORM_UNPROVEN_OWNER_SELECTED"] : []),
  ];

  return {
    strategyType: type,
    authority: "MACHINE_PROPOSAL",
    objective: profile.objective,
    visitorIntent: profile.visitorIntent,
    primaryConversion,
    secondaryConversion,
    ownerObjectiveAlignment: ownerPrimary ? "OWNER_PRIMARY" : ownerSecondary ? "OWNER_SECONDARY" : "NONE",
    offeringFocus,
    trustFocus: { emphasis: profile.trustEmphasis, publicTrustClaimIds: publicClaims.map((c) => c.id), providedByBusinessLabelRequired: verificationLabel },
    narrativeApproach: profile.narrativeApproach,
    proofEmphasis: profile.proofEmphasis,
    recommendedSections,
    assetNeeds,
    evidence,
    reasons: evidence.filter((e) => e.weight > 0 || e.code === "OWNER_SELECTED_PLATFORM_UNPROVEN_CHANNEL").map((e) => e.code),
    blockers,
    missingInputs,
    publicationConstraints,
    publishable: {
      factKeys: ctx.publishable.facts.map((f) => f.key),
      statementIds: ctx.publishable.statements.map((s) => s.id),
      trustClaimIds: publicClaims.map((c) => c.id),
      assetIds: [...new Set(assetNeeds.flatMap((a) => a.assetIds))].sort((a, b) => a - b),
      offeringRefs,
    },
    publication: { ready: publicationMissing.length === 0, missing: publicationMissing },
    support: evidenceScore >= 30 ? "STRONG" : evidenceScore >= 10 ? "MODERATE" : "WEAK",
    aiBoundary: AI_BOUNDARY,
    score,
    evidenceScore,
    viable,
  };
}

/** The 8-dimension signature diversity is measured on. */
export function diversitySignature(s: Pick<LandingStrategy, "primaryConversion" | "visitorIntent" | "offeringFocus" | "trustFocus" | "narrativeApproach" | "recommendedSections" | "proofEmphasis" | "objective">): Record<DiversityDimension, string> {
  const conv = s.primaryConversion;
  return {
    primaryObjective: conv.kind === "ACTION" ? conv.objective : `SURFACE:${s.objective}`,
    conversionChannel: conv.kind === "ACTION" ? conv.channel : "NONE",
    visitorIntent: s.visitorIntent,
    offeringEmphasis: s.offeringFocus.emphasis,
    trustEmphasis: s.trustFocus.emphasis,
    narrativeApproach: s.narrativeApproach,
    leadSection: s.recommendedSections.find((x) => x.section !== "HERO")?.section ?? "HERO",
    proofEmphasis: s.proofEmphasis,
  };
}

export function diversityDistance(a: Parameters<typeof diversitySignature>[0], b: Parameters<typeof diversitySignature>[0]): { distance: number; differsOn: DiversityDimension[] } {
  const sa = diversitySignature(a);
  const sb = diversitySignature(b);
  const differsOn = DIVERSITY_DIMENSIONS.filter((d) => sa[d] !== sb[d]);
  return { distance: differsOn.length, differsOn };
}

/**
 * Greedy, order-preserving diversity filter: walk the candidates in priority order and keep one only
 * if it differs from EVERY kept strategy on at least MIN_DIVERSITY_DISTANCE dimensions. Exported for tests.
 */
export function selectDiverse<T extends Parameters<typeof diversitySignature>[0] & { strategyType: StrategyType }>(ordered: T[], max = MAX_STRATEGIES) {
  const kept: T[] = [];
  const rejected: { candidate: T; reason: "TOO_SIMILAR" | "LOWER_RANK"; similarTo?: StrategyType; distance?: number }[] = [];
  for (const c of ordered) {
    const closest = kept.map((k) => ({ k, d: diversityDistance(c, k).distance })).sort((x, y) => x.d - y.d)[0];
    if (closest && closest.d < MIN_DIVERSITY_DISTANCE) rejected.push({ candidate: c, reason: "TOO_SIMILAR", similarTo: closest.k.strategyType, distance: closest.d });
    else if (kept.length >= max) rejected.push({ candidate: c, reason: "LOWER_RANK" });
    else kept.push(c);
  }
  return { kept, rejected };
}

const typeIndex = (t: StrategyType) => STRATEGY_TYPES.indexOf(t);

/** Pure: the strategy set for a landing context. Same context + same engine version → same output. */
export function buildLandingStrategySet(ctx: LandingBusinessContext): LandingStrategySet {
  const candidates = STRATEGY_TYPES.map((t) => buildCandidate(ctx, t));
  const viable = candidates.filter((c) => c.viable);
  const byScore = [...viable].sort((a, b) => b.score - a.score || typeIndex(a.strategyType) - typeIndex(b.strategyType));
  const conflicts: LandingStrategySet["conflicts"] = [...ctx.conflicts];

  // Owner authority: the owner's primary objective, when servable, leads. When it is not, it is surfaced.
  const ownerObjective = ctx.owner.primaryObjective?.code ?? null;
  const ownerCandidate = ownerObjective ? candidates.find((c) => c.objective === ownerObjective) ?? null : null;
  if (ownerObjective && ownerCandidate && !ownerCandidate.viable) {
    conflicts.push({ code: "OWNER_OBJECTIVE_NOT_FULFILLABLE", detail: [ownerObjective, ...ownerCandidate.blockers] });
  }
  if (ownerObjective === "BUY") conflicts.push({ code: "OWNER_OBJECTIVE_NO_STRATEGY_IN_V1", detail: ["BUY", "PRODUCT_PURCHASE_FIRST excluded: no checkout / shop-link authority"] });
  const ownerLeads = ownerCandidate?.viable ? ownerCandidate : null;
  if (ownerLeads?.primaryConversion.kind === "ACTION" && ownerLeads.primaryConversion.platformUnproven) {
    conflicts.push({ code: "OWNER_SELECTED_PLATFORM_UNPROVEN", detail: [ownerLeads.objective, ownerLeads.primaryConversion.channel] });
  }

  // Evidence divergence: the strongest strategy WITHOUT owner weight, when it is not the owner's.
  const evidenceLeader = [...viable].sort((a, b) => b.evidenceScore - a.evidenceScore || typeIndex(a.strategyType) - typeIndex(b.strategyType))[0] ?? null;
  const divergent = ownerLeads && evidenceLeader && evidenceLeader.strategyType !== ownerLeads.strategyType && evidenceLeader.evidenceScore >= 30 && evidenceLeader.evidenceScore > ownerLeads.evidenceScore
    ? evidenceLeader : null;
  if (divergent) conflicts.push({ code: "OWNER_EVIDENCE_DIVERGENCE", detail: [`owner:${ownerLeads!.strategyType}`, `evidence:${divergent.strategyType}`, ...divergent.reasons] });

  const priority = [
    ...(ownerLeads ? [ownerLeads] : []),
    ...(divergent ? [divergent] : []),
    ...byScore.filter((c) => c !== ownerLeads && c !== divergent),
  ];
  const { kept, rejected } = selectDiverse(priority);
  // Alternatives after the recommended one are ordered by score (the divergent one keeps its place: it was chosen to be shown).
  const strategies: LandingStrategy[] = kept.map((c, i) => {
    const { score: _s, evidenceScore: _e, viable: _v, ...rest } = c;
    void _s; void _e; void _v;
    const conv = rest.primaryConversion;
    const strategy: LandingStrategy = {
      ...rest,
      id: `${STRATEGY_ENGINE_VERSION}:${rest.strategyType}:${conv.kind === "ACTION" ? `${conv.objective}:${conv.channel}` : "SURFACE_ONLY"}`,
      position: i === 0 ? "RECOMMENDED" : "ALTERNATIVE",
      ownerExplanation: "",
    };
    strategy.ownerExplanation = explainStrategy(strategy, ctx);
    return strategy;
  });

  const notSelected: NotSelected[] = [
    ...candidates.filter((c) => !c.viable).map((c) => ({ strategyType: c.strategyType, reason: "NOT_VIABLE" as const, blockers: c.blockers })),
    ...rejected.map((r) => ({ strategyType: r.candidate.strategyType, reason: r.reason, blockers: [], ...(r.similarTo ? { similarTo: r.similarTo, distance: r.distance } : {}) })),
  ].sort((a, b) => typeIndex(a.strategyType) - typeIndex(b.strategyType));

  const pairs = strategies.flatMap((a, i) => strategies.slice(i + 1).map((b) => ({ a: a.strategyType, b: b.strategyType, ...diversityDistance(a, b) })));

  // ── readiness: choosing a strategy ≠ publishing a page ──
  const anyAction = strategies.some((s) => s.primaryConversion.kind === "ACTION");
  const strategyBlocking = strategies.length ? [] : ["NO_VIABLE_STRATEGY", ...(ctx.offerings.counts.activeServices + ctx.offerings.counts.activeProducts === 0 ? ["NO_ACTIVE_OFFERINGS"] : []), ...(ctx.identity.conversion.fallback === "SURFACE_ONLY" ? ["NO_USABLE_CONVERSION_PATH"] : [])];
  const degraded = [
    ...(ctx.identity.conversion.fallback === "SURFACE_ONLY" ? ["SURFACE_ONLY_NO_USABLE_CONVERSION"] : []),
    ...(ownerObjective ? [] : ["OWNER_PRIMARY_OBJECTIVE_UNSET"]),
    ...(ownerObjective && !ownerLeads ? ["OWNER_OBJECTIVE_NOT_FULFILLABLE"] : []),
    ...(ctx.publishable.trustClaims.length ? [] : ["NO_PUBLIC_TRUST_CLAIM"]),
    ...(ctx.publishable.assetIds.length ? [] : ["NO_PUBLIC_APPROVED_ASSETS"]),
    ...(strategies.length > 0 && strategies.length < MAX_STRATEGIES ? ["FEWER_THAN_3_DISTINCT_STRATEGIES"] : []),
  ];
  const recommended = strategies[0] ?? null;
  const publicationBlocking = [
    ...(recommended ? [] : ["NO_STRATEGY"]),
    ...(anyAction ? [] : ["NO_USABLE_CONVERSION_PATH"]),
    ...(ctx.identity.readiness.hasBlockingConflicts ? ["BLOCKING_CONFLICTS"] : []),
  ];
  const publicationMissing = recommended ? recommended.publication.missing : ctx.missingInputs;

  return {
    version: STRATEGY_ENGINE_VERSION,
    contextVersion: ctx.version,
    businessId: ctx.businessId,
    generatedAt: ctx.generatedAt,
    authority: "MACHINE_PROPOSAL",
    decidedBy: "DETERMINISTIC_RULES",
    readiness: {
      strategy: {
        canGenerateStrategies: strategies.length > 0,
        strategyReady: strategies.some((s) => s.support !== "WEAK"),
        blockingReasons: strategyBlocking,
        degradedReasons: degraded,
        missingInputs: [...new Set([...(ownerObjective ? [] : ["PRIMARY_OBJECTIVE"]), ...(ctx.offerings.counts.activeServices + ctx.offerings.counts.activeProducts ? [] : ["ACTIVE_OFFERINGS"])])],
      },
      publication: { publishReady: publicationBlocking.length === 0 && publicationMissing.length === 0, blockingReasons: publicationBlocking, missingInputs: publicationMissing },
    },
    strategies,
    notSelected,
    diversity: { minDistance: MIN_DIVERSITY_DISTANCE, dimensions: DIVERSITY_DIMENSIONS, pairs },
    conflicts,
    missingInputs: ctx.missingInputs,
  };
}
