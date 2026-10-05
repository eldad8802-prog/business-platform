import type { LandingStrategy } from "../landing-strategy-engine";
import { BLUEPRINT_VERSION, type ComposerDraft } from "./blueprint-schema";
import type { LandingComposerContext } from "./composer-context";

/**
 * P3-C · Deterministic assembly of the final LandingBlueprint from a VALIDATED draft.
 *
 * The model contributed copy and refs. Everything with authority is copied in here by code:
 *   actions   ← LandingStrategy.primaryConversion / secondaryConversion (objective, channel, state)
 *   trust     ← canonical public-effective claim wording + the "provided by the business" label
 *   facts     ← approved fact values;   statements ← approved statement text (verbatim)
 *   offerings ← owner catalog name / description / formatted owner price
 *   assets    ← approved asset metadata; a missing role is reported, never filled
 * Sections are ordered by the strategy's own priority, not by the model.
 */

export type BlueprintAction = {
  label: string;
  objective: string;
  channel: string;
  state: string;
  source: "OWNER_SELECTED" | "RESOLVED_USABLE";
  platformUnproven: boolean;
};

export type BlueprintAssetRef = { ref: string; origin: "OWNER_UPLOAD" | "GENERATED"; illustrativeOnly: boolean };

export type BlueprintSection = {
  sectionType: string;
  priority: number;
  heading: string;
  body?: string;
  intro?: string;
  steps?: string[];
  offerings?: { ref: string; kind: string; name: string; description: string | null; priceText: string | null; blurb: string; assets: BlueprintAssetRef[] }[];
  trustClaims?: { ref: string; kind: string; wording: string; providedByBusiness: boolean }[];
  facts?: { ref: string; key: string; value: string }[];
  statements?: { ref: string; dimension: string; text: string }[];
  action?: BlueprintAction | null;
};

export type LandingBlueprint = {
  version: typeof BLUEPRINT_VERSION;
  composerVersion: string;
  promptVersion: string;
  composerContextVersion: string;
  strategyEngineVersion: string;
  businessId: number;
  strategyId: string;
  strategyType: string;
  authority: "MACHINE_PROPOSAL";
  pageIntent: string;
  metadata: { title: string; description: string; language: "he" };
  hero: { headline: string; subheadline: string; asset: BlueprintAssetRef | null; missingAsset: string | null; action: BlueprintAction | null };
  sections: BlueprintSection[];
  primaryAction: BlueprintAction | null;
  secondaryAction: BlueprintAction | null;
  /** Informational navigation is never an action; SURFACE_ONLY pages have none of the above actions. */
  surfaceOnly: boolean;
  offeringRefs: string[];
  trustClaimRefs: string[];
  assetRefs: string[];
  factRefs: string[];
  statementRefs: string[];
  missingAssets: string[];
  publicationConstraints: string[];
  authorityRefs: Record<string, string>;
  readiness: { publishReady: boolean; missingForPublication: string[]; warnings: string[] };
};

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

