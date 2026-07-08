import {
  InventoryUnitType,
  Prisma,
  PurchaseOrderLineRemainingDecision,
  PurchaseOrderLineStatus,
  PurchaseOrderStatus,
  ReceivingSessionStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  InventoryNotFoundError,
  InventoryUnauthorizedError,
  InventoryValidationError,
} from "@/lib/services/inventory/inventory.errors";

type Tx = Prisma.TransactionClient;
type QueryClient = Tx | typeof prisma;
type TxOptions = { tx?: Tx };
const TRANSACTION_OPTIONS = { timeout: 15_000 };

type PurchaseOrderLineInput = {
  itemId?: number | null;
  rawName?: string | null;
  sku?: string | null;
  barcode?: string | null;
  orderedQty: number;
  unitCost?: number | null;
  unitType?: InventoryUnitType | null;
};

export type CreatePurchaseOrderInput = {
  businessId: number;
  createdByUserId?: number | null;
  supplierName?: string | null;
  externalOrderId?: string | null;
  source?: string | null;
  orderDate?: Date | string | null;
  status?: PurchaseOrderStatus | null;
  sourceSupplierPurchaseDraftId?: number | null;
  lines: PurchaseOrderLineInput[];
};

export type ListPurchaseOrdersInput = {
  businessId: number;
  status?: PurchaseOrderStatus | null;
  limit?: number | null;
};

export type GetPurchaseOrderInput = {
  businessId: number;
  purchaseOrderId: number;
};

export type SetPurchaseOrderLineRemainingDecisionInput = {
  businessId: number;
  purchaseOrderId: number;
  purchaseOrderLineId: number;
  decidedByUserId?: number | null;
  remainingDecision: PurchaseOrderLineRemainingDecision;
  remainingDecisionQty?: number | null;
  expectedAt?: Date | string | null;
  remainingDecisionNote?: string | null;
};

function normalizeText(value?: string | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizePositiveNumber(value: number, fieldName: string): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InventoryValidationError(`${fieldName} must be greater than zero`);
  }

  return parsed;
}

function normalizeOptionalNonNegativeNumber(
  value: number | null | undefined,
  fieldName: string
): number | null {
  if (value == null) return null;
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new InventoryValidationError(
      `${fieldName} must be greater than or equal to zero`
    );
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
    throw new InventoryValidationError(`${fieldName} must be a positive integer`);
  }

  return parsed;
}

function normalizePositiveInt(value: number, fieldName: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InventoryValidationError(`${fieldName} must be a positive integer`);
  }

  return parsed;
}

function normalizeOrderDate(value?: Date | string | null): Date | null {
  if (!value) return null;

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new InventoryValidationError("Invalid orderDate");
  }

  return date;
}

function normalizeExpectedAt(value?: Date | string | null): Date | null {
  if (!value) return null;

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new InventoryValidationError("Invalid expectedAt");
  }

  return date;
}

function normalizeCreateStatus(
  status?: PurchaseOrderStatus | null
): PurchaseOrderStatus {
  if (status == null) return PurchaseOrderStatus.DRAFT;

  if (
    status !== PurchaseOrderStatus.DRAFT &&
    status !== PurchaseOrderStatus.CONFIRMED
  ) {
    throw new InventoryValidationError(
      "Purchase order can only be created as DRAFT or CONFIRMED"
    );
  }

  return status;
}

function normalizeLimit(value?: number | null): number {
  if (value == null) return 50;
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InventoryValidationError("limit must be a positive integer");
  }

  return Math.min(parsed, 100);
}

function lineHasIdentity(line: PurchaseOrderLineInput): boolean {
  return Boolean(
    line.itemId ||
      normalizeText(line.rawName) ||
      normalizeText(line.sku) ||
      normalizeText(line.barcode)
  );
}

