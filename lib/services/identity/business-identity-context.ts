import type { Prisma } from "@prisma/client";
import { acquisitionGate } from "@/lib/intake/acquisition/gate";
import { findPublicByBusinessId } from "@/lib/services/integrations/whatsapp/connection.service";
import { resolveConversion, type ConversionInputs, type ConversionResolution } from "@/lib/services/conversion/conversion-resolver";
import { evaluateTrustClaim, listActiveTrustClaims, loadServedCustomers, type TrustClaimRow, type TrustClaimView } from "@/lib/services/trust/trust-claim.service";
import { CLAIM_LIKE_TO_KIND, servedCustomersBucket } from "@/lib/services/trust/trust-claim-catalogue";
import { assembleBusinessIdentity, loadIdentityInputs, publicUseInventory, type BusinessIdentityView, type IdentityInputs, type PublicClaim } from "./business-identity";
import { claimLikeMatches } from "./identity-vocabulary";

/**
 * P3-A · BusinessIdentityContext — THE canonical application read model for who a business is, what
 * it may say publicly and how a customer can reach it. Every feature (owner screens, Business Memory,
 * AI context, and later a landing-page layer) reads this, instead of interpreting the P2 / P3-A tables
 * on its own. Computed on read; nothing here is stored.
 *
 * The authority chain is never collapsed:
 *   KNOWN (a value exists) → DERIVED (machine proposal) → OWNER_CONFIRMED → PUBLIC_USE_APPROVED → (published: not built)
 * and every section says which state each item is in. `publicUse` is the ONLY part a public surface
 * may ever read: approved facts with current authority, approved statements, and trust claims that are
 * approved AND have no open issue (expired, re-confirmation due, missing document, lapsed evidence).
 */

type Tx = Prisma.TransactionClient;

export const IDENTITY_CONTEXT_VERSION = "p3a.context.v1";

export type ClaimLikeReview = {
  statementId: number;
  dimension: string;
  publicUseApproved: boolean;
  /** What it reads like; null = a prohibited superlative that no claim kind can carry. */
  suggestedClaimKinds: (string | null)[];
};

export type ReadinessDimension = { ready: boolean; missing: string[] };

export type BusinessIdentityContext = {
  version: string;
  businessId: number;
  generatedAt: string;
  identity: BusinessIdentityView;
  trust: {
    claims: TrustClaimView[];
    publicApproved: TrustClaimView[];
    needsReview: TrustClaimView[];
    /** INTERNAL evidence (p3.evidence.v1). Never a public number: claims say "more than <bucket>". */
    servedCustomers: { count: number; supportedBucket: number | null; ruleVersion: "p3.evidence.v1" };
    /** Approved / approvable P2 free text that reads like a trust claim — owner review, never auto-converted. */
    claimLikeStatements: ClaimLikeReview[];
  };
  conversion: ConversionResolution;
  readiness: {
    identity: ReadinessDimension;
    publicFacts: ReadinessDimension;
    conversion: ReadinessDimension;
    trust: ReadinessDimension;
    hasBlockingConflicts: boolean;
    missingRequiredInputs: string[];
  };
  publicUse: {
    facts: Extract<PublicClaim, { kind: "FACT" }>[];
    statements: (Extract<PublicClaim, { kind: "STATEMENT" }> & { needsOwnerReview: boolean })[];
    trustClaims: { id: number; kind: string; wording: string; label: "PROVIDED_BY_BUSINESS" | null }[];
    conversion: { effectivePrimary: ConversionResolution["effectivePrimary"]; fallback: ConversionResolution["fallback"] };
  };
};

export type IdentityContextInputs = {
  identity: IdentityInputs;
  trustClaims: TrustClaimRow[];
  servedCustomers: number;
  whatsappStatus: ConversionInputs["whatsappStatus"];
  webFormLive: boolean;
  now: Date;
};

