import {
  PurchaseOrderStatus,
  SupplierLineDecision,
  SupplierLineStatus,
  SupplierPurchaseDraftStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { inventoryService } from "@/lib/services/inventory/inventory.service";
import { purchaseOrderService } from "@/lib/services/inventory/purchase-order.service";
import { receivingService } from "@/lib/services/inventory/receiving.service";
import {
  ensureSupplierProductTx,
  learnRepresentationMappingTx,
  lookupEffectiveMeasureTx,
  resolveSupplierIdByNameTx,
} from "@/lib/services/inventory/supplier-identity-learning.service";
import {
  effectiveFactor,
  toStockQuantity,
  toStockUnitCost,
} from "@/lib/services/inventory/measure-conversion.service";

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

const APPROVAL_TRANSACTION_OPTIONS = { timeout: 15_000 };

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
    // Resolve the supplier ROW once (find-or-create by name) — used by Phase 3 to
    // read the learned Measure factor and by Phase 2 to hang the SupplierProduct.
    // null when the draft has no supplier name → 1:1 conversion + no learning.
    const supplierId = await resolveSupplierIdByNameTx(tx, {
      businessId,
      supplierName: draft.supplierName,
    });

    const plannedLines: Array<{
      draftLineId: number;
      itemId: number;
      decision: SupplierLineDecision;
      // Phase 3 — converted to STOCK units via the learned Measure factor.
      purchaseQty: number;
      stockQty: number;
      stockUnitCost: number | null;
      purchaseUnitName: string | null;
      conversionFactor: number;
    }> = [];

    for (const draftLine of draft.lines) {
      const inputLine = lineMap.get(draftLine.id)!;

      let itemId: number;
      let decision: SupplierLineDecision;
      if (inputLine.action === "MERGE") {
        itemId = inputLine.itemId;
        decision = SupplierLineDecision.MERGE;
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
        itemId = createdItem.id;
        decision = SupplierLineDecision.CREATE_NEW;
      }

      // 🔒 Phase 3 — Measure: translate the supplier's purchase-unit qty/cost into
      // Dubiz stock-units using the learned factor (1:1 when no factor is known).
      // Read-only; Measure NEVER moves stock — only Receiving (below) does.
      const measure = supplierId
        ? await lookupEffectiveMeasureTx(tx, {
            businessId,
            supplierId,
            externalSku: draftLine.sku,
            barcode: draftLine.barcode,
            rawName: draftLine.rawName,
          })
        : null;
      const factor = measure?.factor ?? null;
      const purchaseQty = draftLine.quantity;

      plannedLines.push({
        draftLineId: draftLine.id,
        itemId,
        decision,
        purchaseQty,
        stockQty: toStockQuantity(purchaseQty, factor),
        stockUnitCost: toStockUnitCost(draftLine.unitCost ?? null, factor),
        purchaseUnitName: measure?.purchaseUnitName ?? null,
        conversionFactor: effectiveFactor(factor),
      });
    }

    // 🔒 Intent: PurchaseOrder (עם traceability ל־draft).
    const purchaseOrder = await purchaseOrderService.createPurchaseOrder(
      {
        businessId,
        createdByUserId: userId,
        supplierName: draft.supplierName,
        externalOrderId: draft.externalOrderId,
        source: draft.source,
        orderDate: draft.orderDate,
        status: PurchaseOrderStatus.CONFIRMED,
        sourceSupplierPurchaseDraftId: draft.id,
        lines: plannedLines.map((line) => ({
          itemId: line.itemId,
          orderedQty: line.stockQty,
          unitCost: line.stockUnitCost,
          purchaseUnitName: line.purchaseUnitName,
          purchaseQty: line.purchaseQty,
          conversionFactor: line.conversionFactor,
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
          receivedQty: line.stockQty,
          unitCost: line.stockUnitCost,
          purchaseUnitName: line.purchaseUnitName,
          receivedPurchaseQty: line.purchaseQty,
          conversionFactor: line.conversionFactor,
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

    // 🔒 Supplier Domain Phase 2 — Identity Learning (additive, append-only).
    // The MERGE/CREATE_NEW decision above IS the human resolution act; here we
    // persist it as a reusable, corrigible Identity link. Two writes per line:
    // ensureSupplierProduct (Reported Reality) + learnRepresentationMapping
    // (HUMAN_CONFIRMED / KNOWN). Precondition-guarded — absence of supplier or
    // product identity degrades to "no mapping"; learning NEVER blocks approval,
    // never writes InventoryItem, and carries no price / Measure here.
    if (supplierId !== null) {
      const draftLineById = new Map(draft.lines.map((l) => [l.id, l]));

      for (const line of plannedLines) {
        const draftLine = draftLineById.get(line.draftLineId);
        if (!draftLine) continue;

        const source = `draft:${draft.id}:line:${draftLine.id}`;

        const ensured = await ensureSupplierProductTx(tx, {
          businessId,
          supplierId,
          externalSku: draftLine.sku,
          barcode: draftLine.barcode,
          rawName: draftLine.rawName,
          source,
        });

        // No stable supplier-product identity on this line → no mapping.
        if (!ensured) continue;

        await learnRepresentationMappingTx(tx, {
          businessId,
          supplierProductId: ensured.id,
          inventoryItemId: line.itemId,
          identitySignal: ensured.identitySignal,
          source,
          resolvedByUserId: userId,
        });

        // Optional forward-link for traceability (Draft → learned identity).
        await tx.supplierPurchaseDraftLine.update({
          where: { id: draftLine.id },
          data: { supplierProductId: ensured.id },
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
  }, APPROVAL_TRANSACTION_OPTIONS);
}
