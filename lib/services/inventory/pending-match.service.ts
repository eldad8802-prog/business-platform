import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { inventoryService } from "@/lib/services/inventory/inventory.service";
import { recordInventorySale } from "@/lib/services/inventory/sale-evidence.service";
import { unitPriceForResolvedPending } from "@/lib/services/inventory/sale-price";
import {
  linkSourceLinesToSale,
  recordInventorySourceSaleLines,
  type SourceSaleLineInput,
} from "@/lib/services/inventory/sale-source-lines.service";
import { recordSensor } from "@/lib/sensors/record-sensor";
import { MAX_STRING } from "@/lib/sensors/sensor.contract";

type Tx = Prisma.TransactionClient;
type TxOptions = { tx?: Tx };

/**
 * How the owner resolved a held POS line, for the sensor only. Linking to an
 * item that was created for this very purpose (new-item flow, insight "create")
 * is recorded as CREATE_NEW; it never changes what the resolution does.
 */
type ResolutionSensorOptions = TxOptions & {
  resolutionMode?: "LINK_EXISTING" | "CREATE_NEW";
};

function sensorExternalSaleId(value: string): string {
  return value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value;
}

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
    unitPrice?: string | null;
  }[];
};

type CreatePendingMatchInput = {
  businessId: number;
  externalSaleId: string;
  metadata: PendingMatchMetadata;
  sourceLines?: SourceSaleLineInput[];
};

