import { prisma } from "@/lib/prisma";
import {
  InventoryAlertType,
  InventoryMovementReason,
  InventoryMovementType,
  Prisma,
} from "@prisma/client";
import {
  CreateInventoryItemInput,
  CreateInventoryMovementInput,
  AddInventoryStockInput,
  RemoveInventoryStockInput,
} from "./inventory.types";
import {
  InventoryNotFoundError,
  InventoryUnauthorizedError,
  InventoryValidationError,
  NegativeInventoryError,
} from "./inventory.errors";

type Tx = Prisma.TransactionClient;
type TxOptions = { tx?: Tx };

class InventoryService {
  async createItemWithInitialStock(
    input: CreateInventoryItemInput,
    options?: TxOptions
  ) {
    const {
      businessId,
      name,
      unitType,
      supplierName,
      initialQuantity = 0,
      minimumQuantity = 0,
      reorderPoint,
      costPerUnit,
      sellPricePerUnit,
      sku,
      barcode,
      imageUrl,
      createdByUserId,

      // 🔥 חדש
      categoryId,
    } = input;

    if (!businessId || Number.isNaN(businessId)) {
      throw new InventoryUnauthorizedError("Invalid business id");
    }

    if (!name?.trim()) {
      throw new InventoryValidationError("Item name is required");
    }

    if (!Number.isFinite(initialQuantity) || initialQuantity < 0) {
      throw new NegativeInventoryError();
    }

    if (!Number.isFinite(minimumQuantity) || minimumQuantity < 0) {
      throw new InventoryValidationError("minimumQuantity must be 0 or greater");
    }

    if (reorderPoint !== undefined && reorderPoint !== null && (!Number.isFinite(reorderPoint) || reorderPoint < 0)) {
      throw new InventoryValidationError("reorderPoint must be 0 or greater");
    }

    // Reorder point is the "low/reorder" threshold and must sit at or above the
    // critical minimum — you reorder before hitting the critical floor, never
    // below it. (audit P1 #4)
    if (
      reorderPoint !== undefined &&
      reorderPoint !== null &&
      reorderPoint < minimumQuantity
    ) {
      throw new InventoryValidationError(
        "reorderPoint must be greater than or equal to minimumQuantity"
      );
    }

    if (costPerUnit !== undefined && costPerUnit !== null && (!Number.isFinite(costPerUnit) || costPerUnit < 0)) {
      throw new InventoryValidationError("costPerUnit must be 0 or greater");
    }

    if (sellPricePerUnit !== undefined && sellPricePerUnit !== null && (!Number.isFinite(sellPricePerUnit) || sellPricePerUnit < 0)) {
      throw new InventoryValidationError("sellPricePerUnit must be 0 or greater");
    }

    const run = async (tx: Tx) => {
      const item = await tx.inventoryItem.create({
        data: {
          businessId,
          name: name.trim(),
          unitType,
          supplierName: supplierName?.trim() || null,
          currentQuantity: initialQuantity,
          minimumQuantity,
          reorderPoint,
          costPerUnit,
          sellPricePerUnit,
          sku: sku?.trim() || null,
          barcode: barcode?.trim() || null,
          imageUrl: imageUrl?.trim() || null,

          // 🔥 חדש
          categoryId: categoryId ?? null,
        },
      });

      if (initialQuantity > 0) {
        await tx.inventoryMovement.create({
          data: {
            businessId,
            itemId: item.id,
            movementType: InventoryMovementType.IN,
            reason: InventoryMovementReason.INITIAL_STOCK,
            quantityDelta: initialQuantity,
            quantityBefore: 0,
            quantityAfter: initialQuantity,
            createdByUserId,
          },
        });
      }

      return item;
    };

    if (options?.tx) {
      return run(options.tx);
    }

    return prisma.$transaction(run);
  }