const FACT_FOR_CONVERSION = ["PUBLIC_PHONE", "PUBLIC_EMAIL", "PUBLIC_ADDRESS", "OPENING_HOURS", "PUBLIC_WHATSAPP"] as const;

/** Pure: the context from its inputs. */
export function assembleIdentityContext(input: IdentityContextInputs): BusinessIdentityContext {
  const identity = assembleBusinessIdentity(input.identity);

  // ── trust ──
  const claims = input.trustClaims.map((row) => evaluateTrustClaim(row, { now: input.now, servedCustomers: input.servedCustomers }));
  const claimLikeStatements: ClaimLikeReview[] = identity.statements
    .filter((s) => (s.dimension === "DIFFERENTIATOR" || s.dimension === "SPECIALIZATION" || s.dimension === "DESCRIPTION") && s.text)
    .flatMap((s) => {
      const matches = claimLikeMatches(s.text);
      return matches.length
        ? [{ statementId: s.id, dimension: s.dimension, publicUseApproved: s.publicUseApproved, suggestedClaimKinds: [...new Set(matches.map((m) => CLAIM_LIKE_TO_KIND[m.kind] ?? null))] }]
        : [];
    });

  // ── conversion ──
  const factState = (key: (typeof FACT_FOR_CONVERSION)[number]) => {
    const f = identity.facts.find((x) => x.fact === key);
    return { state: f?.state ?? "UNKNOWN", stale: f?.authorityStale ?? false };
  };
  const statementCodes = (dimension: string) => identity.statements.filter((s) => s.dimension === dimension && s.code);
  const supportedSignals = identity.signals.filter((s) => s.status === "SUPPORTED").flatMap((s) =>
    s.kind === "FULFILLMENT_MODE" ? [s.kind, `FULFILLMENT_MODE:${String(s.value.fulfillment)}`] : [s.kind]);
  const conversion = resolveConversion({
    facts: Object.fromEntries(FACT_FOR_CONVERSION.map((k) => [k, factState(k)])) as ConversionInputs["facts"],
    whatsappStatus: input.whatsappStatus,
    webFormLive: input.webFormLive,
    declarations: statementCodes("CONVERSION_DECLARATION").map((s) => s.code!),
    objectives: [
      ...statementCodes("PRIMARY_OBJECTIVE").map((s) => ({ role: "PRIMARY" as const, code: s.code!, channel: s.channel ?? null, statementId: s.id })),
      ...statementCodes("SECONDARY_OBJECTIVE").map((s) => ({ role: "SECONDARY" as const, code: s.code!, channel: s.channel ?? null, statementId: s.id })),
    ],
    activeServices: identity.offering.activeServices,
    activeProducts: identity.offering.activeProducts,
    supportedSignals,
  });

  // ── readiness (deterministic, explicit dimensions; not a score) ──
  const stated = (d: string) => identity.statements.some((s) => s.dimension === d);
  const factApproved = (k: string) => identity.facts.some((f) => f.fact === k && f.state === "PUBLIC_USE_APPROVED");
  const identityMissing = [
    ...(stated("DESCRIPTION") ? [] : ["DESCRIPTION"]),
    ...(stated("TARGET_AUDIENCE") ? [] : ["TARGET_AUDIENCE"]),
    ...(stated("PRIMARY_OBJECTIVE") ? [] : ["PRIMARY_OBJECTIVE"]),
  ];
  const publicFactsMissing = [
    ...(factApproved("BUSINESS_NAME") ? [] : ["PUBLIC_BUSINESS_NAME"]),
    ...(["PUBLIC_PHONE", "PUBLIC_EMAIL", "PUBLIC_WHATSAPP", "PUBLIC_ADDRESS"].some(factApproved) ? [] : ["PUBLIC_CONTACT"]),
  ];
  const primaryUsable = typeof conversion.effectivePrimary === "object";
  const conversionMissing = [
    ...(conversion.effectivePrimary === "UNSET" ? ["PRIMARY_OBJECTIVE"] : []),
    ...(conversion.effectivePrimary === "UNRESOLVED" ? ["USABLE_PATH_FOR_PRIMARY_OBJECTIVE"] : []),
    ...(conversion.fallback === "SURFACE_ONLY" ? ["ANY_USABLE_CONVERSION_PATH"] : []),
  ];
  const trustMissing = [
    ...(claims.some((c) => c.publicEffective) ? [] : ["PUBLIC_TRUST_CLAIM"]),
    ...(claimLikeStatements.some((c) => c.publicUseApproved) ? ["REVIEW_CLAIM_LIKE_TEXT"] : []),
  ];
  const blockingConflicts = conversion.conflicts.filter((c) => c.code === "PREFERENCE_CAPABILITY_CONFLICT" || c.code === "CHANNEL_DEGRADED" || c.code === "AUTHORITY_LAPSED");
  const hasBlockingConflicts = blockingConflicts.length > 0 || claimLikeStatements.some((c) => c.publicUseApproved) || identity.facts.some((f) => f.authorityStale);

  // ── public use (the only part a public surface may read) ──
  const inventory = publicUseInventory(identity);
  const reviewIds = new Set(claimLikeStatements.map((c) => c.statementId));
  const publicApproved = claims.filter((c) => c.publicEffective);

  return {
    version: IDENTITY_CONTEXT_VERSION,
    businessId: input.identity.businessId,
    generatedAt: input.now.toISOString(),
    identity,
    trust: {
      claims,
      publicApproved,
      needsReview: claims.filter((c) => c.issues.length > 0),
      servedCustomers: { count: input.servedCustomers, supportedBucket: servedCustomersBucket(input.servedCustomers), ruleVersion: "p3.evidence.v1" },
      claimLikeStatements,
    },
    conversion,
    readiness: {
      identity: { ready: identityMissing.length === 0, missing: identityMissing },
      publicFacts: { ready: publicFactsMissing.length === 0, missing: publicFactsMissing },
      conversion: { ready: primaryUsable && conversion.fallback === "NONE", missing: conversionMissing },
      trust: { ready: trustMissing.length === 0, missing: trustMissing },
      hasBlockingConflicts,
      missingRequiredInputs: [...new Set([...identityMissing, ...publicFactsMissing, ...conversionMissing])],
    },
    publicUse: {
      facts: inventory.filter((c): c is Extract<PublicClaim, { kind: "FACT" }> => c.kind === "FACT"),
      statements: inventory
        .filter((c): c is Extract<PublicClaim, { kind: "STATEMENT" }> => c.kind === "STATEMENT")
        .map((c) => ({ ...c, needsOwnerReview: reviewIds.has(c.ref.id) })),
      trustClaims: publicApproved.map((c) => ({ id: c.id, kind: c.kind, wording: c.wording, label: c.verification.label })),
      conversion: { effectivePrimary: conversion.effectivePrimary, fallback: conversion.fallback },
    },
  };
}

