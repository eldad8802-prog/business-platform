import {
  InventoryMovementReason,
  Prisma,
  PurchaseOrderLineRemainingDecision,
  PurchaseOrderLineStatus,
  PurchaseOrderStatus,
  ReceivingSessionStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { inventoryService } from "@/lib/services/inventory/inventory.service";
import {
  InventoryNotFoundError,
  InventoryUnauthorizedError,
  InventoryValidationError,
} from "@/lib/services/inventory/inventory.errors";

type Tx = Prisma.TransactionClient;
type TxOptions = { tx?: Tx };
const TRANSACTION_OPTIONS = { timeout: 15_000 };

type ReceivingLineInput = {
  purchaseOrderLineId: number;
  receivedQty: number;
  unitCost?: number | null;
};

export type CreateReceivingSessionInput = {
  businessId: number;
  purchaseOrderId: number;
  createdByUserId?: number | null;
  receivedAt?: Date | string | null;
  note?: string | null;
  lines: ReceivingLineInput[];
};

export type ListReceivingSessionsInput = {
  businessId: number;
  purchaseOrderId: number;
};

export type GetReceivingSessionInput = {
  businessId: number;
  receivingSessionId: number;
};

export type PostReceivingSessionInput = {
  businessId: number;
  receivingSessionId: number;
  postedByUserId?: number | null;
};

function assertBusinessId(businessId: number) {
  if (!businessId || Number.isNaN(businessId)) {
    throw new InventoryUnauthorizedError("Invalid business id");
  }
}

function normalizePositiveInt(value: number, fieldName: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InventoryValidationError(`${fieldName} must be a positive integer`);
  }

  return parsed;
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

function normalizeText(value?: string | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeDate(value?: Date | string | null): Date | null {
  if (!value) return null;

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new InventoryValidationError("Invalid receivedAt");
  }

  return date;
}

function normalizeLines(lines: ReceivingLineInput[]) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new InventoryValidationError(
      "Receiving session must include at least one line"
    );
  }

  const seenLineIds = new Set<number>();

  return lines.map((line, index) => {
    const purchaseOrderLineId = normalizePositiveInt(
      line.purchaseOrderLineId,
      "purchaseOrderLineId"
    );

    if (seenLineIds.has(purchaseOrderLineId)) {
      throw new InventoryValidationError(
        `Receiving line ${index + 1} duplicates a purchase order line`
      );
    }

    seenLineIds.add(purchaseOrderLineId);

    return {
      purchaseOrderLineId,
      receivedQty: normalizePositiveNumber(line.receivedQty, "receivedQty"),
      unitCost: normalizeOptionalNonNegativeNumber(line.unitCost, "unitCost"),
    };
  });
}

