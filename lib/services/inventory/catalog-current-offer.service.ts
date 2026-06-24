import { CatalogAttribute, CatalogSubjectType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { computeFreshness, type Freshness } from "./catalog-freshness";

/**
 * Supplier Domain Catalog — Current Offer read model (DERIVED, runtime-only).
 *
 * There is NO stored "current offer" — no table, no materialized state, no
 * persistence. The current offer is computed at read time from the ACTIVE claims
 * of the Claims Ledger: the latest ACTIVE claim per attribute wins; SUPERSEDED and
 * RETRACTED claims are ignored; freshness is computed, never stored. This is the
 * 4th instance of the canonical append-only-substrate → derived-read-model law.
 */

export type CurrentClaim = {
  attribute: CatalogAttribute;
  valueType: string;
  valueNumber: number | null;
  valueText: string | null;
  valueBool: boolean | null;
  currency: string | null;
  observedAt: Date | null;
  recordedAt: Date;
  claimId: number;
  sourceId: number;
  /** Derived advisory freshness — not persisted. */
  freshness: Freshness;
};

type ActiveClaimRow = {
  id: number;
  attribute: CatalogAttribute;
  valueType: string;
  valueNumber: number | null;
  valueText: string | null;
  valueBool: boolean | null;
  currency: string | null;
  observedAt: Date | null;
  recordedAt: Date;
  sourceId: number;
};

const ACTIVE_SELECT = {
  id: true,
  attribute: true,
  valueType: true,
  valueNumber: true,
  valueText: true,
  valueBool: true,
  currency: true,
  observedAt: true,
  recordedAt: true,
  sourceId: true,
} satisfies Prisma.CatalogClaimSelect;

/** Reduce ACTIVE claim rows to one current claim per attribute (latest wins). */
function deriveCurrentClaims(rows: ActiveClaimRow[], now: Date): CurrentClaim[] {
  const byAttribute = new Map<CatalogAttribute, ActiveClaimRow>();
  // rows arrive newest-first; the first per attribute is therefore the latest.
  for (const row of rows) {
    if (!byAttribute.has(row.attribute)) byAttribute.set(row.attribute, row);
  }
  return [...byAttribute.values()].map((row) => {
    const asOf = row.observedAt ?? row.recordedAt;
    return {
      attribute: row.attribute,
      valueType: row.valueType,
      valueNumber: row.valueNumber,
      valueText: row.valueText,
      valueBool: row.valueBool,
      currency: row.currency,
      observedAt: row.observedAt,
      recordedAt: row.recordedAt,
      claimId: row.id,
      sourceId: row.sourceId,
      freshness: computeFreshness(row.attribute, asOf, now),
    };
  });
}

async function activeClaims(
  businessId: number,
  subjectType: CatalogSubjectType,
  subjectId: number
): Promise<ActiveClaimRow[]> {
  return prisma.catalogClaim.findMany({
    where: { businessId, subjectType, subjectId, status: "ACTIVE" },
    orderBy: [{ observedAt: "desc" }, { recordedAt: "desc" }],
    select: ACTIVE_SELECT,
  }) as unknown as Promise<ActiveClaimRow[]>;
}

/**
 * Current offer for one supplier product — asking price, availability, package
 * description (and any product-level attributes present). Attributes with no
 * ACTIVE claim are simply absent (UNKNOWN).
 */
export async function getCurrentOfferForSupplierProduct(
  businessId: number,
  supplierProductId: number,
  now: Date = new Date()
): Promise<{ supplierProductId: number; claims: CurrentClaim[] }> {
  const rows = await activeClaims(businessId, "SUPPLIER_PRODUCT", supplierProductId);
  return { supplierProductId, claims: deriveCurrentClaims(rows, now) };
}

/**
 * Current supplier-level terms — minimum order amount, lead time. Attributes with
 * no ACTIVE claim are absent (UNKNOWN).
 */
export async function getSupplierLevelOffer(
  businessId: number,
  supplierId: number,
  now: Date = new Date()
): Promise<{ supplierId: number; claims: CurrentClaim[] }> {
  const rows = await activeClaims(businessId, "SUPPLIER", supplierId);
  return { supplierId, claims: deriveCurrentClaims(rows, now) };
}

/**
 * Compose the full current catalog for a supplier: supplier-level terms plus a
 * per-product current offer for each of the supplier's SupplierProducts. All
 * derived; nothing materialized.
 */
export async function getCurrentCatalogForSupplier(
  businessId: number,
  supplierId: number,
  now: Date = new Date()
): Promise<{
  supplierId: number;
  supplierLevel: CurrentClaim[];
  products: { supplierProductId: number; claims: CurrentClaim[] }[];
}> {
  const [supplierLevel, productRows] = await Promise.all([
    getSupplierLevelOffer(businessId, supplierId, now),
    prisma.supplierProduct.findMany({
      where: { businessId, supplierId },
      select: { id: true },
    }),
  ]);

  const products = await Promise.all(
    productRows.map((p) =>
      getCurrentOfferForSupplierProduct(businessId, p.id, now)
    )
  );

  return {
    supplierId,
    supplierLevel: supplierLevel.claims,
    products: products.filter((p) => p.claims.length > 0),
  };
}