async function getPostedReceivedByLine(
  tx: QueryClient,
  purchaseOrderLineIds: number[]
) {
  if (purchaseOrderLineIds.length === 0) {
    return new Map<number, number>();
  }

  const aggregates = await tx.receivingLine.groupBy({
    by: ["purchaseOrderLineId"],
    where: {
      purchaseOrderLineId: { in: purchaseOrderLineIds },
      receivingSession: {
        status: ReceivingSessionStatus.POSTED,
      },
    },
    _sum: {
      receivedQty: true,
    },
  });

  return new Map(
    aggregates.map((row) => [
      row.purchaseOrderLineId,
      row._sum.receivedQty ?? 0,
    ])
  );
}

/**
 * Latest actual receiving date per purchase-order line — the posted-at time of
 * the most recent POSTED receiving session that touched the line (falling back
 * to that session's createdAt). Used for order→receipt traceability.
 */
async function getLastReceivedAtByLine(
  tx: QueryClient,
  purchaseOrderLineIds: number[]
) {
  if (purchaseOrderLineIds.length === 0) {
    return new Map<number, Date>();
  }

  const rows = await tx.receivingLine.findMany({
    where: {
      purchaseOrderLineId: { in: purchaseOrderLineIds },
      receivingSession: {
        status: ReceivingSessionStatus.POSTED,
      },
    },
    select: {
      purchaseOrderLineId: true,
      receivingSession: { select: { postedAt: true, createdAt: true } },
    },
  });

  const map = new Map<number, Date>();
  for (const row of rows) {
    const at = row.receivingSession.postedAt ?? row.receivingSession.createdAt;
    if (!at) continue;
    const prev = map.get(row.purchaseOrderLineId);
    if (!prev || at.getTime() > prev.getTime()) {
      map.set(row.purchaseOrderLineId, at);
    }
  }

  return map;
}

function getClosedShortQty(line: {
  remainingDecision: PurchaseOrderLineRemainingDecision | null;
  remainingDecisionQty: number | null;
}) {
  if (line.remainingDecision !== PurchaseOrderLineRemainingDecision.CLOSED_SHORT) {
    return 0;
  }

  return line.remainingDecisionQty ?? 0;
}

async function withPurchaseOrderLineQuantities<
  T extends {
    lines: Array<{
      id: number;
      orderedQty: number;
      remainingDecision: PurchaseOrderLineRemainingDecision | null;
      remainingDecisionQty: number | null;
    }>;
  }
>(tx: QueryClient, purchaseOrder: T) {
  const lineIds = purchaseOrder.lines.map((line) => line.id);
  const [receivedByLine, lastReceivedAtByLine] = await Promise.all([
    getPostedReceivedByLine(tx, lineIds),
    getLastReceivedAtByLine(tx, lineIds),
  ]);

  return {
    ...purchaseOrder,
    lines: purchaseOrder.lines.map((line) => {
      const receivedQty = receivedByLine.get(line.id) ?? 0;
      const closedShortQty = getClosedShortQty(line);
      const lastReceivedAt = lastReceivedAtByLine.get(line.id) ?? null;

      return {
        ...line,
        receivedQty,
        closedShortQty,
        openQty: line.orderedQty - receivedQty - closedShortQty,
        lastReceivedAt,
      };
    }),
  };
}

function normalizeRemainingDecision(
  value: unknown
): PurchaseOrderLineRemainingDecision {
  if (
    !Object.values(PurchaseOrderLineRemainingDecision).includes(
      value as PurchaseOrderLineRemainingDecision
    )
  ) {
    throw new InventoryValidationError("Invalid remaining decision");
  }

  return value as PurchaseOrderLineRemainingDecision;
}

