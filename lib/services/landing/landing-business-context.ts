import type { Prisma } from "@prisma/client";
import {
  assembleIdentityContext,
  loadIdentityContextInputs,
  type BusinessIdentityContext,
  type IdentityContextInputs,
} from "@/lib/services/identity/business-identity-context";
import { listOfferings } from "@/lib/services/offering/business-service.service";
import type { OfferingView } from "@/lib/services/offering/offering-projection";

/**
 * P3-B · LandingBusinessContext — the ONE input of the landing strategy engine.
 *
 * It composes canonical sources instead of re-reading raw tables or re-deciding authority:
 *   BusinessIdentityContext (P2 identity + P3-A trust / conversion / readiness / publicUse)
 *   + the P1 offering projection (listOfferings)
 *   + BusinessAsset metadata (ids, origin, public-use flag, offering links — never a storage key)
 *   + the demand evidence the identity inputs already carry (OfferingDemandSignal ids / types).
 *
 * Every item keeps two separate flags:
 *   usedForDecision        the engine may reason with it (internal demand, owner directives …)
 *   allowedForPublication  a future page may show it (only public-approved / public-effective /
 *                          owner-catalog material)
 * Computed on read; nothing is stored.
 */

type Tx = Prisma.TransactionClient;

export const LANDING_CONTEXT_VERSION = "p3b.context.v1";

export type LandingOffering = {
  kind: "SERVICE" | "PRODUCT";
  id: number;
  name: string;
  category: string | null;
  priceMode: string | null;
  fulfillment: string | null;
  ownerFeatured: boolean;
  /** INTERNAL: demand signals for this offering in the evidence window. Ordering input, never wording. */
  internalDemand: { signals: number; completedBookings: number };
  /** Public-use-approved assets linked to this offering. */
  publicAssetIds: number[];
  /** The owner's own active catalog entry — presentable as entered (name, description, owner price). */
  publiclyPresentable: boolean;
};

/**
 * What an asset may be used for. BusinessAsset models no ROLE (hero / location / team / result), so
 * a role is never inferred: an asset is either an image OF a linked offering, or UNCLASSIFIED.
 */
export type LandingAsset = {
  id: number;
  origin: "OWNER_UPLOAD" | "GENERATED";
  publicUseApproved: boolean;
  linkedOfferings: { kind: "SERVICE" | "PRODUCT"; id: number }[];
  role: "OFFERING_IMAGE" | "UNCLASSIFIED";
};

export type LandingBusinessContext = {
  version: typeof LANDING_CONTEXT_VERSION;
  businessId: number;
  generatedAt: string;
  identity: BusinessIdentityContext;
  offerings: {
    active: LandingOffering[];
    counts: { activeServices: number; activeProducts: number; featured: number; quoteRequired: number; inactive: number };
    mix: "NONE" | "SERVICE_LED" | "PRODUCT_LED" | "HYBRID";
  };
  demand: {
    /** INTERNAL ONLY (authority DERIVED). May order offerings and support a strategy; never public wording. */
    authority: "DERIVED";
    publicUse: "INTERNAL_ONLY";
    totalSignals: number;
    completedBookings: number;
    byType: Record<string, number>;
  };
  assets: {
    /** Public-use-approved assets — the only ones a future renderer may use. */
    publicApproved: LandingAsset[];
    /** Assets that exist but are NOT approved: known, never available for publication. */
    notApprovedCount: number;
    roleModel: "OFFERING_LINK_ONLY";
  };
  /** The material a future page may publish, already filtered by authority. */
  publishable: {
    facts: { key: string; value: string }[];
    /** Approved owner statements, EXCLUDING claim-like text still awaiting owner review. */
    statements: { id: number; dimension: string; text: string }[];
    trustClaims: { id: number; kind: string; wording: string; label: "PROVIDED_BY_BUSINESS" | null }[];
    assetIds: number[];
  };
  /** Owner directives (OWNER_CONFIRMED, internal): what the owner said, used for decisions only. */
  owner: {
    primaryObjective: { code: string; channel: string | null } | null;
    secondaryObjectives: { code: string; channel: string | null }[];
    positioning: string[];
    audience: string[];
    declarations: string[];
  };
  /** SUPPORTED P2 signal kinds (with FULFILLMENT_MODE:<mode>), DERIVED. */
  supportedSignals: string[];
  missingInputs: string[];
  conflicts: { code: string; detail: string[] }[];
};

