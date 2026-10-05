/**
 * P3-B · Landing strategy engine — pure verification. Run:
 *   npx tsx lib/services/landing/landing-strategy.verify.test.ts
 *
 * The REAL pipeline runs on synthetic canonical inputs:
 *   IdentityContextInputs + OfferingView[] + assets → assembleLandingBusinessContext → buildLandingStrategySet
 * (which itself runs assembleIdentityContext → assembleBusinessIdentity / evaluateTrustClaim / resolveConversion).
 * Tenant isolation at the database (S16) and the read-only proof for S20 are in
 * lib/services/identity/identity.rls.db.test.ts.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BusinessIdentityDimension, BusinessIdentityFact, Prisma } from "@prisma/client";
import { FACT_SOURCES, factValueHash, IDENTITY_FACTS, type FactAuthorityRow } from "@/lib/services/identity/identity-fact-authority.service";
import type { IdentityContextInputs } from "@/lib/services/identity/business-identity-context";
import type { IdentityInputs } from "@/lib/services/identity/business-identity";
import type { IdentityStatementRow } from "@/lib/services/identity/identity-statement.service";
import { projectProduct, projectService, type OfferingView } from "@/lib/services/offering/offering-projection";
import { normalizeTrustClaim } from "@/lib/services/trust/trust-claim-catalogue";
import type { TrustClaimRow } from "@/lib/services/trust/trust-claim.service";
import { assembleLandingBusinessContext, type LandingContextInputs } from "./landing-business-context";
import { buildLandingStrategySet, diversityDistance, selectDiverse, type LandingStrategy, type LandingStrategySet } from "./landing-strategy-engine";
import { deepFreeze } from "./landing-strategy.service";
import { EXCLUDED_STRATEGY_TYPES, MIN_DIVERSITY_DISTANCE, STRATEGY_ENGINE_VERSION, STRATEGY_TYPES } from "./landing-strategy-vocabulary";

let failed = 0;
let passed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    passed += 1;
    console.log(`OK: ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra === undefined ? "" : JSON.stringify(extra).slice(0, 1500));
  }
}

const NOW = new Date("2026-10-05T12:00:00.000Z");
const DAY = 86_400_000;
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);

/* ─── fixtures ────────────────────────────────────────────────────────────────────────────────── */

type FactFx = { fact: BusinessIdentityFact; value: string; authority?: "CONFIRMED" | "PUBLIC" | "STALE_PUBLIC" };
type StatementFx = { dimension: BusinessIdentityDimension; code?: string; text?: string; channel?: string; publicUseApproved?: boolean };
type SvcFx = { id: number; priceMode?: "FIXED" | "FROM" | "RANGE" | "QUOTE_REQUIRED" | "NO_PUBLIC_PRICE" | null; fulfillment?: "AT_BUSINESS" | "AT_CUSTOMER" | "ONLINE" | "UNSPECIFIED"; featured?: boolean; category?: string; active?: boolean };
type ProdFx = { id: number; featured?: boolean; category?: string; active?: boolean };
type AssetFx = { id: number; origin?: "OWNER_UPLOAD" | "GENERATED"; approved?: boolean; services?: number[]; products?: number[]; businessId?: number };
type DemandFx = { kind: "SERVICE" | "PRODUCT"; id: number; type: "BOOKING" | "PURCHASE" | "PRICE" | "AVAILABILITY"; n: number; status?: string };
type Fx = {
  businessId?: number;
  facts?: FactFx[];
  statements?: StatementFx[];
  claims?: TrustClaimRow[];
  served?: number;
  whatsapp?: IdentityContextInputs["whatsappStatus"];
  webForm?: boolean;
  services?: SvcFx[];
  products?: ProdFx[];
  demand?: DemandFx[];
  assets?: AssetFx[];
  foreignOfferings?: OfferingView[];
};

function inputsFor(fx: Fx): LandingContextInputs {
  const businessId = fx.businessId ?? 1;
  let id = 0;
  const statements: IdentityStatementRow[] = (fx.statements ?? []).map((s) => ({
    id: ++id, businessId, dimension: s.dimension, code: s.code ?? null, text: s.text ?? null,
    source: "OWNER_INPUT", sourceRef: "settings", channel: (s.channel ?? null) as IdentityStatementRow["channel"], status: "ACTIVE", confirmedByUserId: 1,
    publicUseApproved: s.publicUseApproved === true, publicUseApprovedAt: s.publicUseApproved ? NOW : null, createdAt: NOW,
  }));
  const factValues = Object.fromEntries(IDENTITY_FACTS.map((f) => [f, null])) as IdentityInputs["factValues"];
  const factAuthorities: FactAuthorityRow[] = [];
  for (const f of fx.facts ?? []) {
    factValues[f.fact] = f.value;
    if (!f.authority) continue;
    const decidedFor = f.authority === "STALE_PUBLIC" ? `${f.value} (old)` : f.value;
    factAuthorities.push({
      id: 100 + ++id, businessId, fact: f.fact, sourceField: FACT_SOURCES[f.fact].sourceField, valueHash: factValueHash(decidedFor),
      status: "ACTIVE", confirmedByUserId: 1, confirmedAt: NOW, publicUseApproved: f.authority !== "CONFIRMED", publicUseApprovedAt: f.authority !== "CONFIRMED" ? NOW : null,
    });
  }
  const services = fx.services ?? [];
  const products = fx.products ?? [];
  const demand = (fx.demand ?? []).flatMap((d) => Array.from({ length: d.n }, () => ({ offeringKind: d.kind, offeringId: d.id, signalType: d.type, appointmentStatus: d.status ?? null })));
  const offerings: OfferingView[] = [
    ...services.map((s) => projectService({
      id: s.id, businessId, name: `שירות ${s.id}`, description: null, priceMode: s.priceMode === undefined ? "FIXED" : s.priceMode, priceAmount: null, priceMax: null,
      categoryLabel: s.category ?? "כללי", active: s.active ?? true, featuredByOwner: s.featured ?? false, durationMinutes: null, fulfillment: s.fulfillment ?? "UNSPECIFIED",
    })),
    ...products.map((p) => projectProduct({
      id: p.id, businessId, name: `מוצר ${p.id}`, description: null, sellPricePerUnit: 10, isActive: p.active ?? true, featuredByOwner: p.featured ?? false, currentQuantity: 3,
      category: { name: p.category ?? "כללי" },
    })),
    ...(fx.foreignOfferings ?? []),
  ];
  return {
    identity: {
      identity: {
        businessId, factValues, factAuthorities, profile: null, statements,
        evidence: {
          services: services.map((s) => ({ id: s.id, active: s.active ?? true, categoryLabel: s.category ?? "כללי", fulfillment: s.fulfillment ?? "UNSPECIFIED", priceMode: s.priceMode === undefined ? "FIXED" : s.priceMode })),
          products: products.map((p) => ({ id: p.id, active: p.active ?? true, category: p.category ?? "כללי" })),
          demand, variantSelections: [], bot: null,
        },
        featured: [],
      },
      trustClaims: fx.claims ?? [],
      servedCustomers: fx.served ?? 0,
      whatsappStatus: fx.whatsapp ?? null,
      webFormLive: fx.webForm ?? false,
      now: NOW,
    },
    offerings,
    assets: (fx.assets ?? []).map((a) => ({ id: a.id, businessId: a.businessId ?? businessId, origin: a.origin ?? "OWNER_UPLOAD", publicUseApproved: a.approved ?? false, serviceIds: a.services ?? [], productIds: a.products ?? [] })),
  };
}
const ctxFor = (fx: Fx) => assembleLandingBusinessContext(inputsFor(fx));
const setFor = (fx: Fx) => buildLandingStrategySet(ctxFor(fx));