export const purchaseOrderService = {
  async createPurchaseOrder(
    input: CreatePurchaseOrderInput,
    options?: TxOptions
  ) {
    const {
      businessId,
      createdByUserId,
      supplierName,
      externalOrderId,
      source,
      orderDate,
      sourceSupplierPurchaseDraftId,
      lines,
    } = input;

    if (!businessId || Number.isNaN(businessId)) {
      throw new InventoryUnauthorizedError("Invalid business id");
    }

    if (!Array.isArray(lines) || lines.length === 0) {
      throw new InventoryValidationError(
        "Purchase order must include at least one line"
      );
    }

    const status = normalizeCreateStatus(input.status);
    const sourceDraftId = normalizeOptionalPositiveInt(
      sourceSupplierPurchaseDraftId,
      "sourceSupplierPurchaseDraftId"
    );

    const run = async (tx: Tx) => {
      const itemIds = Array.from(
        new Set(
          lines
            .map((line) => normalizeOptionalPositiveInt(line.itemId, "itemId"))
            .filter((id): id is number => id != null)
        )
      );

      const items = itemIds.length
        ? await tx.inventoryItem.findMany({
            where: {
              businessId,
              id: { in: itemIds },
              isActive: true,
            },
            select: { id: true, unitType: true },
          })
        : [];

      const itemById = new Map(items.map((item) => [item.id, item]));

      for (const itemId of itemIds) {
        if (!itemById.has(itemId)) {
          throw new InventoryNotFoundError("Inventory item not found");
        }
      }

      const normalizedLines = lines.map((line, index) => {
        if (!lineHasIdentity(line)) {
          throw new InventoryValidationError(
            `Purchase order line ${index + 1} must identify an item`
          );
        }

        const itemId = normalizeOptionalPositiveInt(line.itemId, "itemId");
        const matchedItem = itemId ? itemById.get(itemId) : null;

        return {
          itemId,
          rawName: normalizeText(line.rawName),
          sku: normalizeText(line.sku),
          barcode: normalizeText(line.barcode),
          orderedQty: normalizePositiveNumber(line.orderedQty, "orderedQty"),
          unitCost: normalizeOptionalNonNegativeNumber(
            line.unitCost,
            "unitCost"
          ),
          unitType: line.unitType ?? matchedItem?.unitType ?? null,
          status: PurchaseOrderLineStatus.ORDERED,
        };
      });

      const purchaseOrder = await tx.purchaseOrder.create({
        data: {
          businessId,
          supplierName: normalizeText(supplierName),
          externalOrderId: normalizeText(externalOrderId),
          source: normalizeText(source) ?? "MANUAL",
          orderDate: normalizeOrderDate(orderDate),
          status,
          createdByUserId: createdByUserId ?? null,
          sourceSupplierPurchaseDraftId: sourceDraftId,
          lines: {
            create: normalizedLines,
          },
        },
        include: {
          lines: {
            orderBy: { id: "asc" },
          },
        },
      });

      return withPurchaseOrderLineQuantities(tx, purchaseOrder);
    };

    if (options?.tx) return run(options.tx);
    return prisma.$transaction(run, TRANSACTION_OPTIONS);
  },

  async listPurchaseOrders(input: ListPurchaseOrdersInput) {
    const { businessId, status } = input;

    if (!businessId || Number.isNaN(businessId)) {
      throw new InventoryUnauthorizedError("Invalid business id");
    }

    const purchaseOrders = await prisma.purchaseOrder.findMany({
      where: {
        businessId,
        ...(status ? { status } : {}),
      },
      include: {
        lines: {
          orderBy: { id: "asc" },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: normalizeLimit(input.limit),
    });

    return Promise.all(
      purchaseOrders.map((purchaseOrder) =>
        withPurchaseOrderLineQuantities(prisma, purchaseOrder)
      )
    );
  },

  async getPurchaseOrder(input: GetPurchaseOrderInput) {
    const { businessId, purchaseOrderId } = input;

    if (!businessId || Number.isNaN(businessId)) {
      throw new InventoryUnauthorizedError("Invalid business id");
    }

    if (!purchaseOrderId || Number.isNaN(purchaseOrderId)) {
      throw new InventoryValidationError("Invalid purchase order id");
    }

    const purchaseOrder = await prisma.purchaseOrder.findFirst({
      where: {
        id: purchaseOrderId,
        businessId,
      },
      include: {
        lines: {
          orderBy: { id: "asc" },
        },
      },
    });

    if (!purchaseOrder) {
      throw new InventoryNotFoundError("Purchase order not found");
    }

    return withPurchaseOrderLineQuantities(prisma, purchaseOrder);
  },

  async setPurchaseOrderLineRemainingDecision(
    input: SetPurchaseOrderLineRemainingDecisionInput,
    options?: TxOptions
  ) {
    const businessId = normalizePositiveInt(input.businessId, "businessId");
    const purchaseOrderId = normalizePositiveInt(
      input.purchaseOrderId,
      "purchaseOrderId"
    );
    const purchaseOrderLineId = normalizePositiveInt(
      input.purchaseOrderLineId,
      "purchaseOrderLineId"
    );
    const remainingDecision = normalizeRemainingDecision(
      input.remainingDecision
    );

    const run = async (tx: Tx) => {
      const purchaseOrder = await tx.purchaseOrder.findFirst({
        where: {
          id: purchaseOrderId,
          businessId,
        },
        include: {
          lines: {
            where: { id: purchaseOrderLineId },
          },
        },
      });

      if (!purchaseOrder) {
        throw new InventoryNotFoundError("Purchase order not found");
      }

      if (purchaseOrder.status === PurchaseOrderStatus.CANCELLED) {
        throw new InventoryValidationError(
          "Cannot update remaining decision for a cancelled purchase order"
        );
      }

      const purchaseOrderLine = purchaseOrder.lines[0];

      if (!purchaseOrderLine) {
        throw new InventoryValidationError(
          "Purchase order line does not belong to the purchase order"
        );
      }

      if (purchaseOrderLine.status === PurchaseOrderLineStatus.CANCELLED) {
        throw new InventoryValidationError(
          "Cannot update remaining decision for a cancelled purchase order line"
        );
      }

      const postedReceivedByLine = await getPostedReceivedByLine(tx, [
        purchaseOrderLine.id,
      ]);
      const receivedQty = postedReceivedByLine.get(purchaseOrderLine.id) ?? 0;
      const currentRemainingQty = purchaseOrderLine.orderedQty - receivedQty;

      let remainingDecisionQty: number | null = null;
      let expectedAt: Date | null = null;

      if (
        remainingDecision === PurchaseOrderLineRemainingDecision.BACKORDER ||
        remainingDecision === PurchaseOrderLineRemainingDecision.CLOSED_SHORT
      ) {
        remainingDecisionQty = normalizePositiveNumber(
          input.remainingDecisionQty ?? NaN,
          "remainingDecisionQty"
        );

        if (remainingDecisionQty > currentRemainingQty) {
          throw new InventoryValidationError(
            "remainingDecisionQty cannot exceed the current remaining quantity"
          );
        }
      }

      if (remainingDecision === PurchaseOrderLineRemainingDecision.BACKORDER) {
        expectedAt = normalizeExpectedAt(input.expectedAt);
      }

      const updatedLine = await tx.purchaseOrderLine.update({
        where: { id: purchaseOrderLine.id },
        data: {
          remainingDecision,
          remainingDecisionQty,
          expectedAt,
          remainingDecisionNote: normalizeText(input.remainingDecisionNote),
          remainingDecidedAt: new Date(),
          remainingDecidedByUserId: input.decidedByUserId ?? null,
        },
      });

      const closedShortQty = getClosedShortQty(updatedLine);

      return {
        ...updatedLine,
        receivedQty,
        closedShortQty,
        openQty: updatedLine.orderedQty - receivedQty - closedShortQty,
      };
    };

    if (options?.tx) return run(options.tx);
    return prisma.$transaction(run, TRANSACTION_OPTIONS);
  },
};