async function getPostedReceivedByLine(
  tx: Tx,
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

async function validateReceivingLines(
  tx: Tx,
  input: {
    businessId: number;
    purchaseOrderId: number;
    lines: Array<{
      purchaseOrderLineId: number;
      receivedQty: number;
      unitCost?: number | null;
    }>;
  }
) {
  const purchaseOrder = await tx.purchaseOrder.findFirst({
    where: {
      id: input.purchaseOrderId,
      businessId: input.businessId,
    },
    include: {
      lines: {
        where: {
          id: { in: input.lines.map((line) => line.purchaseOrderLineId) },
        },
        include: {
          item: true,
        },
      },
    },
  });

  if (!purchaseOrder) {
    throw new InventoryNotFoundError("Purchase order not found");
  }

  if (
    purchaseOrder.status === PurchaseOrderStatus.CLOSED ||
    purchaseOrder.status === PurchaseOrderStatus.CANCELLED
  ) {
    throw new InventoryValidationError(
      "Cannot receive against a closed or cancelled purchase order"
    );
  }

  if (purchaseOrder.lines.length !== input.lines.length) {
    throw new InventoryValidationError(
      "All receiving lines must belong to the purchase order"
    );
  }

  const lineById = new Map(
    purchaseOrder.lines.map((line) => [line.id, line])
  );
  const postedReceivedByLine = await getPostedReceivedByLine(
    tx,
    input.lines.map((line) => line.purchaseOrderLineId)
  );

  return input.lines.map((line, index) => {
    const purchaseOrderLine = lineById.get(line.purchaseOrderLineId);

    if (!purchaseOrderLine) {
      throw new InventoryValidationError(
        `Receiving line ${index + 1} does not belong to the purchase order`
      );
    }

    if (purchaseOrderLine.status === PurchaseOrderLineStatus.CANCELLED) {
      throw new InventoryValidationError(
        `Purchase order line ${purchaseOrderLine.id} is cancelled`
      );
    }

    if (!purchaseOrderLine.itemId || !purchaseOrderLine.item) {
      throw new InventoryValidationError(
        `Purchase order line ${purchaseOrderLine.id} is not linked to an inventory item`
      );
    }

    if (
      purchaseOrderLine.item.businessId !== input.businessId ||
      !purchaseOrderLine.item.isActive
    ) {
      throw new InventoryNotFoundError("Inventory item not found");
    }

    const alreadyReceived = postedReceivedByLine.get(purchaseOrderLine.id) ?? 0;
    const closedShortQty =
      purchaseOrderLine.remainingDecision ===
      PurchaseOrderLineRemainingDecision.CLOSED_SHORT
        ? purchaseOrderLine.remainingDecisionQty ?? 0
        : 0;
    const remainingQty =
      purchaseOrderLine.orderedQty - alreadyReceived - closedShortQty;

    if (line.receivedQty > remainingQty) {
      throw new InventoryValidationError(
        `Receiving line ${purchaseOrderLine.id} exceeds open quantity`
      );
    }

    return {
      purchaseOrderLineId: purchaseOrderLine.id,
      itemId: purchaseOrderLine.itemId,
      receivedQty: line.receivedQty,
      unitCost: line.unitCost ?? purchaseOrderLine.unitCost ?? null,
      orderedQty: purchaseOrderLine.orderedQty,
      alreadyReceived,
    };
  });
}

/**
 * Recompute a purchase order's status from the reality of its lines.
 *
 * Pure derivation — it reads posted receipts and line decisions and writes one
 * status. It never moves a terminal order (CLOSED / CANCELLED stay put) and it
 * never downgrades an order that has nothing left open.
 */
async function settlePurchaseOrderStatus(
  tx: Tx,
  input: { businessId: number; purchaseOrderId: number }
) {
  // ONE round trip: the order, its lines, and each line's POSTED receipts. This
  // runs inside an already long approval transaction, so a second query here is
  // not free — nesting the receipts into the same read keeps the added cost to a
  // single statement.
  const purchaseOrder = await tx.purchaseOrder.findFirst({
    where: { id: input.purchaseOrderId, businessId: input.businessId },
    select: {
      id: true,
      status: true,
      lines: {
        select: {
          id: true,
          status: true,
          orderedQty: true,
          remainingDecision: true,
          remainingDecisionQty: true,
          receivingLines: {
            where: {
              receivingSession: { status: ReceivingSessionStatus.POSTED },
            },
            select: { receivedQty: true },
          },
        },
      },
    },
  });

  if (!purchaseOrder) return;

  if (
    purchaseOrder.status === PurchaseOrderStatus.CLOSED ||
    purchaseOrder.status === PurchaseOrderStatus.CANCELLED
  ) {
    return;
  }

  const hasOpenQuantity = purchaseOrder.lines.some((line) => {
    if (line.status === PurchaseOrderLineStatus.CANCELLED) return false;

    const received = line.receivingLines.reduce(
      (sum, r) => sum + r.receivedQty,
      0
    );
    const closedShort =
      line.remainingDecision ===
      PurchaseOrderLineRemainingDecision.CLOSED_SHORT
        ? line.remainingDecisionQty ?? 0
        : 0;

    return line.orderedQty - received - closedShort > 0;
  });

  const nextStatus = hasOpenQuantity
    ? PurchaseOrderStatus.AWAITING_DELIVERY
    : PurchaseOrderStatus.CLOSED;

  if (nextStatus === purchaseOrder.status) return;

  await tx.purchaseOrder.update({
    where: { id: purchaseOrder.id },
    data: { status: nextStatus },
  });
}

export const receivingService = {
  async createReceivingSession(
    input: CreateReceivingSessionInput,
    options?: TxOptions
  ) {
    assertBusinessId(input.businessId);

    const purchaseOrderId = normalizePositiveInt(
      input.purchaseOrderId,
      "purchaseOrderId"
    );
    const normalizedLines = normalizeLines(input.lines);
    const receivedAt = normalizeDate(input.receivedAt);

    const run = async (tx: Tx) => {
      const validatedLines = await validateReceivingLines(tx, {
        businessId: input.businessId,
        purchaseOrderId,
        lines: normalizedLines,
      });

      return tx.receivingSession.create({
        data: {
          businessId: input.businessId,
          purchaseOrderId,
          status: ReceivingSessionStatus.DRAFT,
          receivedAt,
          createdByUserId: input.createdByUserId ?? null,
          note: normalizeText(input.note),
          lines: {
            create: validatedLines.map((line) => ({
              purchaseOrderLineId: line.purchaseOrderLineId,
              itemId: line.itemId,
              receivedQty: line.receivedQty,
              unitCost: line.unitCost,
            })),
          },
        },
        include: {
          lines: {
            orderBy: { id: "asc" },
          },
          purchaseOrder: true,
        },
      });
    };

    if (options?.tx) return run(options.tx);
    return prisma.$transaction(run, TRANSACTION_OPTIONS);
  },

  async listReceivingSessions(input: ListReceivingSessionsInput, options?: TxOptions) {
    const db = options?.tx ?? prisma;
    assertBusinessId(input.businessId);

    const purchaseOrderId = normalizePositiveInt(
      input.purchaseOrderId,
      "purchaseOrderId"
    );

    return db.receivingSession.findMany({
      where: {
        businessId: input.businessId,
        purchaseOrderId,
      },
      include: {
        lines: {
          orderBy: { id: "asc" },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  },

  async getReceivingSession(input: GetReceivingSessionInput, options?: TxOptions) {
    const db = options?.tx ?? prisma;
    assertBusinessId(input.businessId);

    const receivingSessionId = normalizePositiveInt(
      input.receivingSessionId,
      "receivingSessionId"
    );

    const receivingSession = await db.receivingSession.findFirst({
      where: {
        id: receivingSessionId,
        businessId: input.businessId,
      },
      include: {
        lines: {
          include: {
            purchaseOrderLine: true,
            item: true,
          },
          orderBy: { id: "asc" },
        },
        purchaseOrder: true,
      },
    });

    if (!receivingSession) {
      throw new InventoryNotFoundError("Receiving session not found");
    }

    return receivingSession;
  },

  async postReceivingSession(
    input: PostReceivingSessionInput,
    options?: TxOptions
  ) {
    assertBusinessId(input.businessId);

    const receivingSessionId = normalizePositiveInt(
      input.receivingSessionId,
      "receivingSessionId"
    );

    const run = async (tx: Tx) => {
      const receivingSession = await tx.receivingSession.findFirst({
        where: {
          id: receivingSessionId,
          businessId: input.businessId,
        },
        include: {
          lines: {
            orderBy: { id: "asc" },
          },
          purchaseOrder: true,
        },
      });

      if (!receivingSession) {
        throw new InventoryNotFoundError("Receiving session not found");
      }

      if (receivingSession.status !== ReceivingSessionStatus.DRAFT) {
        throw new InventoryValidationError("Receiving session already posted");
      }

      const validatedLines = await validateReceivingLines(tx, {
        businessId: input.businessId,
        purchaseOrderId: receivingSession.purchaseOrderId,
        lines: receivingSession.lines.map((line) => ({
          purchaseOrderLineId: line.purchaseOrderLineId,
          receivedQty: line.receivedQty,
          unitCost: line.unitCost,
        })),
      });

      const movements = [];
      const postedAt = new Date();

      for (const line of validatedLines) {
        const movement = await inventoryService.addStock(
          {
            businessId: input.businessId,
            itemId: line.itemId,
            quantityDelta: line.receivedQty,
            reason: InventoryMovementReason.SUPPLIER_PURCHASE,
            note: `Receiving session ${receivingSession.id}`,
            createdByUserId: input.postedByUserId ?? undefined,
          },
          { tx }
        );

        movements.push({
          movementId: movement.id,
          purchaseOrderLineId: line.purchaseOrderLineId,
          itemId: line.itemId,
          receivedQty: line.receivedQty,
        });

        if (line.unitCost != null) {
          await tx.inventoryItem.update({
            where: { id: line.itemId },
            data: {
              lastPurchaseCost: line.unitCost,
              lastPurchaseCostAt: postedAt,
            },
          });
        }
      }

      const postedSession = await tx.receivingSession.update({
        where: { id: receivingSession.id },
        data: {
          status: ReceivingSessionStatus.POSTED,
          postedAt,
          postedByUserId: input.postedByUserId ?? null,
        },
        include: {
          lines: {
            orderBy: { id: "asc" },
          },
          purchaseOrder: true,
        },
      });

      // ── Lifecycle (P3) ─────────────────────────────────────────────────
      // Posting stock is the ONLY event that tells us where an order really is,
      // so it is the only place allowed to move the order's status. Before this,
      // nothing ever advanced a PurchaseOrder past CONFIRMED: an approved order
      // sat in "ממתינות" forever, "היסטוריה" was permanently empty, and the
      // receiving screen (gated on AWAITING_DELIVERY) was unreachable — even
      // though the approval screen promises "ויעביר את ההזמנה להיסטוריה".
      //
      // No new status is invented. The existing vocabulary is simply applied:
      //   something still open  → AWAITING_DELIVERY  ("בדרך")
      //   nothing left open     → CLOSED             ("היסטוריה")
      // A line counts as settled once its posted receipts plus any CLOSED_SHORT
      // quantity cover what was ordered; CANCELLED lines never hold an order open.
      //
      // ORDER MATTERS: this runs AFTER the session is marked POSTED. Settling
      // first would count this very receipt as not-yet-posted and leave a fully
      // received order sitting in AWAITING_DELIVERY forever.
      await settlePurchaseOrderStatus(tx, {
        businessId: input.businessId,
        purchaseOrderId: receivingSession.purchaseOrderId,
      });

      return {
        receivingSession: postedSession,
        movements,
      };
    };

    if (options?.tx) return run(options.tx);
    return prisma.$transaction(run, TRANSACTION_OPTIONS);
  },
};
