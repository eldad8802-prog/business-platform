import { InventoryUnitType, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { inventoryService } from "@/lib/services/inventory/inventory.service";
import { resolvePendingMatchWithExistingItem } from "@/lib/services/inventory/pending-match.service";

type TxOptions = { tx?: Prisma.TransactionClient };

type CreateItemFromInsightInput = {
  businessId: number;
  userId: number;
  key: string;
};

type LinkExistingFromInsightInput = {
  businessId: number;
  userId: number;
  key: string;
  itemId: number;
};

function getPendingKey(metadata: any): string {
  return metadata?.sku || metadata?.barcode || metadata?.name || "UNKNOWN";
}

function getPendingQuantity(metadata: any): number {
  const quantity = Number(metadata?.quantity);
  return Number.isFinite(quantity) && quantity > 0 ? quantity : 0;
}

async function getMatchingPendingMatches(
  businessId: number,
  key: string,
  options?: TxOptions
) {
  const db = options?.tx ?? prisma;
  const normalizedKey = key.trim();

  const pendingMatches = await db.inventoryPendingMatch.findMany({
    where: {
      businessId,
      status: "PENDING",
    },
    orderBy: {
      createdAt: "asc",
    },
  });

  return pendingMatches.filter((pending) => {
    const metadata = pending.metadata as any;
    return getPendingKey(metadata) === normalizedKey;
  });
}

export const inventoryInsightActionService = {
  async createItemFromInsight(
    input: CreateItemFromInsightInput,
    options?: TxOptions
  ) {
    const { businessId, userId, key } = input;

    if (!businessId || Number.isNaN(businessId)) {
      throw new Error("Invalid business id");
    }

    if (!userId || Number.isNaN(userId)) {
      throw new Error("Invalid user id");
    }

    if (!key?.trim()) {
      throw new Error("Insight key is required");
    }

    const normalizedKey = key.trim();
    const matchingPendingMatches = await getMatchingPendingMatches(
      businessId,
      normalizedKey,
      options
    );

    if (matchingPendingMatches.length === 0) {
      throw new Error("No pending matches found for this insight");
    }

    const totalQuantity = matchingPendingMatches.reduce((sum, pending) => {
      const metadata = pending.metadata as any;
      return sum + getPendingQuantity(metadata);
    }, 0);

    if (totalQuantity <= 0) {
      throw new Error("Pending matches have no valid quantity");
    }

    const firstMetadata = matchingPendingMatches[0].metadata as any;

    const item = await inventoryService.createItemWithInitialStock({
      businessId,
      name:
        firstMetadata?.name ||
        firstMetadata?.sku ||
        firstMetadata?.barcode ||
        normalizedKey,
      unitType: InventoryUnitType.UNIT,
      initialQuantity: totalQuantity,
      minimumQuantity: 0,
      reorderPoint: undefined,
      costPerUnit: undefined,
      sellPricePerUnit: undefined,
      sku: firstMetadata?.sku || normalizedKey,
      barcode: firstMetadata?.barcode || undefined,
      createdByUserId: userId,
    }, options);

    const resolved = [];

    for (const pending of matchingPendingMatches) {
      const result = await resolvePendingMatchWithExistingItem(
        {
          pendingMatchId: pending.id,
          businessId,
          userId,
          itemId: item.id,
        },
        options
      );

      resolved.push(result);
    }

    return {
      success: true,
      action: "CREATE_ITEM_FROM_INSIGHT",
      key: normalizedKey,
      item,
      resolvedCount: resolved.length,
      resolved,
    };
  },

  async linkExistingFromInsight(
    input: LinkExistingFromInsightInput,
    options?: TxOptions
  ) {
    const { businessId, userId, key, itemId } = input;

    if (!businessId || Number.isNaN(businessId)) {
      throw new Error("Invalid business id");
    }

    if (!userId || Number.isNaN(userId)) {
      throw new Error("Invalid user id");
    }

    if (!key?.trim()) {
      throw new Error("Insight key is required");
    }

    if (!itemId || Number.isNaN(itemId)) {
      throw new Error("Invalid item id");
    }

    const normalizedKey = key.trim();
    const db = options?.tx ?? prisma;

    const item = await db.inventoryItem.findFirst({
      where: {
        id: itemId,
        businessId,
        isActive: true,
      },
    });

    if (!item) {
      throw new Error("Inventory item not found");
    }

    const matchingPendingMatches = await getMatchingPendingMatches(
      businessId,
      normalizedKey,
      options
    );

    if (matchingPendingMatches.length === 0) {
      throw new Error("No pending matches found for this insight");
    }

    const resolved = [];

    for (const pending of matchingPendingMatches) {
      const result = await resolvePendingMatchWithExistingItem(
        {
          pendingMatchId: pending.id,
          businessId,
          userId,
          itemId: item.id,
        },
        options
      );

      resolved.push(result);
    }

    return {
      success: true,
      action: "LINK_EXISTING_FROM_INSIGHT",
      key: normalizedKey,
      item,
      resolvedCount: resolved.length,
      resolved,
    };
  },
};