export type LandingContextInputs = {
  identity: IdentityContextInputs;
  offerings: OfferingView[];
  assets: { id: number; businessId: number; origin: "OWNER_UPLOAD" | "GENERATED"; publicUseApproved: boolean; serviceIds: number[]; productIds: number[] }[];
};

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Pure: the landing context from canonical inputs. */
export function assembleLandingBusinessContext(input: LandingContextInputs): LandingBusinessContext {
  const businessId = input.identity.identity.businessId;
  const identity = assembleIdentityContext(input.identity);

  // ── assets: tenant-checked again (defence in depth on top of RLS), role never inferred ──
  const assets: LandingAsset[] = input.assets
    .filter((a) => a.businessId === businessId)
    .map((a) => {
      const linkedOfferings = [
        ...a.serviceIds.map((id) => ({ kind: "SERVICE" as const, id })),
        ...a.productIds.map((id) => ({ kind: "PRODUCT" as const, id })),
      ].sort((x, y) => byName(x.kind, y.kind) || x.id - y.id);
      return { id: a.id, origin: a.origin, publicUseApproved: a.publicUseApproved, linkedOfferings, role: linkedOfferings.length ? "OFFERING_IMAGE" : "UNCLASSIFIED" } as LandingAsset;
    })
    .sort((x, y) => x.id - y.id);
  const publicAssets = assets.filter((a) => a.publicUseApproved);

  // ── offerings + internal demand ──
  const demandRows = input.identity.identity.evidence.demand;
  const demandFor = (kind: string, id: number) => {
    const rows = demandRows.filter((d) => d.offeringKind === kind && d.offeringId === id);
    return { signals: rows.length, completedBookings: rows.filter((d) => d.signalType === "BOOKING" && d.appointmentStatus === "COMPLETED").length };
  };
  const own = input.offerings.filter((o) => o.businessId === businessId);
  const active: LandingOffering[] = own
    .filter((o) => o.active)
    .map((o) => ({
      kind: o.kind,
      id: o.canonicalId,
      name: o.name,
      category: o.category,
      priceMode: o.priceMode,
      fulfillment: o.fulfillment,
      ownerFeatured: o.featuredByOwner,
      internalDemand: demandFor(o.kind, o.canonicalId),
      publicAssetIds: publicAssets.filter((a) => a.linkedOfferings.some((l) => l.kind === o.kind && l.id === o.canonicalId)).map((a) => a.id),
      publiclyPresentable: o.name.trim().length > 0,
    }))
    .sort((x, y) => byName(x.kind, y.kind) || x.id - y.id);
  const activeServices = active.filter((o) => o.kind === "SERVICE").length;
  const activeProducts = active.filter((o) => o.kind === "PRODUCT").length;
  const total = activeServices + activeProducts;
  const mix = total === 0 ? "NONE" : activeServices / total >= 0.8 ? "SERVICE_LED" : activeServices / total <= 0.2 ? "PRODUCT_LED" : "HYBRID";

  const byType: Record<string, number> = {};
  for (const d of demandRows) byType[d.signalType] = (byType[d.signalType] ?? 0) + 1;

  // ── owner directives (internal) ──
  const codes = (dimension: string) => identity.identity.statements.filter((s) => s.dimension === dimension && s.code).map((s) => s.code!).sort(byName);
  const primary = identity.identity.statements.find((s) => s.dimension === "PRIMARY_OBJECTIVE" && s.code);
  const secondary = identity.identity.statements.filter((s) => s.dimension === "SECONDARY_OBJECTIVE" && s.code);

  // ── publishable material (authority already decided upstream; nothing re-decided here) ──
  const publishable = {
    facts: identity.publicUse.facts.map((f) => ({ key: f.key, value: f.value })),
    statements: identity.publicUse.statements.filter((s) => !s.needsOwnerReview).map((s) => ({ id: s.ref.id, dimension: s.key, text: s.value })),
    trustClaims: identity.publicUse.trustClaims.map((c) => ({ id: c.id, kind: c.kind, wording: c.wording, label: c.label })),
    assetIds: publicAssets.map((a) => a.id),
  };

  const supportedSignals = identity.identity.signals
    .filter((s) => s.status === "SUPPORTED")
    .flatMap((s) => (s.kind === "FULFILLMENT_MODE" ? [s.kind, `FULFILLMENT_MODE:${String(s.value.fulfillment)}`] : s.kind === "CATEGORY_BREADTH" ? [s.kind, `CATEGORY_BREADTH:${String(s.value.breadth)}`] : [s.kind]))
    .sort(byName);

  const missingInputs = [
    ...identity.readiness.missingRequiredInputs,
    ...(total === 0 ? ["ACTIVE_OFFERINGS"] : []),
    ...(publishable.statements.some((s) => s.dimension === "DESCRIPTION") ? [] : ["PUBLIC_DESCRIPTION"]),
    ...(publicAssets.length ? [] : ["PUBLIC_APPROVED_ASSETS"]),
  ];
  const conflicts = [
    ...identity.conversion.conflicts.map((c) => ({ code: c.code, detail: [c.objective ?? "", c.channel ?? "", ...c.detail].filter(Boolean) })),
    ...identity.trust.claimLikeStatements.filter((c) => c.publicUseApproved).map((c) => ({ code: "CLAIM_LIKE_TEXT_NEEDS_REVIEW", detail: [c.dimension, String(c.statementId)] })),
  ];

  return {
    version: LANDING_CONTEXT_VERSION,
    businessId,
    generatedAt: identity.generatedAt,
    identity,
    offerings: {
      active,
      counts: { activeServices, activeProducts, featured: active.filter((o) => o.ownerFeatured).length, quoteRequired: active.filter((o) => o.priceMode === "QUOTE_REQUIRED").length, inactive: own.length - active.length },
      mix,
    },
    demand: { authority: "DERIVED", publicUse: "INTERNAL_ONLY", totalSignals: demandRows.length, completedBookings: demandRows.filter((d) => d.signalType === "BOOKING" && d.appointmentStatus === "COMPLETED").length, byType },
    assets: { publicApproved: publicAssets, notApprovedCount: assets.length - publicAssets.length, roleModel: "OFFERING_LINK_ONLY" },
    publishable,
    owner: {
      primaryObjective: primary ? { code: primary.code!, channel: primary.channel ?? null } : null,
      secondaryObjectives: secondary.map((s) => ({ code: s.code!, channel: s.channel ?? null })),
      positioning: codes("POSITIONING"),
      audience: codes("TARGET_AUDIENCE"),
      declarations: codes("CONVERSION_DECLARATION"),
    },
    supportedSignals,
    missingInputs: [...new Set(missingInputs)],
    conflicts,
  };
}

