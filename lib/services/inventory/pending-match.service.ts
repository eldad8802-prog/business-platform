import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { inventoryService } from "@/lib/services/inventory/inventory.service";

type Tx = Prisma.TransactionClient;
type TxOptions = { tx?: Tx };

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

export async function createPendingMatch(
  input: CreatePendingMatchInput,
  options?: TxOptions
) {
  const { businessId, externalSaleId, metadata } = input;

  const run = async (tx: Tx) => {
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
  };

  if (options?.tx) {
    return run(options.tx);
  }
  return tenantTx(businessId, run);
}

export async function getOpenPendingMatches(
  businessId: number,
  options?: TxOptions
) {
  const db = options?.tx ?? prisma;
  return db.inventoryPendingMatch.findMany({
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
  input: ResolveWithExistingItemInput,
  options?: TxOptions
) {
  const { pendingMatchId, businessId, userId, itemId } = input;
  const db = options?.tx ?? prisma;

  const pending = await db.inventoryPendingMatch.findFirst({
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

  // 🔥 יצירת movement רק דרך service (על אותו tx כשסופק)
  await inventoryService.removeStock(
    {
      businessId,
      itemId,
      quantityDelta: metadata.quantity,
      reason: "SALE",
      createdByUserId: userId,
    },
    options
  );

  const run = async (tx: Tx) => {
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

    const src = (metadata.source?.trim() || "POS").trim();
    const skuNorm = metadata.sku?.trim() || null;
    const barcodeNorm = metadata.barcode?.trim() || null;

    if (skuNorm || barcodeNorm) {
      let existingMapping = null as {
        id: number;
        sku: string | null;
        barcode: string | null;
        name: string | null;
      } | null;

      if (skuNorm) {
        existingMapping = await tx.pOSProductMapping.findFirst({
          where: {
            businessId,
            source: src,
            sku: skuNorm,
          },
          select: { id: true, sku: true, barcode: true, name: true },
        });
      }

      if (!existingMapping && barcodeNorm) {
        existingMapping = await tx.pOSProductMapping.findFirst({
          where: {
            businessId,
            source: src,
            barcode: barcodeNorm,
          },
          select: { id: true, sku: true, barcode: true, name: true },
        });
      }

      if (existingMapping) {
        await tx.pOSProductMapping.update({
          where: { id: existingMapping.id },
          data: {
            itemId,
            ...(skuNorm ? { sku: skuNorm } : {}),
            ...(barcodeNorm ? { barcode: barcodeNorm } : {}),
            ...(metadata.name != null && metadata.name !== ""
              ? { name: metadata.name }
              : {}),
          },
        });
      } else {
        await tx.pOSProductMapping.create({
          data: {
            businessId,
            source: src,
            itemId,
            sku: skuNorm,
            barcode: barcodeNorm,
            name: metadata.name ?? null,
            externalProductId: null,
          },
        });
      }
    }

    return {
      success: true,
      pendingMatchId,
      resolvedItemId: itemId,
    };
  };

  if (options?.tx) {
    return run(options.tx);
  }
  return tenantTx(businessId, run);
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
  input: ResolveWithNewItemInput,
  options?: TxOptions
) {
  const { pendingMatchId, businessId, userId, itemData } = input;
  const db = options?.tx ?? prisma;

  const pending = await db.inventoryPendingMatch.findFirst({
    where: {
      id: pendingMatchId,
      businessId,
      status: "PENDING",
    },
  });

  if (!pending) {
    throw new Error("Pending match not found");
  }

  const item = await db.inventoryItem.create({
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

  return resolvePendingMatchWithExistingItem(
    {
      pendingMatchId,
      businessId,
      userId,
      itemId: item.id,
    },
    options
  );
}

export async function rejectPendingMatch(
  input: {
    pendingMatchId: number;
    businessId: number;
    userId: number;
  },
  options?: TxOptions
) {
  const { pendingMatchId, businessId, userId } = input;

  const run = async (tx: Tx) => {
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
  };

  if (options?.tx) {
    return run(options.tx);
  }
  return tenantTx(businessId, run);
}