let claimSeq = 0;
function claimRow(kind: string, params: Record<string, unknown>, opts: { approved?: boolean; verified?: boolean; served?: number; businessId?: number } = {}): TrustClaimRow {
  const confirmedAt = ago(1);
  const n = normalizeTrustClaim(kind, params, { now: confirmedAt, servedCustomers: opts.served ?? null });
  return {
    id: ++claimSeq, businessId: opts.businessId ?? 1, claimKind: n.kind, claimClass: n.claimClass, scopeKey: n.scopeKey, params: n.params, wording: n.wording,
    evidenceRuleId: n.evidence?.ruleId ?? null, evidenceRuleVersion: n.evidence?.ruleVersion ?? null, evidenceCondition: (n.evidence?.condition ?? null) as Prisma.JsonValue,
    confirmedByUserId: 1, confirmedAt, verificationMethod: opts.verified ? "OWNER_DOCUMENT" : null, verificationAttachmentMimeType: opts.verified ? "application/pdf" : null,
    verifiedAt: opts.verified ? confirmedAt : null, validUntil: n.validUntil,
    publicUseApproved: opts.approved === true, publicUseApprovedAt: opts.approved ? confirmedAt : null, status: "ACTIVE",
  };
}

const NAME: FactFx = { fact: "BUSINESS_NAME", value: "עסק", authority: "PUBLIC" };
const PHONE: FactFx = { fact: "PUBLIC_PHONE", value: "03-5550000", authority: "PUBLIC" };
const svcs = (n: number, extra: Partial<SvcFx> = {}, from = 1): SvcFx[] => Array.from({ length: n }, (_, i) => ({ id: from + i, ...extra }));
const prods = (n: number, extra: Partial<ProdFx> = {}, from = 1): ProdFx[] => Array.from({ length: n }, (_, i) => ({ id: from + i, ...extra }));
const types = (s: LandingStrategySet) => s.strategies.map((x) => x.strategyType);
const byType = (s: LandingStrategySet, t: string) => s.strategies.find((x) => x.strategyType === t);
const conflictCodes = (s: LandingStrategySet) => s.conflicts.map((c) => c.code);
const action = (x: LandingStrategy | undefined) => (x?.primaryConversion.kind === "ACTION" ? x.primaryConversion : null);

