import {
  InventoryUnitType,
  SupplierLineDecision,
  SupplierLineStatus,
  SupplierPurchaseDraftStatus,
} from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { findInventoryMatches } from "@/lib/services/inventory/inventory-matching.service";
import { decideInventoryAction } from "@/lib/services/inventory/inventory-decision.service";

type SupplierPurchaseLineInput = {
  rawName?: string | null;
  sku?: string | null;
  barcode?: string | null;
  quantity: number;
  unitType?: InventoryUnitType | null;
  /**
   * Cost per unit as entered by the owner. The column already existed on
   * SupplierPurchaseDraftLine but this input type did not carry the field, so
   * every cost typed into the order wizard was silently dropped before it ever
   * reached Prisma — order totals, supplier spend and lastPurchaseCost all read
   * back as 0/null. Null means "not stated", which is a legitimate state.
   */
  unitCost?: number | null;
};

type CreateSupplierPurchaseDraftInput = {
  businessId: number;
  /**
   * Entity-FK (Party Identity Strategy Tier 2). When the owner picked a real
   * Supplier, the id is verified tenant-scoped here and the name snapshot is
   * derived from the entity — never trusted from the client. Null keeps the
   * legacy free-text behaviour.
   */
  supplierId?: number | null;
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

function normalizeOptionalNonNegativeNumber(
  value: number | null | undefined,
  fieldName: string
): number | null {
  if (value == null) return null;
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${fieldName} must be greater than or equal to zero`);
  }

  return parsed;
}

function normalizeOptionalPositiveInt(
  value: number | null | undefined,
  fieldName: string
): number | null {
  if (value == null) return null;
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }

  return parsed;
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

type TxOptions = { tx?: Prisma.TransactionClient };

export async function createSupplierPurchaseDraft(
  input: CreateSupplierPurchaseDraftInput,
  options?: TxOptions
) {
  const db = options?.tx ?? prisma;
  const {
    businessId,
    supplierId,
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
    unitCost: normalizeOptionalNonNegativeNumber(line.unitCost, "unitCost"),
    unitType: line.unitType ?? InventoryUnitType.UNIT,
  }));

  // Tier-2 Entity-FK resolution, identical in spirit to createPurchaseOrder:
  // a supplied id is loaded tenant-scoped and the name snapshot is derived from
  // the verified row. A missing or cross-tenant supplier is indistinguishable.
  const normalizedSupplierId = normalizeOptionalPositiveInt(
    supplierId,
    "supplierId"
  );
  let resolvedSupplierId: number | null = null;
  let resolvedSupplierName: string | null = normalizeText(supplierName);

  if (normalizedSupplierId != null) {
    const supplier = await db.supplier.findFirst({
      where: { id: normalizedSupplierId, businessId },
      select: { id: true, name: true },
    });

    if (!supplier) {
      throw new Error("Supplier not found");
    }

    resolvedSupplierId = supplier.id;
    resolvedSupplierName = supplier.name;
  }

  const draft = await db.supplierPurchaseDraft.create({
    data: {
      businessId,
      supplierId: resolvedSupplierId,
      supplierName: resolvedSupplierName,
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
          unitCost: line.unitCost,
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

    const matches = await findInventoryMatches(
      {
        businessId,
        draft: matchingDraftShape,
      },
      options
    );

    const decision = decideInventoryAction(matches);
    const supplierDecision = mapDecisionToSupplierDecision(decision);
    const lineStatus = mapDecisionToLineStatus(supplierDecision);
    const topMatch = matches[0] ?? null;

    const updatedLine = await db.supplierPurchaseDraftLine.update({
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