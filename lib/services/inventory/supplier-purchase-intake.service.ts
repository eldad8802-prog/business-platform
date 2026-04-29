import {
  InventoryUnitType,
  SupplierLineDecision,
  SupplierLineStatus,
  SupplierPurchaseDraftStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { findInventoryMatches } from "@/lib/services/inventory/inventory-matching.service";
import { decideInventoryAction } from "@/lib/services/inventory/inventory-decision.service";

type SupplierPurchaseLineInput = {
  rawName?: string | null;
  sku?: string | null;
  barcode?: string | null;
  quantity: number;
  unitType?: InventoryUnitType | null;
};

type CreateSupplierPurchaseDraftInput = {
  businessId: number;
  supplierName?: string | null;
  externalOrderId?: string | null;
  source?: string | null;
  orderDate?: Date | string | null;
  createdByUserId?: number | null;
  lines: SupplierPurchaseLineInput[];
};

function normalizeText(value?: string | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeQuantity(value: number): number {
  const quantity = Number(value);

  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error("Supplier purchase line quantity must be greater than zero");
  }

  return quantity;
}

function normalizeOrderDate(value?: Date | string | null): Date | null {
  if (!value) return null;

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid supplier purchase orderDate");
  }

  return date;
}

function mapDecisionToSupplierDecision(decision: any): SupplierLineDecision {
  const action =
    decision?.recommendedAction ||
    decision?.action ||
    decision?.type ||
    decision?.decision;

  if (action === "MERGE" || action === "LINK_EXISTING") {
    return SupplierLineDecision.MERGE;
  }

  if (action === "CREATE_NEW" || action === "CREATE") {
    return SupplierLineDecision.CREATE_NEW;
  }

  return SupplierLineDecision.REVIEW;
}

function mapDecisionToLineStatus(
  decision: SupplierLineDecision
): SupplierLineStatus {
  if (decision === SupplierLineDecision.MERGE) {
    return SupplierLineStatus.MATCHED;
  }

  if (decision === SupplierLineDecision.CREATE_NEW) {
    return SupplierLineStatus.NEEDS_REVIEW;
  }

  return SupplierLineStatus.NEEDS_REVIEW;
}

export async function createSupplierPurchaseDraft(
  input: CreateSupplierPurchaseDraftInput
) {
  const {
    businessId,
    supplierName,
    externalOrderId,
    source,
    orderDate,
    createdByUserId,
    lines,
  } = input;

  if (!businessId || Number.isNaN(businessId)) {
    throw new Error("Invalid business id");
  }

  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error("Supplier purchase must include at least one line");
  }

  const normalizedLines = lines.map((line) => ({
    rawName: normalizeText(line.rawName),
    sku: normalizeText(line.sku),
    barcode: normalizeText(line.barcode),
    quantity: normalizeQuantity(line.quantity),
    unitType: line.unitType ?? InventoryUnitType.UNIT,
  }));

  const draft = await prisma.supplierPurchaseDraft.create({
    data: {
      businessId,
      supplierName: normalizeText(supplierName),
      externalOrderId: normalizeText(externalOrderId),
      source: normalizeText(source) ?? "MANUAL",
      orderDate: normalizeOrderDate(orderDate),
      status: SupplierPurchaseDraftStatus.PENDING_REVIEW,
      createdByUserId: createdByUserId ?? null,
      lines: {
        create: normalizedLines.map((line) => ({
          rawName: line.rawName,
          sku: line.sku,
          barcode: line.barcode,
          quantity: line.quantity,
          unitType: line.unitType,
          status: SupplierLineStatus.PENDING,
        })),
      },
    },
    include: {
      lines: true,
    },
  });

  const enrichedLines = [];

  for (const line of draft.lines) {
    const matchingDraftShape = {
      detectedName: line.rawName,
      detectedBarcode: line.barcode,
      detectedCategory: null,
    };

    const matches = await findInventoryMatches({
      businessId,
      draft: matchingDraftShape,
    });

    const decision = decideInventoryAction(matches);
    const supplierDecision = mapDecisionToSupplierDecision(decision);
    const lineStatus = mapDecisionToLineStatus(supplierDecision);
    const topMatch = matches[0] ?? null;

    const updatedLine = await prisma.supplierPurchaseDraftLine.update({
      where: { id: line.id },
      data: {
        matchedItemId:
          supplierDecision === SupplierLineDecision.MERGE && topMatch?.itemId
            ? topMatch.itemId
            : null,
        matchScore: topMatch?.matchScore ?? null,
        decision: supplierDecision,
        status: lineStatus,
      },
    });

    enrichedLines.push({
      ...updatedLine,
      matches,
      decision,
    });
  }

  return {
    success: true,
    draft: {
      ...draft,
      lines: enrichedLines,
    },
  };
}