export async function createPendingMatch(
  input: CreatePendingMatchInput,
  options?: TxOptions
) {
  const { businessId, externalSaleId, metadata, sourceLines } = input;

  const run = async (tx: Tx) => {
    if (sourceLines && sourceLines.length > 0) {
      await recordInventorySourceSaleLines(tx, {
        businessId,
        externalSaleId,
        lines: sourceLines,
      });
    }

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
  sensorOptions?: ResolutionSensorOptions
) {
  const { pendingMatchId, businessId, userId, itemId } = input;
  const resolutionMode = sensorOptions?.resolutionMode ?? "LINK_EXISTING";
  const options: TxOptions | undefined = sensorOptions
    ? { tx: sensorOptions.tx }
    : undefined;
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
  const source = metadata.source?.trim() || "POS";

  const run = async (tx: Tx) => {
    const alreadyProcessed = await tx.inventoryExternalSale.findUnique({
      where: {
        businessId_externalSaleId: {
          businessId,
          externalSaleId: pending.externalSaleId,
        },
      },
    });

    const sourceLines = await tx.inventorySourceSaleLine.findMany({
      where: { businessId, externalSaleId: pending.externalSaleId },
      orderBy: { lineKey: "asc" },
    });

    let movementId: number | undefined;

    if (!alreadyProcessed) {
      if (sourceLines.length > 1) {
        // Several upstream lines. Deduct the pending quantity the owner
        // chose, and do not claim each source line was this one item.
        const movement = await inventoryService.removeStock(
          {
            businessId,
            itemId,
            quantityDelta: metadata.quantity,
            reason: "SALE",
            createdByUserId: userId,
          },
          { tx }
        );
        await tx.inventoryExternalSale.create({
          data: {
            businessId,
            externalSaleId: pending.externalSaleId,
            source,
          },
        });
        movementId = movement.id;
      } else {
        const only = sourceLines[0];
        const unitPrice =
          only?.unitPrice != null
            ? only.unitPrice.toFixed(2)
            : unitPriceForResolvedPending(metadata);
        const recorded = await recordInventorySale({
          tx,
          businessId,
          source,
          externalSaleId: pending.externalSaleId,
          createdByUserId: userId,
          lines: [
            {
              itemId,
              quantity: metadata.quantity,
              unitPrice,
              lineKey: only?.lineKey ?? "0",
            },
          ],
        });
        movementId = recorded.movements[0]?.id;
        if (recorded.saleId > 0) {
          await linkSourceLinesToSale(tx, {
            businessId,
            externalSaleId: pending.externalSaleId,
            saleId: recorded.saleId,
          });
        }
      }
    }

    await tx.inventoryPendingMatch.update({
      where: { id: pending.id },
      data: {
        status: "RESOLVED",
        resolvedAt: new Date(),
        resolvedByUserId: userId,
        resolvedItemId: itemId,
        ...(movementId ? { resolvedMovementId: movementId } : {}),
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
        resolvedAt: new Date(),
      },
    });

    const src = (metadata.source?.trim() || "POS").trim();
    const skuNorm = metadata.sku?.trim() || null;
    const barcodeNorm = metadata.barcode?.trim() || null;
    let mappingReplaced = false;

    if (skuNorm || barcodeNorm) {
      let existingMapping = null as {
        id: number;
        itemId: number;
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
          select: { id: true, itemId: true, sku: true, barcode: true, name: true },
        });
      }

      if (!existingMapping && barcodeNorm) {
        existingMapping = await tx.pOSProductMapping.findFirst({
          where: {
            businessId,
            source: src,
            barcode: barcodeNorm,
          },
          select: { id: true, itemId: true, sku: true, barcode: true, name: true },
        });
      }

      if (existingMapping) {
        mappingReplaced = existingMapping.itemId !== itemId;
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

    // Truthful record of what this resolution did: the one movement it wrote
    // (for metadata.quantity, which is what this path decrements today).
    await recordSensor(
      {
        businessId,
        sensor: "POS_PENDING_MATCH_RESOLVED",
        entityId: pending.id,
        actor: { type: "OWNER_USER", userId },
        source: "OWNER_UI",
        payload: {
          mode: resolutionMode,
          externalSaleId: sensorExternalSaleId(pending.externalSaleId),
          movementIds: movementId ? [movementId] : [],
          mappingReplaced,
        },
        idempotencyKey: `pending-match:${pending.id}:resolved`,
      },
      { tx }
    );

    return {
      success: true,
      pendingMatchId,
      resolvedItemId: itemId,
    };
  };

  if (options?.tx) {
    return run(options.tx);
  }
  return tenantTx(businessId, run, { timeoutMs: 20_000 });
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

  await recordSensor(
    {
      businessId,
      sensor: "INVENTORY_ITEM_CREATED",
      entityId: item.id,
      actor: { type: "OWNER_USER", userId },
      source: "OWNER_UI",
      payload: { origin: "POS_MATCH", pendingMatchId: pending.id },
      idempotencyKey: `item:${item.id}:created`,
    },
    options?.tx ? { tx: options.tx } : undefined
  );

  return resolvePendingMatchWithExistingItem(
    {
      pendingMatchId,
      businessId,
      userId,
      itemId: item.id,
    },
    { tx: options?.tx, resolutionMode: "CREATE_NEW" }
  );
}

export async function rejectPendingMatch(
  input: {
    pendingMatchId: number;
    businessId: number;
    userId: number;
    /**
     * M5 — why the owner refused. Optional, as everywhere else an owner is asked for a reason:
     * requiring one produces "asdf" rather than understanding. But when it IS given it is the only
     * thing distinguishing "this product is not ours" from "we stopped stocking it", and those two
     * call for completely different behaviour the next time the same line arrives.
     */
    reason?: string | null;
  },
  options?: TxOptions
) {
  const { pendingMatchId, businessId, userId, reason } = input;

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
        rejectionReason: reason?.trim() ? reason.trim().slice(0, 500) : null,
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
        resolvedAt: new Date(),
      },
    });

    await recordSensor(
      {
        businessId,
        sensor: "POS_PENDING_MATCH_RESOLVED",
        entityId: pending.id,
        actor: { type: "OWNER_USER", userId },
        source: "OWNER_UI",
        payload: {
          mode: "REJECTED",
          externalSaleId: sensorExternalSaleId(pending.externalSaleId),
          movementIds: [],
          mappingReplaced: false,
        },
        idempotencyKey: `pending-match:${pending.id}:resolved`,
      },
      { tx }
    );

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