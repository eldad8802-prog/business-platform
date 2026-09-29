import type { Prisma, ServiceFulfillment, ServicePriceMode } from "@prisma/client";

/**
 * Read model over the product domain and the service domain.
 * It is not a table, and it does not make a product into a service.
 * Unknown prices stay unknown. Legacy BusinessService.basePrice is not a price mode.
 */
export type OfferingKindName = "PRODUCT" | "SERVICE";

export type OfferingView = {
  kind: OfferingKindName;
  canonicalId: number;
  businessId: number;
  name: string;
  description: string | null;
  priceMode: ServicePriceMode | "FIXED" | null;
  priceAmount: string | null;
  priceMax: string | null;
  category: string | null;
  active: boolean;
  featuredByOwner: boolean;
  assetIds: number[];
  durationMinutes: number | null;
  fulfillment: ServiceFulfillment | null;
  /** Products only. Services do not pretend to have stock. */
  stockQuantity: number | null;
};

type ServiceRow = {
  id: number;
  businessId: number;
  name: string;
  description: string | null;
  priceMode: ServicePriceMode | null;
  priceAmount: Prisma.Decimal | null;
  priceMax: Prisma.Decimal | null;
  categoryLabel: string | null;
  active: boolean;
  featuredByOwner: boolean;
  durationMinutes: number | null;
  fulfillment: ServiceFulfillment;
  assetLinks?: { businessAssetId: number }[];
};

type ProductRow = {
  id: number;
  businessId: number;
  name: string;
  description: string | null;
  sellPricePerUnit: number | null;
  isActive: boolean;
  featuredByOwner: boolean;
  currentQuantity: number;
  category?: { name: string } | null;
  assetLinks?: { businessAssetId: number }[];
};

function decimal(value: Prisma.Decimal | null): string | null {
  return value === null ? null : value.toFixed(2);
}

export function projectService(row: ServiceRow): OfferingView {
  return {
    kind: "SERVICE",
    canonicalId: row.id,
    businessId: row.businessId,
    name: row.name,
    description: row.description,
    priceMode: row.priceMode,
    priceAmount: decimal(row.priceAmount),
    priceMax: decimal(row.priceMax),
    category: row.categoryLabel,
    active: row.active,
    featuredByOwner: row.featuredByOwner,
    assetIds: (row.assetLinks ?? []).map((link) => link.businessAssetId),
    durationMinutes: row.durationMinutes,
    fulfillment: row.fulfillment,
    stockQuantity: null,
  };
}

export function projectProduct(row: ProductRow): OfferingView {
  const hasPrice = row.sellPricePerUnit !== null && Number.isFinite(row.sellPricePerUnit);
  return {
    kind: "PRODUCT",
    canonicalId: row.id,
    businessId: row.businessId,
    name: row.name,
    description: row.description,
    priceMode: hasPrice ? "FIXED" : null,
    priceAmount: hasPrice ? row.sellPricePerUnit!.toFixed(2) : null,
    priceMax: null,
    category: row.category?.name ?? null,
    active: row.isActive,
    featuredByOwner: row.featuredByOwner,
    assetIds: (row.assetLinks ?? []).map((link) => link.businessAssetId),
    durationMinutes: null,
    fulfillment: null,
    stockQuantity: row.currentQuantity,
  };
}