/** Invariants every strategy set must satisfy, whatever the business. */
function invariants(label: string, fx: Fx) {
  const ctx = ctxFor(fx);
  const set = buildLandingStrategySet(ctx);
  const usablePaths = ctx.identity.conversion.paths.filter((p) => p.terminal && (p.state === "AVAILABLE" || p.state === "AVAILABLE_UNOBSERVED"));
  const ownerUnproven = ctx.identity.conversion.preference.filter((p) => p.state === "PLATFORM_UNPROVEN");
  ok(`${label}: at most 3 strategies, every type from the closed v1 vocabulary`, set.strategies.length <= 3 && set.strategies.every((s) => (STRATEGY_TYPES as readonly string[]).includes(s.strategyType)));
  ok(`${label}: every pair differs on ≥ ${MIN_DIVERSITY_DISTANCE} of 8 dimensions`, set.diversity.pairs.every((p) => p.distance >= MIN_DIVERSITY_DISTANCE), set.diversity.pairs);
  ok(`${label}: every CTA is a usable resolver path, or an owner-chosen PLATFORM_UNPROVEN one`,
    set.strategies.flatMap((s) => [s.primaryConversion, s.secondaryConversion]).every((c) => !c || c.kind === "SURFACE_ONLY" ||
      usablePaths.some((p) => p.objective === c.objective && p.channel === c.channel) ||
      (c.platformUnproven && c.source === "OWNER_SELECTED" && ownerUnproven.some((p) => p.objective === c.objective && p.resolvedChannel === c.channel))));
  ok(`${label}: no strategy CTA uses EXTERNAL_LINK, DUBIZ_CHECKOUT or DUBIZ_BOOKING`,
    set.strategies.every((s) => !["EXTERNAL_LINK", "DUBIZ_CHECKOUT", "DUBIZ_BOOKING"].includes(action(s)?.channel ?? "")));
  ok(`${label}: trust claims named for publication are exactly the public-effective ones`,
    set.strategies.every((s) => s.publishable.trustClaimIds.every((id) => ctx.identity.publicUse.trustClaims.some((c) => c.id === id))));
  ok(`${label}: assets named for publication are public-approved and this business's`,
    set.strategies.every((s) => s.publishable.assetIds.every((id) => ctx.assets.publicApproved.some((a) => a.id === id))));
  ok(`${label}: statements named for publication are approved and not awaiting claim review`,
    set.strategies.every((s) => s.publishable.statementIds.every((id) => ctx.identity.publicUse.statements.some((p) => p.ref.id === id && !p.needsOwnerReview))));
  ok(`${label}: every strategy is a MACHINE_PROPOSAL with an owner explanation and its AI boundary`,
    set.authority === "MACHINE_PROPOSAL" && set.decidedBy === "DETERMINISTIC_RULES" &&
    set.strategies.every((s) => s.authority === "MACHINE_PROPOSAL" && s.ownerExplanation.startsWith("דוביז מציעה כיוון") && s.aiBoundary.mustNotChange.includes("primaryConversion")));
  ok(`${label}: first is RECOMMENDED, the rest ALTERNATIVE`, set.strategies.every((s, i) => s.position === (i === 0 ? "RECOMMENDED" : "ALTERNATIVE")));
  ok(`${label}: deterministic`, JSON.stringify(setFor(fx)) === JSON.stringify(set));
  ok(`${label}: no popularity wording anywhere`, !/פופולרי|הכי נמכר|best.?seller|most popular|customers love/i.test(JSON.stringify(set)));
  return { ctx, set };
}