export function assembleBlueprint(input: {
  businessId: number;
  ctx: LandingComposerContext;
  strategy: LandingStrategy;
  draft: ComposerDraft;
  meta: { composerVersion: string; promptVersion: string; composerContextVersion: string; strategyEngineVersion: string };
}): LandingBlueprint {
  const { ctx, strategy, draft } = input;
  const assetMeta = (ref: string): BlueprintAssetRef | null => {
    const a = ctx.assets.find((x) => x.ref === ref);
    return a ? { ref: a.ref, origin: a.origin, illustrativeOnly: a.origin === "GENERATED" } : null;
  };
  const toAction = (c: LandingStrategy["primaryConversion"] | null, label: string | null): BlueprintAction | null =>
    c && c.kind === "ACTION" && label ? { label, objective: c.objective, channel: c.channel, state: c.state, source: c.source, platformUnproven: c.platformUnproven } : null;
  const primaryAction = toAction(strategy.primaryConversion, draft.primaryActionLabel);
  const secondaryAction = toAction(strategy.secondaryConversion, draft.secondaryActionLabel);
  const priority = new Map(strategy.recommendedSections.map((s) => [s.section as string, s.priority]));

  const sections: BlueprintSection[] = draft.sections
    .map((s): BlueprintSection => {
      const base = { sectionType: s.sectionType, priority: priority.get(s.sectionType) ?? 99, heading: s.heading };
      switch (s.sectionType) {
        case "PRIMARY_ACTION":
        case "CONTACT_PANEL":
          return { ...base, body: s.body, action: primaryAction };
        case "ABOUT":
          return { ...base, body: s.body, statements: s.statementRefs.map((r) => ctx.statements.find((x) => x.ref === r)!).map((x) => ({ ref: x.ref, dimension: x.dimension, text: x.text })) };
        case "SERVICE_AREA":
          return { ...base, statements: s.statementRefs.map((r) => ctx.statements.find((x) => x.ref === r)!).map((x) => ({ ref: x.ref, dimension: x.dimension, text: x.text })) };
        case "SERVICES_OVERVIEW":
        case "PRODUCTS_SHOWCASE":
        case "FEATURED_OFFERINGS":
          return {
            ...base,
            intro: s.intro,
            offerings: s.items.map((it) => {
              const o = ctx.offerings.find((x) => x.ref === it.offeringRef)!;
              return { ref: o.ref, kind: o.kind, name: o.name, description: o.description, priceText: o.priceText, blurb: it.blurb, assets: o.assetRefs.map(assetMeta).filter((a): a is BlueprintAssetRef => !!a) };
            }),
          };
        case "TRUST_PROOF":
          return { ...base, intro: s.intro, trustClaims: s.trustClaimRefs.map((r) => ctx.trustClaims.find((x) => x.ref === r)!).map((c) => ({ ref: c.ref, kind: c.kind, wording: c.wording, providedByBusiness: c.providedByBusiness })) };
        case "QUOTE_PROCESS":
        case "BOOKING_INFO":
          return { ...base, steps: [...s.steps] };
        case "LOCATION_AND_HOURS":
          return { ...base, facts: s.factRefs.map((r) => ctx.facts.find((x) => x.ref === r)!).map((f) => ({ ref: f.ref, key: f.key, value: f.value })) };
      }
    })
    .sort((a, b) => a.priority - b.priority);

  const heroAsset = draft.hero.assetRef ? assetMeta(draft.hero.assetRef) : null;
  const neededRoles = strategy.assetNeeds.filter((a) => a.availability !== "AVAILABLE").map((a) => a.kind);
  const missingAssets = [...new Set([...(heroAsset ? [] : ["HERO_IMAGE"]), ...neededRoles])];
  const uniq = (xs: string[]) => [...new Set(xs)].sort();
  const offeringRefs = uniq(sections.flatMap((s) => s.offerings?.map((o) => o.ref) ?? []));
  const trustClaimRefs = uniq(sections.flatMap((s) => s.trustClaims?.map((c) => c.ref) ?? []));
  const assetRefs = uniq([...(heroAsset ? [heroAsset.ref] : []), ...sections.flatMap((s) => s.offerings?.flatMap((o) => o.assets.map((a) => a.ref)) ?? [])]);

  const essentialMissing = strategy.assetNeeds.filter((a) => a.essential && a.availability !== "AVAILABLE").map((a) => `ASSET:${a.kind}`);
  const missingForPublication = uniq([...strategy.publication.missing, ...essentialMissing, ...(assetRefs.length ? [] : ["PUBLIC_APPROVED_ASSET"])]);
  const warnings = uniq([
    ...(primaryAction?.platformUnproven ? ["CHANNEL_PLATFORM_UNPROVEN_OWNER_SELECTED"] : []),
    ...(heroAsset?.illustrativeOnly ? ["HERO_IMAGE_IS_GENERATED_ILLUSTRATIVE_ONLY"] : []),
    ...(strategy.primaryConversion.kind === "SURFACE_ONLY" ? ["SURFACE_ONLY_NO_ACTION"] : []),
    ...(heroAsset ? [] : ["HERO_IMAGE_MISSING"]),
  ]);

  return deepFreeze({
    version: BLUEPRINT_VERSION,
    composerVersion: input.meta.composerVersion,
    promptVersion: input.meta.promptVersion,
    composerContextVersion: input.meta.composerContextVersion,
    strategyEngineVersion: input.meta.strategyEngineVersion,
    businessId: input.businessId,
    strategyId: strategy.id,
    strategyType: strategy.strategyType,
    authority: "MACHINE_PROPOSAL",
    pageIntent: draft.pageIntent,
    metadata: { title: draft.metaTitle, description: draft.metaDescription, language: "he" },
    hero: { headline: draft.hero.headline, subheadline: draft.hero.subheadline, asset: heroAsset, missingAsset: heroAsset ? null : "HERO_IMAGE", action: primaryAction },
    sections,
    primaryAction,
    secondaryAction,
    surfaceOnly: strategy.primaryConversion.kind === "SURFACE_ONLY",
    offeringRefs,
    trustClaimRefs,
    assetRefs,
    factRefs: uniq(sections.flatMap((s) => s.facts?.map((f) => f.ref) ?? [])),
    statementRefs: uniq(sections.flatMap((s) => s.statements?.map((x) => x.ref) ?? [])),
    missingAssets,
    publicationConstraints: [...strategy.publicationConstraints],
    authorityRefs: {
      decidedBy: "DETERMINISTIC_RULES",
      composedBy: "AI_COPY_ONLY",
      actions: "P3B_STRATEGY_CONVERSION",
      trust: "P3A_PUBLIC_EFFECTIVE_CANONICAL_WORDING",
      facts: "P2_PUBLIC_USE_APPROVED",
      statements: "P2_APPROVED_NOT_UNDER_REVIEW",
      offerings: "P1_OWNER_CATALOG",
      assets: "PUBLIC_USE_APPROVED",
    },
    readiness: { publishReady: missingForPublication.length === 0, missingForPublication, warnings },
  });
}