/**
 * Load inside the caller's tenant transaction. The identity loader pins the tenant FIRST
 * (assertTenantTx); offerings and assets are then read in the same pinned transaction under RLS.
 */
export async function loadLandingContextInputs(businessId: number, tx: Tx, now = new Date()): Promise<LandingContextInputs> {
  const identity = await loadIdentityContextInputs(businessId, tx, now);
  const [offerings, assets] = await Promise.all([
    listOfferings(businessId, tx),
    tx.businessAsset.findMany({
      where: { businessId },
      select: {
        id: true, businessId: true, origin: true, publicUseApproved: true,
        serviceLinks: { select: { businessServiceId: true } },
        itemLinks: { select: { inventoryItemId: true } },
      },
      orderBy: { id: "asc" },
    }),
  ]);
  return {
    identity,
    offerings,
    assets: assets.map((a) => ({
      id: a.id, businessId: a.businessId, origin: a.origin, publicUseApproved: a.publicUseApproved,
      serviceIds: a.serviceLinks.map((l) => l.businessServiceId), productIds: a.itemLinks.map((l) => l.inventoryItemId),
    })),
  };
}

export async function getLandingBusinessContext(businessId: number, tx: Tx, now = new Date()): Promise<LandingBusinessContext> {
  return assembleLandingBusinessContext(await loadLandingContextInputs(businessId, tx, now));
}
