import { PrismaClient, InventoryAlertType, InventoryMovementReason } from "@prisma/client";

const prisma = new PrismaClient();

type CheckAlertsInput = {
  businessId: number;
  itemId: number;
  itemName: string;
  currentQuantity: number;
  minimumQuantity: number;
  reorderPoint: number | null;
  reason?: InventoryMovementReason;
};

export async function checkInventoryAlerts(input: CheckAlertsInput, tx: PrismaClient) {
  const {
    businessId,
    itemId,
    itemName,
    currentQuantity,
    minimumQuantity,
    reorderPoint,
    reason,
  } = input;

  // 🔴 CRITICAL STOCK
  if (minimumQuantity !== null && currentQuantity <= minimumQuantity) {
    const existing = await tx.inventoryAlert.findFirst({
      where: {
        businessId,
        itemId,
        type: InventoryAlertType.CRITICAL_STOCK,
        isResolved: false,
      },
    });

    if (!existing) {
      await tx.inventoryAlert.create({
        data: {
          businessId,
          itemId,
          type: InventoryAlertType.CRITICAL_STOCK,
          message: `מלאי קריטי: ${itemName}`,
        },
      });
    }

    return; // אם קריטי – לא ממשיכים
  }

  // 🟠 LOW STOCK
  if (reorderPoint !== null && currentQuantity <= reorderPoint) {
    const existing = await tx.inventoryAlert.findFirst({
      where: {
        businessId,
        itemId,
        type: InventoryAlertType.LOW_STOCK,
        isResolved: false,
      },
    });

    if (!existing) {
      await tx.inventoryAlert.create({
        data: {
          businessId,
          itemId,
          type: InventoryAlertType.LOW_STOCK,
          message: `מלאי נמוך: ${itemName}`,
        },
      });
    }
  }

  // ⚠️ SUSPICIOUS CORRECTION
  if (
    reason === InventoryMovementReason.INVENTORY_COUNT_CORRECTION ||
    reason === InventoryMovementReason.MANUAL_REMOVE
  ) {
    const existing = await tx.inventoryAlert.findFirst({
      where: {
        businessId,
        itemId,
        type: InventoryAlertType.SUSPICIOUS_CORRECTION,
        isResolved: false,
      },
    });

    if (!existing) {
      await tx.inventoryAlert.create({
        data: {
          businessId,
          itemId,
          type: InventoryAlertType.SUSPICIOUS_CORRECTION,
          message: `תיקון/הפחתה חשודה במלאי: ${itemName}`,
        },
      });
    }
  }
}