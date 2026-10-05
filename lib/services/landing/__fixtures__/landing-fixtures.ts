/**
 * Test-only fixtures shared by the landing (P3-B) and composer (P3-C) pure suites: synthetic CANONICAL
 * inputs for the real pipeline (assembleLandingBusinessContext → buildLandingStrategySet). Never imported
 * by runtime code.
 */
import type { BusinessIdentityDimension, BusinessIdentityFact, Prisma } from "@prisma/client";
import { FACT_SOURCES, factValueHash, IDENTITY_FACTS, type FactAuthorityRow } from "@/lib/services/identity/identity-fact-authority.service";
import type { IdentityContextInputs } from "@/lib/services/identity/business-identity-context";
import type { IdentityInputs } from "@/lib/services/identity/business-identity";
import type { IdentityStatementRow } from "@/lib/services/identity/identity-statement.service";
import { projectProduct, projectService, type OfferingView } from "@/lib/services/offering/offering-projection";
import { normalizeTrustClaim } from "@/lib/services/trust/trust-claim-catalogue";
import type { TrustClaimRow } from "@/lib/services/trust/trust-claim.service";
import { assembleLandingBusinessContext, type LandingContextInputs } from "../landing-business-context";
import { buildLandingStrategySet } from "../landing-strategy-engine";

export const NOW = new Date("2026-10-05T12:00:00.000Z");
export const DAY = 86_400_000;
export const ago = (d: number) => new Date(NOW.getTime() - d * DAY);

/* ─── fixtures ────────────────────────────────────────────────────────────────────────────────── */

export type FactFx = { fact: BusinessIdentityFact; value: string; authority?: "CONFIRMED" | "PUBLIC" | "STALE_PUBLIC" };
export type StatementFx = { dimension: BusinessIdentityDimension; code?: string; text?: string; channel?: string; publicUseApproved?: boolean };
export type SvcFx = { id: number; priceMode?: "FIXED" | "FROM" | "RANGE" | "QUOTE_REQUIRED" | "NO_PUBLIC_PRICE" | null; fulfillment?: "AT_BUSINESS" | "AT_CUSTOMER" | "ONLINE" | "UNSPECIFIED"; featured?: boolean; category?: string; active?: boolean };
export type ProdFx = { id: number; featured?: boolean; category?: string; active?: boolean };
export type AssetFx = { id: number; origin?: "OWNER_UPLOAD" | "GENERATED"; approved?: boolean; services?: number[]; products?: number[]; businessId?: number };
export type DemandFx = { kind: "SERVICE" | "PRODUCT"; id: number; type: "BOOKING" | "PURCHASE" | "PRICE" | "AVAILABILITY"; n: number; status?: string };
export type Fx = {
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

export function inputsFor(fx: Fx): LandingContextInputs {
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
export const ctxFor = (fx: Fx) => assembleLandingBusinessContext(inputsFor(fx));
export const setFor = (fx: Fx) => buildLandingStrategySet(ctxFor(fx));

export let claimSeq = 0;
export function claimRow(kind: string, params: Record<string, unknown>, opts: { approved?: boolean; verified?: boolean; served?: number; businessId?: number } = {}): TrustClaimRow {
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

export const NAME: FactFx = { fact: "BUSINESS_NAME", value: "עסק", authority: "PUBLIC" };
export const PHONE: FactFx = { fact: "PUBLIC_PHONE", value: "03-5550000", authority: "PUBLIC" };
export const svcs = (n: number, extra: Partial<SvcFx> = {}, from = 1): SvcFx[] => Array.from({ length: n }, (_, i) => ({ id: from + i, ...extra }));
export const prods = (n: number, extra: Partial<ProdFx> = {}, from = 1): ProdFx[] => Array.from({ length: n }, (_, i) => ({ id: from + i, ...extra }));
