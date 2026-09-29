import { Prisma, type ServiceFulfillment } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizeServicePrice, type ServicePriceInput } from "./service-price";
import { projectProduct, projectService, type OfferingView } from "./offering-projection";

const FULFILLMENT = new Set<ServiceFulfillment>([
  "AT_BUSINESS",
  "AT_CUSTOMER",
  "ONLINE",
  "UNSPECIFIED",
]);

export class OfferingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfferingInputError";
  }
}

export class OfferingNotFoundError extends Error {
  constructor() {
    super("Offering not found");
    this.name = "OfferingNotFoundError";
  }
}

type Tx = Prisma.TransactionClient;

export type CreateBusinessServiceInput = {
  businessId: number;
  name: string;
  description?: string | null;
  price: ServicePriceInput;
  durationMinutes?: number | null;
  categoryLabel?: string | null;
  featuredByOwner?: boolean;
  fulfillment?: ServiceFulfillment;
};

function cleanText(value: string | null | undefined, max: number, field: string): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw new OfferingInputError(`${field} is too long`);
  return trimmed;
}

function cleanDuration(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value <= 0) {
    throw new OfferingInputError("durationMinutes must be a positive number of minutes");
  }
  return value;
}

function cleanFulfillment(value: ServiceFulfillment | undefined): ServiceFulfillment {
  if (value === undefined) return "UNSPECIFIED";
  if (!FULFILLMENT.has(value)) throw new OfferingInputError("Unknown fulfillment");
  return value;
}

export async function createBusinessService(input: CreateBusinessServiceInput, tx: Tx = prisma) {
  if (!Number.isInteger(input.businessId) || input.businessId <= 0) {
    throw new OfferingInputError("Invalid business");
  }
  const name = cleanText(input.name, 120, "name");
  if (!name) throw new OfferingInputError("name is required");
  const price = normalizeServicePrice(input.price);

  return tx.businessService.create({
    data: {
      businessId: input.businessId,
      name,
      type: "SERVICE",
      description: cleanText(input.description, 2000, "description"),
      priceMode: price.priceMode,
      priceAmount: price.priceAmount,
      priceMax: price.priceMax,
      durationMinutes: cleanDuration(input.durationMinutes),
      categoryLabel: cleanText(input.categoryLabel, 80, "categoryLabel"),
      featuredByOwner: input.featuredByOwner === true,
      fulfillment: cleanFulfillment(input.fulfillment),
    },
  });
}

export async function listBusinessServices(businessId: number, tx: Tx = prisma) {
  return tx.businessService.findMany({
    where: { businessId },
    orderBy: [{ featuredByOwner: "desc" }, { name: "asc" }],
    include: { assetLinks: { select: { businessAssetId: true } } },
  });
}

/**
 * Associates a retained asset with a service in the same business.
 * Does not approve the asset for public use.
 */
export async function linkServiceAsset(
  input: { businessId: number; businessServiceId: number; businessAssetId: number },
  tx: Tx = prisma
) {
  const service = await tx.businessService.findFirst({
    where: { id: input.businessServiceId, businessId: input.businessId },
    select: { id: true },
  });
  if (!service) throw new OfferingNotFoundError();

  const asset = await tx.businessAsset.findFirst({
    where: { id: input.businessAssetId, businessId: input.businessId },
    select: { id: true, publicUseApproved: true },
  });
  if (!asset) throw new OfferingNotFoundError();

  const existing = await tx.businessServiceAsset.findFirst({
    where: {
      businessId: input.businessId,
      businessServiceId: input.businessServiceId,
      businessAssetId: input.businessAssetId,
    },
  });
  if (existing) return { link: existing, publicUseApproved: asset.publicUseApproved };

  const link = await tx.businessServiceAsset.create({
    data: {
      businessId: input.businessId,
      businessServiceId: input.businessServiceId,
      businessAssetId: input.businessAssetId,
    },
  });
  return { link, publicUseApproved: asset.publicUseApproved };
}

export async function linkProductAsset(
  input: { businessId: number; inventoryItemId: number; businessAssetId: number },
  tx: Tx = prisma
) {
  const item = await tx.inventoryItem.findFirst({
    where: { id: input.inventoryItemId, businessId: input.businessId },
    select: { id: true },
  });
  if (!item) throw new OfferingNotFoundError();

  const asset = await tx.businessAsset.findFirst({
    where: { id: input.businessAssetId, businessId: input.businessId },
    select: { id: true, publicUseApproved: true },
  });
  if (!asset) throw new OfferingNotFoundError();

  const existing = await tx.inventoryItemAsset.findFirst({
    where: {
      businessId: input.businessId,
      inventoryItemId: input.inventoryItemId,
      businessAssetId: input.businessAssetId,
    },
  });
  if (existing) return { link: existing, publicUseApproved: asset.publicUseApproved };

  const link = await tx.inventoryItemAsset.create({
    data: {
      businessId: input.businessId,
      inventoryItemId: input.inventoryItemId,
      businessAssetId: input.businessAssetId,
    },
  });
  return { link, publicUseApproved: asset.publicUseApproved };
}

export async function listOfferings(businessId: number, tx: Tx = prisma): Promise<OfferingView[]> {
  const [services, products] = await Promise.all([
    tx.businessService.findMany({
      where: { businessId },
      include: { assetLinks: { select: { businessAssetId: true } } },
    }),
    tx.inventoryItem.findMany({
      where: { businessId },
      include: {
        category: { select: { name: true } },
        assetLinks: { select: { businessAssetId: true } },
      },
    }),
  ]);
  return [
    ...services.map(projectService),
    ...products.map(projectProduct),
  ];
}
