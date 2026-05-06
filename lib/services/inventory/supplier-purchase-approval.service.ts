import {
  InventoryMovementReason,
  SupplierLineDecision,
  SupplierLineStatus,
  SupplierPurchaseDraftStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { inventoryService } from "@/lib/services/inventory/inventory.service";

type ApproveSupplierPurchaseInput = {
  draftId: number;
  businessId: number;
  userId: number;
  lines: Array<
    | {
        lineId: number;
        action: "MERGE";
        itemId: number;
      }
    | {
        lineId: number;
        action: "CREATE_NEW";
        itemData: {
          name: string;
          unitType: string;
          sku?: string | null;
          barcode?: string | null;
        };
      }
  >;
};

export async function approveSupplierPurchase(
  input: ApproveSupplierPurchaseInput
) {
  const { draftId, businessId, userId, lines } = input;

  return prisma.$transaction(async (tx) => {
    // Atomic transition: only one concurrent approval can win.
    const transition = await tx.supplierPurchaseDraft.updateMany({
      where: {
        id: draftId,
        businessId,
        status: SupplierPurchaseDraftStatus.PENDING_REVIEW,
      },
      data: {
        status: SupplierPurchaseDraftStatus.APPROVED,
      },
    });

    if (transition.count !== 1) {
      throw new Error("Draft already processed");
    }

    const draft = await tx.supplierPurchaseDraft.findFirst({
      where: {
        id: draftId,
        businessId,
      },
      include: {
        lines: true,
      },
    });

    if (!draft) {
      throw new Error("Supplier draft not found");
    }

    // 🔒 חייבים לקבל החלטה על כל שורה
    if (lines.length !== draft.lines.length) {
      throw new Error("All lines must be resolved before approval");
    }

    const lineMap = new Map(lines.map((l) => [l.lineId, l]));

    for (const draftLine of draft.lines) {
      const inputLine = lineMap.get(draftLine.id);

      if (!inputLine) {
        throw new Error(`Missing decision for line ${draftLine.id}`);
      }

      if (
        inputLine.action === "MERGE" &&
        (!inputLine.itemId || Number.isNaN(inputLine.itemId))
      ) {
        throw new Error(`Invalid itemId for MERGE on line ${draftLine.id}`);
      }

      if (inputLine.action === "CREATE_NEW") {
        if (!inputLine.itemData?.name || !inputLine.itemData?.unitType) {
          throw new Error(
            `Missing itemData for CREATE_NEW on line ${draftLine.id}`
          );
        }
      }
    }

    // 🔒 עיבוד בפועל (all DB + movements within same transaction)
    for (const draftLine of draft.lines) {
      const inputLine = lineMap.get(draftLine.id)!;

      // ===== MERGE =====
      if (inputLine.action === "MERGE") {
        await inventoryService.addStock(
          {
            businessId,
            itemId: inputLine.itemId,
            quantityDelta: draftLine.quantity,
            reason: InventoryMovementReason.SUPPLIER_PURCHASE,
            createdByUserId: userId,
          },
          { tx }
        );

        await tx.supplierPurchaseDraftLine.update({
          where: { id: draftLine.id },
          data: {
            decision: SupplierLineDecision.MERGE,
            matchedItemId: inputLine.itemId,
            status: SupplierLineStatus.APPROVED,
          },
        });
      }

      // ===== CREATE NEW =====
      if (inputLine.action === "CREATE_NEW") {
        const createdItem = await inventoryService.createItemWithInitialStock(
          {
            businessId,
            name: inputLine.itemData.name,
            unitType: inputLine.itemData.unitType as any,
            initialQuantity: draftLine.quantity,
            minimumQuantity: 0,
            reorderPoint: 0,
            sku: inputLine.itemData.sku ?? undefined,
            barcode: inputLine.itemData.barcode ?? undefined,
            createdByUserId: userId,
          },
          { tx }
        );

        await tx.supplierPurchaseDraftLine.update({
          where: { id: draftLine.id },
          data: {
            decision: SupplierLineDecision.CREATE_NEW,
            matchedItemId: createdItem.id,
            status: SupplierLineStatus.APPROVED,
          },
        });
      }
    }

    await tx.supplierPurchaseDraft.update({
      where: { id: draft.id },
      data: {
        approvedAt: new Date(),
      },
    });

    return {
      success: true,
      draftId: draft.id,
    };
  });
}