/**
 * Load everything inside the caller's tenant transaction. Business is read through the P2 tenant pin;
 * WhatsAppConnection (no tenant RLS) through its sanctioned accessor by businessId only, after the pin.
 */
export async function loadIdentityContextInputs(businessId: number, tx: Tx, now = new Date()): Promise<IdentityContextInputs> {
  const identity = await loadIdentityInputs(businessId, tx, now); // pins the tenant (assertTenantTx) first
  const [trustClaims, servedCustomers, whatsapp, webForms] = await Promise.all([
    listActiveTrustClaims(businessId, tx),
    loadServedCustomers(businessId, tx),
    findPublicByBusinessId(businessId),
    tx.acquisitionConnection.count({ where: { businessId, sourceKey: "web.form", status: "ACTIVE" } }),
  ]);
  // The website form only counts when the business actually has a live one AND the feature is on.
  const webFormLive = webForms > 0 ? (await acquisitionGate(businessId, "web.form")).ok : false;
  return {
    identity,
    trustClaims,
    servedCustomers,
    whatsappStatus: (whatsapp?.status ?? null) as ConversionInputs["whatsappStatus"],
    webFormLive,
    now,
  };
}

export async function getBusinessIdentityContext(businessId: number, tx: Tx, now = new Date()): Promise<BusinessIdentityContext> {
  return assembleIdentityContext(await loadIdentityContextInputs(businessId, tx, now));
}