  async createMovement(input: CreateInventoryMovementInput, options?: TxOptions) {
    const {
      businessId,
      itemId,
      movementType,
      reason,
      quantityDelta,
      note,
      createdByUserId,
    } = input;

    if (!businessId || Number.isNaN(businessId)) {
      throw new InventoryUnauthorizedError();
    }

    if (!itemId || Number.isNaN(itemId)) {
      throw new InventoryValidationError("Invalid item id");
    }

    if (quantityDelta === 0) {
      throw new InventoryValidationError("quantityDelta cannot be zero");
    }

    const run = async (tx: Tx) => {
      const item = await tx.inventoryItem.findUnique({
        where: { id: itemId },
      });

      if (!item) {
        throw new InventoryNotFoundError();
      }

      if (item.businessId !== businessId) {
        throw new InventoryUnauthorizedError();
      }

      const quantityBefore = item.currentQuantity;
      const quantityAfter = quantityBefore + quantityDelta;

      if (quantityAfter < 0) {
        throw new NegativeInventoryError();
      }

      const movement = await tx.inventoryMovement.create({
        data: {
          businessId,
          itemId,
          movementType,
          reason,
          quantityDelta,
          quantityBefore,
          quantityAfter,
          note: note?.trim() || null,
          createdByUserId,
        },
      });

      await tx.inventoryItem.update({
        where: { id: itemId },
        data: {
          currentQuantity: quantityAfter,
        },
      });

      const openAlerts = await tx.inventoryAlert.findMany({
        where: {
          businessId,
          itemId,
          isResolved: false,
        },
      });

      if (
        item.minimumQuantity !== null &&
        quantityAfter <= item.minimumQuantity
      ) {
        const existingCritical = openAlerts.find(
          (a) => a.type === InventoryAlertType.CRITICAL_STOCK
        );

        if (!existingCritical) {
          await tx.inventoryAlert.create({
            data: {
              businessId,
              itemId,
              type: InventoryAlertType.CRITICAL_STOCK,
              message: `מלאי קריטי: ${item.name}`,
            },
          });
        }
      } else {
        await tx.inventoryAlert.updateMany({
          where: {
            businessId,
            itemId,
            type: InventoryAlertType.CRITICAL_STOCK,
            isResolved: false,
          },
          data: { isResolved: true },
        });
      }

      if (
        item.reorderPoint !== null &&
        quantityAfter > (item.minimumQuantity ?? 0) &&
        quantityAfter <= item.reorderPoint
      ) {
        const existingLow = openAlerts.find(
          (a) => a.type === InventoryAlertType.LOW_STOCK
        );

        if (!existingLow) {
          await tx.inventoryAlert.create({
            data: {
              businessId,
              itemId,
              type: InventoryAlertType.LOW_STOCK,
              message: `מלאי נמוך: ${item.name}`,
            },
          });
        }
      } else {
        await tx.inventoryAlert.updateMany({
          where: {
            businessId,
            itemId,
            type: InventoryAlertType.LOW_STOCK,
            isResolved: false,
          },
          data: { isResolved: true },
        });
      }

      return movement;
    };

    if (options?.tx) {
      return run(options.tx);
    }

    return prisma.$transaction(run);
  }

  async addStock(input: AddInventoryStockInput, options?: TxOptions) {
    const quantityDelta =
      input.quantityDelta < 0
        ? Math.abs(input.quantityDelta)
        : input.quantityDelta;

    return this.createMovement({
      ...input,
      quantityDelta,
      movementType: InventoryMovementType.IN,
    }, options);
  }

  async removeStock(input: RemoveInventoryStockInput, options?: TxOptions) {
    const quantityDelta =
      input.quantityDelta > 0
        ? -input.quantityDelta
        : input.quantityDelta;

    return this.createMovement({
      ...input,
      quantityDelta,
      movementType: InventoryMovementType.OUT,
    }, options);
  }
}

export const inventoryService = new InventoryService();