async function main(): Promise<void> {
  /* ─── S1 · service business + quote evidence + usable form ─── */
  {
    const set = setFor({ facts: [NAME], webForm: true, services: svcs(5, { priceMode: "QUOTE_REQUIRED" }) });
    const q = byType(set, "REQUEST_QUOTE_FIRST");
    ok("S1 REQUEST_QUOTE_FIRST is viable and selected", !!q, types(set));
    ok("S1 …its CTA is the usable website form", action(q)?.channel === "DUBIZ_FORM" && action(q)?.objective === "REQUEST_QUOTE");
    ok("S1 …because quote pricing is supported, with a strong support level", q?.reasons.includes("QUOTE_PRICING_SUPPORTED") === true && q?.support === "STRONG", q?.reasons);
    ok("S1 …and it is the recommended direction (no owner objective set)", set.strategies[0]?.strategyType === "REQUEST_QUOTE_FIRST");
    ok("S1 owner explanation names the reason in owner language", /מתומחרים לפי הצעה/.test(q?.ownerExplanation ?? "") && /טופס הפנייה באתר/.test(q?.ownerExplanation ?? ""), q?.ownerExplanation);
  }

  /* ─── S2 · strong public trust + weak direct conversion ─── */
  {
    const set = setFor({
      facts: [NAME, { fact: "PUBLIC_PHONE", value: "03-5550000" }],
      claims: [claimRow("FOUNDED_YEAR", { foundedYear: 2001 }, { approved: true }), claimRow("CERTIFIED", { certificationName: "קוסמטיקאית", issuer: "משרד הכלכלה" }, { approved: true, verified: true })],
      services: svcs(2),
    });
    const t = byType(set, "TRUST_AUTHORITY_FIRST");
    ok("S2 TRUST_AUTHORITY_FIRST is viable on public-effective trust", !!t && t.trustFocus.publicTrustClaimIds.length === 2, types(set));
    ok("S2 …with no usable contact it is SURFACE_ONLY, never a fabricated CTA", t?.primaryConversion.kind === "SURFACE_ONLY" && t.publicationConstraints.includes("NO_CTA_SURFACE_ONLY"));
    ok("S2 …and requires the 'provided by the business' label", t?.trustFocus.providedByBusinessLabelRequired === true && t.publicationConstraints.includes("LABEL_PROVIDED_BY_BUSINESS"));
  }

  /* ─── S3 · products but no checkout / shop-link authority ─── */
  {
    const fx: Fx = { facts: [NAME], products: prods(6), statements: [{ dimension: "CONVERSION_DECLARATION", code: "EXTERNAL_SHOP" }, { dimension: "PRIMARY_OBJECTIVE", code: "BUY" }] };
    const set = setFor(fx);
    ok("S3 PRODUCT_DISCOVERY_FIRST is viable", types(set).includes("PRODUCT_DISCOVERY_FIRST"), types(set));
    ok("S3 no strategy converts on BUY (no checkout, no shop-link authority)", set.strategies.every((s) => action(s)?.objective !== "BUY" && s.secondaryConversion === null));
    ok("S3 purchase / checkout strategies are not in the v1 vocabulary, with the reason recorded",
      !(STRATEGY_TYPES as readonly string[]).includes("PRODUCT_PURCHASE_FIRST") && /DUBIZ_CHECKOUT/.test(EXCLUDED_STRATEGY_TYPES.PRODUCT_PURCHASE_FIRST));
    ok("S3 the owner's BUY objective is surfaced, not silently replaced", conflictCodes(set).includes("OWNER_OBJECTIVE_NO_STRATEGY_IN_V1"));
    const store = setFor({ facts: [NAME, { fact: "PUBLIC_ADDRESS", value: "הרצל 1", authority: "PUBLIC" }, { fact: "OPENING_HOURS", value: "9-19", authority: "PUBLIC" }], products: prods(6), statements: [{ dimension: "CONVERSION_DECLARATION", code: "ACCEPTS_VISITS" }] });
    ok("S3 buying in a real store is carried as IN_PERSON (secondary of product discovery), never online",
      byType(store, "PRODUCT_DISCOVERY_FIRST")?.secondaryConversion?.kind === "ACTION" && (byType(store, "PRODUCT_DISCOVERY_FIRST")!.secondaryConversion as { channel: string }).channel === "IN_PERSON");
  }

  /* ─── S4 · owner CALL + approved phone ─── */
  {
    const set = setFor({ facts: [NAME, PHONE], services: svcs(2), statements: [{ dimension: "PRIMARY_OBJECTIVE", code: "CALL" }] });
    const first = set.strategies[0];
    ok("S4 CALL_FIRST is the recommended strategy", first?.strategyType === "CALL_FIRST" && first.position === "RECOMMENDED", types(set));
    ok("S4 …on the approved phone, aligned with the owner's primary objective", action(first)?.channel === "PHONE" && first?.ownerObjectiveAlignment === "OWNER_PRIMARY");
  }

  /* ─── S5 · owner objective vs derived evidence ─── */
  {
    const set = setFor({ facts: [NAME, PHONE], webForm: true, services: svcs(6, { priceMode: "QUOTE_REQUIRED", fulfillment: "AT_CUSTOMER" }), statements: [{ dimension: "PRIMARY_OBJECTIVE", code: "CALL" }] });
    ok("S5 the owner's CALL stays the recommended strategy", set.strategies[0]?.strategyType === "CALL_FIRST", types(set));
    ok("S5 the evidence-led REQUEST_QUOTE_FIRST is offered as an alternative", types(set).includes("REQUEST_QUOTE_FIRST"));
    ok("S5 the divergence is surfaced", set.conflicts.some((c) => c.code === "OWNER_EVIDENCE_DIVERGENCE" && c.detail.includes("owner:CALL_FIRST") && c.detail.includes("evidence:REQUEST_QUOTE_FIRST")), set.conflicts);
    ok("S5 not all strategies are CALL-first: exactly one CALL_FIRST, the others are different strategy types",
      set.strategies.filter((s) => s.strategyType === "CALL_FIRST").length === 1 && new Set(types(set)).size === set.strategies.length && set.strategies.length >= 2);
  }

  /* ─── S6 · WhatsApp Cloud PLATFORM_UNPROVEN ─── */
  {
    const base: Fx = { facts: [NAME, { fact: "PUBLIC_WHATSAPP", value: "+972501", authority: "PUBLIC" }], whatsapp: "CONNECTED", services: svcs(2) };
    const owned = setFor({ ...base, statements: [{ dimension: "PRIMARY_OBJECTIVE", code: "WHATSAPP", channel: "WHATSAPP_CLOUD" }] });
    const w = owned.strategies[0];
    ok("S6 the owner may choose WhatsApp Cloud: WHATSAPP_FIRST leads, flagged", w?.strategyType === "WHATSAPP_FIRST" && action(w)?.platformUnproven === true && action(w)?.source === "OWNER_SELECTED", types(owned));
    ok("S6 …with the publication constraint and a surfaced conflict", w?.publicationConstraints.includes("CHANNEL_PLATFORM_UNPROVEN_OWNER_SELECTED") === true && conflictCodes(owned).includes("OWNER_SELECTED_PLATFORM_UNPROVEN"));
    const auto = setFor(base);
    ok("S6 without the owner's choice, WhatsApp Cloud is never used by any strategy", auto.strategies.every((s) => action(s)?.channel !== "WHATSAPP_CLOUD") && !types(auto).includes("WHATSAPP_FIRST"));
    ok("S6 …and WHATSAPP_FIRST is recorded as not viable", auto.notSelected.some((n) => n.strategyType === "WHATSAPP_FIRST" && n.reason === "NOT_VIABLE"));
    const narrativeOwner = setFor({ ...base, services: svcs(4), statements: [{ dimension: "PRIMARY_OBJECTIVE", code: "WHATSAPP", channel: "WHATSAPP_CLOUD" }] });
    ok("S6 alternatives never auto-pick the unproven channel either", narrativeOwner.strategies.slice(1).every((s) => action(s)?.channel !== "WHATSAPP_CLOUD" || action(s)?.source === "OWNER_SELECTED"));
  }

  /* ─── S7 · no usable conversion ─── */
  {
    const set = setFor({ facts: [NAME, { fact: "PUBLIC_PHONE", value: "03-1" }], services: svcs(4) });
    ok("S7 strategies may still be proposed (discovery), all SURFACE_ONLY", set.strategies.length > 0 && set.strategies.every((s) => s.primaryConversion.kind === "SURFACE_ONLY"), types(set));
    ok("S7 …no CTA: the primary-action section has no data and the constraint says NO_CTA",
      set.strategies.every((s) => s.publicationConstraints.includes("NO_CTA_SURFACE_ONLY") && s.recommendedSections.filter((x) => x.section === "PRIMARY_ACTION").every((x) => !x.dataAvailable)));
    ok("S7 readiness: strategy is possible but degraded; publication blocked on the missing path",
      set.readiness.strategy.canGenerateStrategies && set.readiness.strategy.degradedReasons.includes("SURFACE_ONLY_NO_USABLE_CONVERSION") &&
      !set.readiness.publication.publishReady && set.readiness.publication.blockingReasons.includes("NO_USABLE_CONVERSION_PATH"));
    const empty = setFor({});
    ok("S7 a business with nothing usable gets no strategy and an explicit blocking reason (no fabrication)",
      empty.strategies.length === 0 && !empty.readiness.strategy.canGenerateStrategies && empty.readiness.strategy.blockingReasons.includes("NO_VIABLE_STRATEGY"));
  }

  /* ─── S8 · no public trust claims ─── */
  {
    const set = setFor({
      facts: [NAME, PHONE], services: svcs(2),
      claims: [claimRow("FOUNDED_YEAR", { foundedYear: 2001 }), claimRow("LICENSED", { licenseType: "חשמלאי", issuer: "משרד העבודה" }, { approved: true })],
      statements: [{ dimension: "DIFFERENTIATOR", text: "חשמלאים מוסמכים מאז 1998", publicUseApproved: true }],
      served: 800,
    });
    ok("S8 TRUST_AUTHORITY_FIRST is not selected without public-effective trust", !types(set).includes("TRUST_AUTHORITY_FIRST"));
    ok("S8 …it is recorded NOT_VIABLE with the reason",
      set.notSelected.some((n) => n.strategyType === "TRUST_AUTHORITY_FIRST" && n.reason === "NOT_VIABLE" && n.blockers.includes("NO_PUBLIC_EFFECTIVE_TRUST_CLAIM")));
    ok("S8 internal counts (800 served) never become trust material", !JSON.stringify(set.strategies).includes("800"));
  }

  /* ─── S9 · internal demand ─── */
  {
    const fx: Fx = { facts: [NAME], products: prods(6), demand: [{ kind: "PRODUCT", id: 4, type: "PURCHASE", n: 12 }, { kind: "PRODUCT", id: 2, type: "PURCHASE", n: 3 }] };
    const set = setFor(fx);
    const p = byType(set, "PRODUCT_DISCOVERY_FIRST");
    ok("S9 internal demand orders the focus: the most-demanded product leads", p?.offeringFocus.primary[0]?.id === 4 && p.offeringFocus.primary[0].internalDemandRank === 1 && p.offeringFocus.primary[0].selectedBecause.includes("INTERNAL_DEMAND"), p?.offeringFocus);
    ok("S9 …the demand evidence is used for decision but not allowed for publication",
      p?.evidence.some((e) => e.code === "INTERNAL_DEMAND_ORDERS_OFFERINGS" && e.usedForDecision && !e.allowedForPublication) === true);
    ok("S9 …and it creates no popularity claim", p?.publicationConstraints.includes("NO_DEMAND_OR_POPULARITY_WORDING") === true && !/פופולרי|הכי נמכר|best.?seller|most popular|customers love/i.test(set.strategies.map((x) => x.ownerExplanation).join(" ")));
    const featured = setFor({ ...fx, products: prods(6).map((x) => (x.id === 5 ? { ...x, featured: true } : x)) });
    ok("S9 the owner's featured choice outranks internal demand", byType(featured, "PRODUCT_DISCOVERY_FIRST")?.offeringFocus.primary[0]?.id === 5);
  }

  /* ─── S10 · claim-like P2 text awaiting review ─── */
  {
    const ctx = ctxFor({ facts: [NAME, PHONE], services: svcs(4), statements: [
      { dimension: "DIFFERENTIATOR", text: "המובילים בעיר מאז 1998", publicUseApproved: true },
      { dimension: "DESCRIPTION", text: "מספרה שכונתית", publicUseApproved: true },
    ] });
    const set = buildLandingStrategySet(ctx);
    const claimLikeId = ctx.identity.trust.claimLikeStatements[0]?.statementId;
    ok("S10 the claim-like statement is excluded from the publishable material", claimLikeId !== undefined && !ctx.publishable.statements.some((s) => s.id === claimLikeId));
    ok("S10 …and from every strategy's publishable statements; the safe one stays",
      set.strategies.length > 0 && set.strategies.every((s) => !s.publishable.statementIds.includes(claimLikeId!) && s.publishable.statementIds.length === 1));
    ok("S10 …with a constraint and a surfaced review conflict",
      set.strategies.every((s) => s.publicationConstraints.includes("CLAIM_LIKE_TEXT_EXCLUDED_UNTIL_OWNER_REVIEW")) && conflictCodes(set).includes("CLAIM_LIKE_TEXT_NEEDS_REVIEW"));
  }

  /* ─── S11 / S12 · assets ─── */
  {
    const fx: Fx = {
      facts: [NAME], products: prods(4), claims: [claimRow("FOUNDED_YEAR", { foundedYear: 2001 }, { approved: true })],
      assets: [
        { id: 1, approved: true, products: [1] },
        { id: 2, approved: false, products: [2] },
        { id: 3, origin: "GENERATED", approved: true },
        { id: 4, approved: true },
        { id: 5, approved: true, products: [3], businessId: 2 },
      ],
    };
    const ctx = ctxFor(fx);
    const set = buildLandingStrategySet(ctx);
    const p = byType(set, "PRODUCT_DISCOVERY_FIRST");
    ok("S11 a public-approved image of a focused product is AVAILABLE", p?.assetNeeds.find((a) => a.kind === "OFFERING_IMAGE")?.availability === "AVAILABLE" && p.publishable.assetIds.includes(1), p?.assetNeeds);
    ok("S12 an unapproved asset is never available for publication", !set.strategies.some((s) => s.publishable.assetIds.includes(2)) && !ctx.publishable.assetIds.includes(2) && ctx.assets.notApprovedCount === 1);
    ok("S12 another business's asset is dropped even if it reached the inputs", !ctx.assets.publicApproved.some((a) => a.id === 5));
    const t = byType(set, "TRUST_AUTHORITY_FIRST");
    const team = t?.assetNeeds.find((a) => a.kind === "OWNER_OR_TEAM_IMAGE");
    ok("S12 an owner / team photo is never assigned automatically (role not modelled)", team?.availability === "UNCLASSIFIED_CANDIDATES" && team.assetIds.length === 0, team);
    const generatedOnly = buildLandingStrategySet(ctxFor({ ...fx, assets: [{ id: 3, origin: "GENERATED", approved: true }] }));
    ok("S12 a generated image is never even a candidate for a person, place or result",
      byType(generatedOnly, "TRUST_AUTHORITY_FIRST")?.assetNeeds.find((a) => a.kind === "OWNER_OR_TEAM_IMAGE")?.availability === "MISSING");
    ok("S12 an essential asset that is missing blocks publication, not the strategy",
      byType(setFor({ facts: [NAME], products: prods(4) }), "PRODUCT_DISCOVERY_FIRST")?.publication.missing.includes("ASSET:OFFERING_IMAGE") === true);
  }

  /* ─── S13 · three materially different strategies ─── */
  {
    const { set } = invariants("S13", {
      facts: [NAME, PHONE, { fact: "PUBLIC_ADDRESS", value: "הרצל 1", authority: "PUBLIC" }, { fact: "OPENING_HOURS", value: "9-19", authority: "PUBLIC" }],
      webForm: true, services: svcs(6, { priceMode: "QUOTE_REQUIRED" }),
      claims: [claimRow("FOUNDED_YEAR", { foundedYear: 2001 }, { approved: true }), claimRow("CERTIFIED", { certificationName: "x", issuer: "y" }, { approved: true, verified: true })],
      statements: [{ dimension: "PRIMARY_OBJECTIVE", code: "REQUEST_QUOTE" }, { dimension: "CONVERSION_DECLARATION", code: "ACCEPTS_VISITS" }],
    });
    ok("S13 three strategies are returned", set.strategies.length === 3, types(set));
    ok("S13 they differ in objective or intent and in narrative", new Set(set.strategies.map((s) => s.visitorIntent)).size === 3 && new Set(set.strategies.map((s) => s.narrativeApproach)).size === 3);
    ok("S13 the owner's REQUEST_QUOTE leads, a trust-led alternative with the same quote CTA is genuinely different",
      set.strategies[0].strategyType === "REQUEST_QUOTE_FIRST" && types(set).includes("TRUST_AUTHORITY_FIRST") &&
      action(byType(set, "TRUST_AUTHORITY_FIRST"))?.objective === "REQUEST_QUOTE");
  }

  /* ─── S14 · only two defensible strategies ─── */
  {
    const set = setFor({ facts: [NAME, PHONE], services: svcs(2), statements: [{ dimension: "PRIMARY_OBJECTIVE", code: "CALL" }] });
    ok("S14 exactly two strategies — no fabricated third", set.strategies.length === 2, types(set));
    ok("S14 …and the shortfall is explicit", set.readiness.strategy.degradedReasons.includes("FEWER_THAN_3_DISTINCT_STRATEGIES"));
  }

  /* ─── S15 · identical candidates are filtered ─── */
  {
    const set = setFor({ facts: [NAME, PHONE], services: svcs(2), statements: [{ dimension: "CONVERSION_DECLARATION", code: "WHATSAPP_ON_PUBLIC_PHONE" }, { dimension: "PRIMARY_OBJECTIVE", code: "CALL" }] });
    const sim = set.notSelected.find((n) => n.strategyType === "WHATSAPP_FIRST");
    ok("S15 WhatsApp-first on the same phone is too close to Call-first (same narrative, focus, proof) and is filtered",
      sim?.reason === "TOO_SIMILAR" && sim.similarTo === "CALL_FIRST" && (sim.distance ?? 99) < MIN_DIVERSITY_DISTANCE, sim);
    const a = set.strategies[0];
    const clone = { ...a, strategyType: "WHATSAPP_FIRST" as const };
    const { kept, rejected } = selectDiverse([a, clone]);
    ok("S15 an identical objective / channel / focus duplicate is removed by the filter", kept.length === 1 && rejected[0]?.reason === "TOO_SIMILAR" && diversityDistance(a, clone).distance === 0);
    const headlineOnly = { ...a, strategyType: "LEAD_CAPTURE_FIRST" as const, ownerExplanation: "כותרת אחרת", recommendedSections: [...a.recommendedSections].reverse().map((x, i) => ({ ...x, priority: i + 1 })) };
    ok("S15 different wording / reordered sections alone do not count as different", diversityDistance(a, headlineOnly).distance < MIN_DIVERSITY_DISTANCE);
  }

  /* ─── S17 · determinism ─── */
  {
    const fx: Fx = { facts: [NAME, PHONE], webForm: true, services: svcs(6, { priceMode: "QUOTE_REQUIRED" }), products: prods(3), assets: [{ id: 9, approved: true, services: [2] }, { id: 3, approved: true, products: [1] }],
      demand: [{ kind: "SERVICE", id: 3, type: "PRICE", n: 4 }] };
    const a = JSON.stringify(setFor(fx));
    const shuffled = inputsFor(fx);
    shuffled.offerings.reverse();
    shuffled.assets.reverse();
    shuffled.identity.identity.evidence.demand.reverse();
    ok("S17 same inputs → byte-identical set", a === JSON.stringify(setFor(fx)));
    ok("S17 input order does not change the output", a === JSON.stringify(buildLandingStrategySet(assembleLandingBusinessContext(shuffled))));
    ok("S17 the set carries the engine version and the context's own timestamp (no clock read)", setFor(fx).version === STRATEGY_ENGINE_VERSION && setFor(fx).generatedAt === NOW.toISOString());
  }

  /* ─── S18 · AI does not decide strategy truth ─── */
  {
    const dir = join(process.cwd(), "lib/services/landing");
    const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.includes(".test.")).map((f) => readFileSync(join(dir, f), "utf8"));
    const imports = sources.flatMap((s) => s.split("\n").filter((l) => /^\s*import\b|from\s+["']/.test(l)));
    ok("S18 no landing-strategy module imports a model / LLM / content-generation client",
      imports.length > 0 && !imports.some((l) => /openai|anthropic|@ai-sdk|\bllm\b|ai-content|script-ai|gemini|content-generation/i.test(l)), imports.filter((l) => /ai/i.test(l)));
    const realFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => { called = true; throw new Error("network forbidden"); }) as typeof fetch;
    try {
      setFor({ facts: [NAME, PHONE], services: svcs(4) });
    } finally {
      globalThis.fetch = realFetch;
    }
    ok("S18 building a strategy set makes no network call", !called);
    ok("S18 the AI boundary is explicit on every strategy", setFor({ facts: [NAME, PHONE], services: svcs(4) }).strategies.every((s) =>
      ["strategyType", "primaryConversion", "trustFocus", "publishable", "evidence", "authority"].every((f) => s.aiBoundary.mustNotChange.includes(f))));
    const frozen = deepFreeze(setFor({ facts: [NAME, PHONE], services: svcs(4) }));
    let mutated = true;
    try {
      (frozen.strategies[0].primaryConversion as { channel: string }).channel = "EXTERNAL_LINK";
    } catch {
      mutated = false;
    }
    ok("S18 the served set is frozen: a downstream consumer cannot rewrite a strategy's conversion", !mutated || (frozen.strategies[0].primaryConversion as { channel: string }).channel !== "EXTERNAL_LINK");
  }

  /* ─── S19 · strategy-ready ≠ publish-ready ─── */
  {
    const set = setFor({ facts: [PHONE], services: svcs(4), statements: [{ dimension: "PRIMARY_OBJECTIVE", code: "CALL" }] });
    ok("S19 a business can choose a strategy…", set.readiness.strategy.canGenerateStrategies && set.readiness.strategy.strategyReady);
    ok("S19 …without being able to publish (no public name, no public description)",
      !set.readiness.publication.publishReady && set.readiness.publication.missingInputs.includes("PUBLIC_BUSINESS_NAME") && set.readiness.publication.missingInputs.includes("PUBLIC_DESCRIPTION"));
    ok("S19 readiness is explicit lists, never a score", !/score/i.test(JSON.stringify(set.readiness)));
    const full = setFor({ facts: [NAME, PHONE], services: svcs(4), statements: [{ dimension: "PRIMARY_OBJECTIVE", code: "CALL" }, { dimension: "DESCRIPTION", text: "מוסך שכונתי", publicUseApproved: true },
      { dimension: "SERVICE_AREA", text: "חיפה", publicUseApproved: true }], claims: [claimRow("FOUNDED_YEAR", { foundedYear: 2001 }, { approved: true })] });
    ok("S19 with the public basics the recommended strategy is publish-ready", full.readiness.publication.publishReady, full.readiness.publication);
    ok("S19 the 90-day subscription rule is not part of readiness", !/subscription|tenure|90/i.test(JSON.stringify(full.readiness)));
  }

  /* ─── S20 · a generated strategy is a proposal, not owner truth ─── */
  {
    const set = setFor({ facts: [NAME, PHONE], services: svcs(4), statements: [{ dimension: "PRIMARY_OBJECTIVE", code: "CALL" }] });
    ok("S20 the set and every strategy are MACHINE_PROPOSAL", set.authority === "MACHINE_PROPOSAL" && set.strategies.every((s) => s.authority === "MACHINE_PROPOSAL"));
    const dir = join(process.cwd(), "lib/services/landing");
    const src = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.includes(".test.")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    ok("S20 the landing modules never write (no create / update / upsert / delete / raw execute)",
      !/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw/.test(src));
    const snapshotSrc = readdirSync(join(process.cwd(), "lib/knowledge/snapshot")).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(join(process.cwd(), "lib/knowledge/snapshot", f), "utf8")).join("\n");
    ok("S20 Business Memory does not read strategies as knowledge", !/landing/i.test(snapshotSrc));
  }

  /* ─── diversity rules on the vocabulary itself ─── */
  {
    const full = ctxFor({
      facts: [NAME, PHONE, { fact: "PUBLIC_EMAIL", value: "a@b.co", authority: "PUBLIC" }, { fact: "PUBLIC_ADDRESS", value: "הרצל 1", authority: "PUBLIC" }, { fact: "OPENING_HOURS", value: "9-19", authority: "PUBLIC" }],
      webForm: true, services: svcs(6, { priceMode: "QUOTE_REQUIRED" }), products: prods(6, {}, 100),
      demand: [{ kind: "SERVICE", id: 1, type: "BOOKING", n: 12, status: "COMPLETED" }],
      claims: [claimRow("FOUNDED_YEAR", { foundedYear: 2001 }, { approved: true })],
      statements: ["ACCEPTS_VISITS", "BOOKING_BY_MESSAGE", "QUOTES_ON_REQUEST", "WHATSAPP_ON_PUBLIC_PHONE"].map((code) => ({ dimension: "CONVERSION_DECLARATION" as const, code })),
    });
    const set = buildLandingStrategySet(full);
    ok("D every v1 type is viable for a business that can do everything", set.notSelected.every((n) => n.reason !== "NOT_VIABLE"), set.notSelected);
    ok("D still only three are returned, all pairwise ≥ 4 apart", set.strategies.length === 3 && set.diversity.pairs.length === 3 && set.diversity.pairs.every((p) => p.distance >= MIN_DIVERSITY_DISTANCE), set.diversity.pairs);
    ok("D the rest are accounted for (TOO_SIMILAR or LOWER_RANK), none silently dropped", set.strategies.length + set.notSelected.length === STRATEGY_TYPES.length);
  }

  /* ─── verticals ─── */
  {
    const verticals: { name: string; fx: Fx; expect: (s: LandingStrategySet) => [string, boolean][] }[] = [
      {
        name: "Service business (renovations)",
        fx: { facts: [NAME, PHONE], webForm: true, services: svcs(7, { priceMode: "QUOTE_REQUIRED", fulfillment: "AT_CUSTOMER" }), statements: [{ dimension: "PRIMARY_OBJECTIVE", code: "REQUEST_QUOTE" }] },
        expect: (s) => [["quote first via the form", s.strategies[0]?.strategyType === "REQUEST_QUOTE_FIRST" && action(s.strategies[0])?.channel === "DUBIZ_FORM"], ["a call alternative exists", types(s).includes("CALL_FIRST")]],
      },
      {
        name: "Retail / product business",
        fx: { facts: [NAME, PHONE], products: prods(12, {}, 1).map((p) => (p.id <= 2 ? { ...p, featured: true } : p)), statements: [{ dimension: "PRIMARY_OBJECTIVE", code: "DISCOVER_PRODUCTS" }],
          assets: [{ id: 1, approved: true, products: [1] }] },
        expect: (s) => [["product discovery leads (owner objective)", s.strategies[0]?.strategyType === "PRODUCT_DISCOVERY_FIRST"], ["featured products lead its focus", s.strategies[0]?.offeringFocus.primary.slice(0, 2).every((o) => o.ownerFeatured) === true],
          ["no purchase CTA", s.strategies.every((x) => action(x)?.objective !== "BUY")]],
      },
      {
        name: "Local storefront (cafe)",
        fx: { facts: [NAME, PHONE, { fact: "PUBLIC_ADDRESS", value: "דיזנגוף 1", authority: "PUBLIC" }, { fact: "OPENING_HOURS", value: "7-20", authority: "PUBLIC" }], products: prods(5),
          services: svcs(1, { fulfillment: "AT_BUSINESS" }, 50), statements: [{ dimension: "CONVERSION_DECLARATION", code: "ACCEPTS_VISITS" }, { dimension: "TARGET_AUDIENCE", code: "WALK_IN_CUSTOMERS" }] },
        expect: (s) => [["local visit is recommended from evidence", s.strategies[0]?.strategyType === "LOCAL_VISIT_FIRST"], ["…on IN_PERSON", action(s.strategies[0])?.channel === "IN_PERSON"]],
      },
      {
        name: "Professional high-trust service (accountant)",
        fx: { facts: [NAME, { fact: "PUBLIC_EMAIL", value: "office@x.co", authority: "PUBLIC" }], webForm: true, services: svcs(4),
          claims: [claimRow("LICENSED", { licenseType: "רואה חשבון", issuer: "מועצת רואי החשבון" }, { approved: true, verified: true }), claimRow("FOUNDED_YEAR", { foundedYear: 1995 }, { approved: true })],
          statements: [{ dimension: "POSITIONING", code: "EXPERTISE" }, { dimension: "TARGET_AUDIENCE", code: "BUSINESSES" }, { dimension: "PRIMARY_OBJECTIVE", code: "LEAVE_LEAD" }] },
        expect: (s) => [["the owner's lead capture leads", s.strategies[0]?.strategyType === "LEAD_CAPTURE_FIRST"], ["trust-led is a strong alternative", byType(s, "TRUST_AUTHORITY_FIRST")?.support === "STRONG"],
          ["the licence carries the provided-by-business label", byType(s, "TRUST_AUTHORITY_FIRST")?.trustFocus.providedByBusinessLabelRequired === true]],
      },
      {
        name: "Appointment-oriented (beauty)",
        fx: { facts: [NAME, PHONE], services: svcs(5), demand: [{ kind: "SERVICE", id: 2, type: "BOOKING", n: 14, status: "COMPLETED" }],
          statements: [{ dimension: "CONVERSION_DECLARATION", code: "BOOKING_BY_MESSAGE" }, { dimension: "TARGET_AUDIENCE", code: "APPOINTMENT_CUSTOMERS" }] },
        expect: (s) => [["booking first, from completed bookings, by phone", s.strategies[0]?.strategyType === "BOOKING_FIRST" && action(s.strategies[0])?.channel === "PHONE"],
          ["booked services lead its focus", s.strategies[0]?.offeringFocus.primary[0]?.id === 2]],
      },
      {
        name: "Home / mobile service (plumber)",
        fx: { facts: [NAME, PHONE], services: svcs(3, { fulfillment: "AT_CUSTOMER" }), statements: [{ dimension: "SERVICE_AREA", text: "הקריות", publicUseApproved: true }, { dimension: "PRIMARY_OBJECTIVE", code: "CALL" }] },
        expect: (s) => [["call first", s.strategies[0]?.strategyType === "CALL_FIRST"], ["no local-visit strategy (no storefront)", !types(s).includes("LOCAL_VISIT_FIRST")]],
      },
    ];
    const recommended = new Set<string>();
    for (const v of verticals) {
      const { set } = invariants(v.name, v.fx);
      for (const [name, cond] of v.expect(set)) ok(`${v.name}: ${name}`, cond, types(set));
      recommended.add(set.strategies[0]?.strategyType ?? "NONE");
    }
    ok("verticals: six businesses yield at least five different recommended strategies", recommended.size >= 5, [...recommended]);
  }

  /* ─── tenant (pure part): foreign rows never enter ─── */
  {
    const foreign = projectService({ id: 999, businessId: 2, name: "שירות של עסק אחר", description: null, priceMode: "QUOTE_REQUIRED", priceAmount: null, priceMax: null, categoryLabel: null, active: true, featuredByOwner: true, durationMinutes: null, fulfillment: "UNSPECIFIED" });
    const ctx = ctxFor({ facts: [NAME, PHONE], services: svcs(3), foreignOfferings: [foreign], claims: [claimRow("FOUNDED_YEAR", { foundedYear: 2001 }, { approved: true })] });
    ok("tenant: another business's offering never enters the context or a strategy", !ctx.offerings.active.some((o) => o.id === 999) && !JSON.stringify(buildLandingStrategySet(ctx)).includes("שירות של עסק אחר"));
  }
}

main().then(() => {
  console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nP3-B landing strategy engine: all ${passed} checks passed ✔`);
  if (failed) process.exit(1);
}, (error) => {
  console.error(error);
  process.exit(1);
});