/**
 * The AI projection: authority classes kept apart, so a model can never be handed a flat bag of
 * strings and overstate what is true. Public wording only where public use is effective; owner text
 * that is internal stays marked internal; derived recommendations are labelled as such; and the
 * phrases no claim may use are listed explicitly.
 */
export function identityContextForAi(ctx: BusinessIdentityContext) {
  const text = (d: string) => ctx.identity.statements.filter((s) => s.dimension === d && s.text).map((s) => ({ text: s.text!, publicUseApproved: s.publicUseApproved && !ctx.trust.claimLikeStatements.some((c) => c.statementId === s.id) }));
  const codes = (d: string) => ctx.identity.statements.filter((s) => s.dimension === d && s.code).map((s) => s.code!);
  return {
    version: ctx.version,
    ownerConfirmed: {
      description: text("DESCRIPTION"),
      specializations: text("SPECIALIZATION"),
      differentiators: text("DIFFERENTIATOR"),
      serviceAreas: text("SERVICE_AREA"),
      targetAudience: codes("TARGET_AUDIENCE"),
      tone: codes("TONE"),
      positioning: codes("POSITIONING"),
      objectives: ctx.conversion.preference.map((p) => ({ role: p.role, objective: p.objective, channel: p.channel })),
      fulfilmentDeclarations: codes("CONVERSION_DECLARATION"),
    },
    // Customer-facing material, complete: approved facts, approved owner statements and effective trust
    // claims. Statements come ONLY from the canonical public inventory (ctx.publicUse.statements), and an
    // approved statement that reads like a trust claim (needsOwnerReview) is held back until the owner
    // reviews it — its P2 approval is untouched in the database and still shown to the owner.
    publicApproved: {
      facts: ctx.publicUse.facts.map((f) => ({ fact: f.key, value: f.value })),
      statements: ctx.publicUse.statements.filter((s) => !s.needsOwnerReview).map((s) => ({ dimension: s.key, text: s.value })),
      trustClaims: ctx.publicUse.trustClaims.map((c) => ({ wording: c.wording, providedByBusiness: c.label === "PROVIDED_BY_BUSINESS" })),
    },
    knownButNotPublic: ctx.identity.facts.filter((f) => f.state === "KNOWN" || f.state === "OWNER_CONFIRMED").map((f) => f.fact),
    unverifiedOrBlockedClaims: ctx.trust.claims.filter((c) => !c.publicEffective).map((c) => ({ kind: c.kind, issues: c.issues, publicUseApproved: c.publicUseApproved })),
    derived: {
      recommendations: ctx.conversion.recommendations.map((r) => ({ objective: r.objective, channel: r.channel, reasons: r.reasons })),
      authority: "MACHINE_PROPOSAL" as const,
    },
    conversion: {
      usablePaths: ctx.conversion.paths.filter((p) => p.terminal && (p.state === "AVAILABLE" || p.state === "AVAILABLE_UNOBSERVED")).map((p) => ({ objective: p.objective, channel: p.channel })),
      effectivePrimary: ctx.conversion.effectivePrimary,
      fallback: ctx.conversion.fallback,
    },
    rules: [
      "Use only publicApproved items (facts, statements, trustClaims) in anything a customer will see; ownerConfirmed text that is not in publicApproved is background only.",
      "Never invent testimonials, reviews, ratings, customer counts, years in business, licences or guarantees.",
      "Never use superlatives such as number 1, leading, the best, fastest, most trusted, recommended.",
      "A licence or certification is provided by the business, not externally verified — say so if it is mentioned.",
      "Do not offer a contact path that is not in conversion.usablePaths.",
    ],
  };
}
