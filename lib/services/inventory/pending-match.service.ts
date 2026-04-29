import { prisma } from "@/lib/prisma";
import { inventoryService } from "@/lib/services/inventory/inventory.service";

type PendingMatchMetadata = {
  externalSaleId: string;
  sku: string | null;
  barcode: string | null;
  name: string | null;
  quantity: number;
  source: string | null;
  unmatchedItems?: {
    sku: string | null;
    barcode: string | null;
    name: string | null;
    quantity: number;
  }[];
  allItems?: {
    sku: string | null;
    barcode: string | null;
    name: string | null;
    quantity: number;
  }[];
};

type CreatePendingMatchInput = {
  businessId: number;
  externalSaleId: string;
  metadata: PendingMatchMetadata;
};

export async function createPendingMatch(input: CreatePendingMatchInput) {
  const { businessId, externalSaleId, metadata } = input;

  return prisma.$transaction(async (tx) => {
    const existing = await tx.inventoryPendingMatch.findUnique({
      where: {
        businessId_externalSaleId: {
          businessId,
          externalSaleId,
        },
      },
    });

    if (existing) {
      return existing;
    }

    const pending = await tx.inventoryPendingMatch.create({
      data: {
        businessId,
        externalSaleId,
        metadata,
        status: "PENDING",
      },
    });

    // 🔥 יצירת Alert מקושר ל־PendingMatch
    await tx.inventoryAlert.create({
      data: {
        businessId,
        type: "UNMATCHED_POS_PRODUCT",
        message: `מוצר מהקופה לא זוהה: ${
          metadata.name || metadata.sku || metadata.barcode || externalSaleId
        }`,
        pendingMatchId: pending.id,
      },
    });

    return pending;
  });
}

export async function getOpenPendingMatches(businessId: number) {
  return prisma.inventoryPendingMatch.findMany({
    where: {
      businessId,
      status: "PENDING",
    },
    orderBy: {
      createdAt: "desc",
    },
  });
}

type ResolveWithExistingItemInput = {
  pendingMatchId: number;
  businessId: number;
  userId: number;
  itemId: number;
};

export async function resolvePendingMatchWithExistingItem(
  input: ResolveWithExistingItemInput
) {
  const { pendingMatchId, businessId, userId, itemId } = input;

  const pending = await prisma.inventoryPendingMatch.findFirst({
    where: {
      id: pendingMatchId,
      businessId,
      status: "PENDING",
    },
  });

  if (!pending) {
    throw new Error("Pending match not found");
  }

  const metadata = pending.metadata as PendingMatchMetadata;

  // 🔥 יצירת movement רק דרך service
  await inventoryService.removeStock({
    businessId,
    itemId,
    quantityDelta: metadata.quantity,
    reason: "SALE",
    createdByUserId: userId,
  });

  return prisma.$transaction(async (tx) => {
    // 🔥 עכשיו האירוע נחשב processed
    await tx.inventoryExternalSale.create({
      data: {
        businessId,
        externalSaleId: pending.externalSaleId,
        source: metadata.source || "POS",
      },
    });

    await tx.inventoryPendingMatch.update({
      where: { id: pending.id },
      data: {
        status: "RESOLVED",
        resolvedAt: new Date(),
        resolvedByUserId: userId,
        resolvedItemId: itemId,
      },
    });

    // 🔥 סגירת Alert לפי קשר אמיתי
    await tx.inventoryAlert.updateMany({
      where: {
        pendingMatchId: pending.id,
        isResolved: false,
      },
      data: {
        isResolved: true,
      },
    });

    return {
      success: true,
      pendingMatchId,
      resolvedItemId: itemId,
    };
  });
}

type ResolveWithNewItemInput = {
  pendingMatchId: number;
  businessId: number;
  userId: number;
  itemData: {
    name: string;
    unitType: string;
    minimumQuantity?: number;
    reorderPoint?: number | null;
    costPerUnit?: number | null;
    sellPricePerUnit?: number | null;
    sku?: string | null;
    barcode?: string | null;
  };
};

export async function resolvePendingMatchWithNewItem(
  input: ResolveWithNewItemInput
) {
  const { pendingMatchId, businessId, userId, itemData } = input;

  const pending = await prisma.inventoryPendingMatch.findFirst({
    where: {
      id: pendingMatchId,
      businessId,
      status: "PENDING",
    },
  });

  if (!pending) {
    throw new Error("Pending match not found");
  }

  const item = await prisma.inventoryItem.create({
    data: {
      businessId,
      name: itemData.name,
      unitType: itemData.unitType as any,
      currentQuantity: 0,
      minimumQuantity: itemData.minimumQuantity ?? 0,
      reorderPoint: itemData.reorderPoint ?? 0,
      costPerUnit: itemData.costPerUnit ?? 0,
      sellPricePerUnit: itemData.sellPricePerUnit ?? 0,
      sku: itemData.sku ?? null,
      barcode: itemData.barcode ?? null,
    },
  });

  return resolvePendingMatchWithExistingItem({
    pendingMatchId,
    businessId,
    userId,
    itemId: item.id,
  });
}

export async function rejectPendingMatch(input: {
  pendingMatchId: number;
  businessId: number;
  userId: number;
}) {
  const { pendingMatchId, businessId, userId } = input;

  return prisma.$transaction(async (tx) => {
    const pending = await tx.inventoryPendingMatch.findUnique({
      where: { id: pendingMatchId },
    });

    if (!pending || pending.businessId !== businessId) {
      throw new Error("Pending match not found");
    }

    if (pending.status !== "PENDING") {
      throw new Error("Pending match already handled");
    }

    await tx.inventoryPendingMatch.update({
      where: { id: pendingMatchId },
      data: {
        status: "REJECTED",
        resolvedAt: new Date(),
        resolvedByUserId: userId,
      },
    });

    // 🔥 סגירת Alert לפי קשר אמיתי
    await tx.inventoryAlert.updateMany({
      where: {
        pendingMatchId: pending.id,
        isResolved: false,
      },
      data: {
        isResolved: true,
      },
    });

    return {
      success: true,
      pendingMatchId,
      status: "REJECTED",
    };
  });
}