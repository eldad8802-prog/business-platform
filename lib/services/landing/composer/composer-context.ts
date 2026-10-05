import type { LandingBusinessContext } from "../landing-business-context";
import type { LandingStrategy } from "../landing-strategy-engine";
import type { SectionCode } from "../landing-strategy-vocabulary";

/**
 * P3-C · LandingComposerContext — the ONLY material the AI composer ever sees.
 *
 * It is a projection of (LandingBusinessContext × one server-recomputed LandingStrategy) restricted to
 * what that strategy is allowed to PUBLISH: approved facts, approved statements that are not awaiting
 * claim review, public-effective trust claims, the strategy's selected offerings (owner catalog) and
 * public-approved assets. Every item carries an opaque ref ("offering:SERVICE:12", "trust:5", …) — the
 * model may only point at refs from this list; the validator rejects anything else.
 *
 * Deliberately ABSENT: internal demand counts / ranks, owner-only directives, unapproved facts or
 * statements, claim-like text awaiting review, trust parameters / evidence / documents / storage keys,
 * customer or lead data, other tenants' anything. Authority values are not here either: the model is
 * never asked to state what is public, verified or available — deterministic code decides and the
 * final blueprint copies those values in AFTER generation.
 */

export const COMPOSER_CONTEXT_VERSION = "p3c.composer-context.v1";

export type ComposerFact = { ref: string; key: string; value: string };
export type ComposerStatement = { ref: string; dimension: string; text: string };
export type ComposerTrustClaim = { ref: string; kind: string; wording: string; providedByBusiness: boolean };
export type ComposerOffering = {
  ref: string;
  kind: "SERVICE" | "PRODUCT";
  name: string;
  description: string | null;
  category: string | null;
  /** Owner-entered price, already formatted; rendered verbatim by code, never re-stated by the model. */
  priceText: string | null;
  fulfillment: string | null;
  ownerFeatured: boolean;
  assetRefs: string[];
};
export type ComposerAsset = { ref: string; role: "OFFERING_IMAGE" | "UNCLASSIFIED"; origin: "OWNER_UPLOAD" | "GENERATED"; offeringRefs: string[] };

export type LandingComposerContext = {
  version: typeof COMPOSER_CONTEXT_VERSION;
  language: "he";
  strategy: {
    id: string;
    type: string;
    objective: string;
    visitorIntent: string;
    narrativeApproach: string;
    proofEmphasis: string;
    trustEmphasis: string;
    /** The sections the page may contain, in order. Only sections with data are composable. */
    sections: { section: SectionCode; required: boolean; composable: boolean }[];
    /** What the visitor can do. The model writes a label at most; it never chooses the channel. */
    primaryAction: { kind: "ACTION"; objective: string; channel: string } | { kind: "NONE" };
    secondaryAction: { kind: "ACTION"; objective: string; channel: string } | { kind: "NONE" };
    publicationConstraints: string[];
  };
  businessName: string | null;
  facts: ComposerFact[];
  statements: ComposerStatement[];
  trustClaims: ComposerTrustClaim[];
  offerings: ComposerOffering[];
  assets: ComposerAsset[];
};

export const offeringRef = (kind: string, id: number) => `offering:${kind}:${id}`;
export const trustRef = (id: number) => `trust:${id}`;
export const assetRef = (id: number) => `asset:${id}`;
export const factRef = (key: string) => `fact:${key}`;
export const statementRef = (id: number) => `statement:${id}`;

function priceText(priceMode: string | null, amount: string | null, max: string | null): string | null {
  const n = (v: string | null) => (v === null ? null : Number(v).toLocaleString("he-IL", { maximumFractionDigits: 2 }));
  switch (priceMode) {
    case "FIXED": return amount !== null ? `₪${n(amount)}` : null;
    case "FROM": return amount !== null ? `החל מ-₪${n(amount)}` : null;
    case "RANGE": return amount !== null && max !== null ? `₪${n(amount)}–₪${n(max)}` : null;
    case "QUOTE_REQUIRED": return "לפי הצעת מחיר";
    default: return null; // NO_PUBLIC_PRICE / unknown: nothing is said about price
  }
}

/** Pure. Everything here is already authorised by P2 / P3-A / P3-B; nothing is re-decided. */
export function buildComposerContext(ctx: LandingBusinessContext, strategy: LandingStrategy): LandingComposerContext {
  const pub = strategy.publishable;
  const facts = ctx.publishable.facts.filter((f) => pub.factKeys.includes(f.key)).map((f) => ({ ref: factRef(f.key), key: f.key, value: f.value }));
  const statements = ctx.publishable.statements.filter((s) => pub.statementIds.includes(s.id)).map((s) => ({ ref: statementRef(s.id), dimension: s.dimension, text: s.text }));
  const trustClaims = ctx.publishable.trustClaims.filter((c) => pub.trustClaimIds.includes(c.id)).map((c) => ({ ref: trustRef(c.id), kind: c.kind, wording: c.wording, providedByBusiness: c.label === "PROVIDED_BY_BUSINESS" }));
  const allowedAssetIds = new Set([...pub.assetIds, ...ctx.offerings.active.filter((o) => pub.offeringRefs.some((r) => r.kind === o.kind && r.id === o.id)).flatMap((o) => o.publicAssetIds)]);
  const assets = ctx.assets.publicApproved.filter((a) => allowedAssetIds.has(a.id)).map((a) => ({
    ref: assetRef(a.id), role: a.role, origin: a.origin, offeringRefs: a.linkedOfferings.map((l) => offeringRef(l.kind, l.id)),
  }));
  const offerings = pub.offeringRefs
    .map((r) => ctx.offerings.active.find((o) => o.kind === r.kind && o.id === r.id))
    .filter((o): o is NonNullable<typeof o> => !!o && o.publiclyPresentable)
    .map((o) => ({
      ref: offeringRef(o.kind, o.id), kind: o.kind, name: o.name, description: o.description, category: o.category,
      priceText: priceText(o.priceMode, o.priceAmount, o.priceMax), fulfillment: o.fulfillment, ownerFeatured: o.ownerFeatured,
      assetRefs: o.publicAssetIds.filter((id) => allowedAssetIds.has(id)).map(assetRef),
    }));
  const action = (c: LandingStrategy["primaryConversion"] | null) =>
    c && c.kind === "ACTION" ? { kind: "ACTION" as const, objective: c.objective, channel: c.channel } : { kind: "NONE" as const };
  return {
    version: COMPOSER_CONTEXT_VERSION,
    language: "he",
    strategy: {
      id: strategy.id,
      type: strategy.strategyType,
      objective: strategy.objective,
      visitorIntent: strategy.visitorIntent,
      narrativeApproach: strategy.narrativeApproach,
      proofEmphasis: strategy.proofEmphasis,
      trustEmphasis: strategy.trustFocus.emphasis,
      sections: strategy.recommendedSections.map((s) => ({ section: s.section, required: s.required, composable: s.dataAvailable })),
      primaryAction: action(strategy.primaryConversion),
      secondaryAction: action(strategy.secondaryConversion),
      publicationConstraints: [...strategy.publicationConstraints],
    },
    businessName: facts.find((f) => f.key === "BUSINESS_NAME")?.value ?? null,
    facts,
    statements,
    trustClaims,
    offerings,
    assets,
  };
}
