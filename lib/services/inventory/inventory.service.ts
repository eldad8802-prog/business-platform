import { prisma } from "@/lib/prisma";
import { tenantTx } from "@/lib/tenant/tenant-tx";
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

    if (initialQuantity < 0) {
      throw new NegativeInventoryError();
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

    return tenantTx(businessId, run);
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

    return tenantTx(businessId, run);
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