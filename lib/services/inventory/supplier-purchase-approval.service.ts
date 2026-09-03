import {
  PurchaseOrderStatus,
  SupplierLineDecision,
  SupplierLineStatus,
  SupplierPurchaseDraftStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import type { TenantTx } from "@/lib/tenant/transaction";
import { inventoryService } from "@/lib/services/inventory/inventory.service";
import { purchaseOrderService } from "@/lib/services/inventory/purchase-order.service";
import { receivingService } from "@/lib/services/inventory/receiving.service";

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

const APPROVAL_TRANSACTION_OPTIONS = { timeout: 30_000 };

// The canonical tenant transaction client type. Previously derived from
// `typeof prisma.$transaction`, which made this file textually indistinguishable
// from a real bare transaction; the canonical alias says what it means.
type Tx = TenantTx;
type TxOptions = { tx?: Tx };

export async function approveSupplierPurchase(
  input: ApproveSupplierPurchaseInput,
  options?: TxOptions
) {
  const { draftId, businessId, userId, lines } = input;

  const run = async (tx: Tx) => {
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

    // 🔒 ולידציה לכל שורה — כל action שאינו MERGE/CREATE_NEW נכשל ומגלגל אחורה.
    for (const draftLine of draft.lines) {
      const inputLine = lineMap.get(draftLine.id);

      if (!inputLine) {
        throw new Error(`Missing decision for line ${draftLine.id}`);
      }

      if (inputLine.action === "MERGE") {
        if (!inputLine.itemId || Number.isNaN(inputLine.itemId)) {
          throw new Error(`Invalid itemId for MERGE on line ${draftLine.id}`);
        }
      } else if (inputLine.action === "CREATE_NEW") {
        if (!inputLine.itemData?.name || !inputLine.itemData?.unitType) {
          throw new Error(
            `Missing itemData for CREATE_NEW on line ${draftLine.id}`
          );
        }
      } else {
        throw new Error(
          `Unsupported action for line ${draftLine.id}: only MERGE or CREATE_NEW are allowed`
        );
      }
    }

    // 🔒 MERGE targets must exist, belong to the business, and be active.
    const mergeItemIds = Array.from(
      new Set(
        lines
          .filter((l): l is Extract<typeof l, { action: "MERGE" }> =>
            l.action === "MERGE"
          )
          .map((l) => l.itemId)
      )
    );

    if (mergeItemIds.length > 0) {
      const activeItems = await tx.inventoryItem.findMany({
        where: {
          businessId,
          id: { in: mergeItemIds },
          isActive: true,
        },
        select: { id: true },
      });
      const activeItemIds = new Set(activeItems.map((item) => item.id));

      for (const itemId of mergeItemIds) {
        if (!activeItemIds.has(itemId)) {
          throw new Error(
            `MERGE item ${itemId} is not available (must exist, belong to the business, and be active)`
          );
        }
      }
    }

    // 🔒 בניית שורות ה־PO תוך שמירה על סדר השורות של ה־draft.
    // CREATE_NEW יוצר פריט עם מלאי 0 בלבד — שום תנועת INITIAL_STOCK.
    const plannedLines: Array<{
      draftLineId: number;
      itemId: number;
      quantity: number;
      unitCost: number | null;
      decision: SupplierLineDecision;
    }> = [];

    for (const draftLine of draft.lines) {
      const inputLine = lineMap.get(draftLine.id)!;

      if (inputLine.action === "MERGE") {
        plannedLines.push({
          draftLineId: draftLine.id,
          itemId: inputLine.itemId,
          quantity: draftLine.quantity,
          unitCost: draftLine.unitCost,
          decision: SupplierLineDecision.MERGE,
        });
      } else {
        const createdItem = await inventoryService.createItemWithInitialStock(
          {
            businessId,
            name: inputLine.itemData.name,
            unitType: inputLine.itemData.unitType as any,
            initialQuantity: 0,
            minimumQuantity: 0,
            reorderPoint: 0,
            sku: inputLine.itemData.sku ?? undefined,
            barcode: inputLine.itemData.barcode ?? undefined,
            createdByUserId: userId,
          },
          { tx }
        );

        plannedLines.push({
          draftLineId: draftLine.id,
          itemId: createdItem.id,
          quantity: draftLine.quantity,
          unitCost: draftLine.unitCost,
          decision: SupplierLineDecision.CREATE_NEW,
        });
      }
    }

    // 🔒 Intent: PurchaseOrder (עם traceability ל־draft).
    const purchaseOrder = await purchaseOrderService.createPurchaseOrder(
      {
        businessId,
        createdByUserId: userId,
        // Entity-FK carried straight through from the draft. The PO service
        // re-verifies it tenant-scoped and re-derives the name snapshot, so a
        // supplier renamed between drafting and approval still resolves to the
        // same identity. Null stays null — approval never GUESSES a supplier
        // from the name string.
        supplierId: draft.supplierId,
        supplierName: draft.supplierName,
        externalOrderId: draft.externalOrderId,
        source: draft.source,
        orderDate: draft.orderDate,
        status: PurchaseOrderStatus.CONFIRMED,
        sourceSupplierPurchaseDraftId: draft.id,
        lines: plannedLines.map((line) => ({
          itemId: line.itemId,
          orderedQty: line.quantity,
          unitCost: line.unitCost,
        })),
      },
      { tx }
    );

    // createPurchaseOrder מחזיר שורות בסדר id עולה = סדר היצירה = סדר plannedLines.
    if (purchaseOrder.lines.length !== plannedLines.length) {
      throw new Error("Purchase order line count mismatch");
    }

    // 🔒 Reality: ReceivingSession(DRAFT) לכל הכמות שהוזמנה.
    const receivingSession = await receivingService.createReceivingSession(
      {
        businessId,
        purchaseOrderId: purchaseOrder.id,
        createdByUserId: userId,
        lines: plannedLines.map((line, index) => ({
          purchaseOrderLineId: purchaseOrder.lines[index].id,
          receivedQty: line.quantity,
          unitCost: line.unitCost,
        })),
      },
      { tx }
    );

    // 🔒 Result: POSTED — הכניסה החוקית היחידה למלאי.
    await receivingService.postReceivingSession(
      {
        businessId,
        receivingSessionId: receivingSession.id,
        postedByUserId: userId,
      },
      { tx }
    );

    // שמירת ההחלטה על כל שורת draft (תאימות ל־UI/היסטוריה קיימים).
    for (const line of plannedLines) {
      await tx.supplierPurchaseDraftLine.update({
        where: { id: line.draftLineId },
        data: {
          decision: line.decision,
          matchedItemId: line.itemId,
          status: SupplierLineStatus.APPROVED,
        },
      });
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
  };

  if (options?.tx) {
    return run(options.tx);
  }
  return tenantTx(businessId, run, { timeoutMs: APPROVAL_TRANSACTION_OPTIONS.timeout });
}
