import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { inventoryService } from "@/lib/services/inventory/inventory.service";
import { InventoryValidationError } from "@/lib/services/inventory/inventory.errors";

type Tx = Prisma.TransactionClient;

export type RecordInventorySaleLine = {
  itemId: number;
  quantity: number;
  /** Canonical decimal ("59.90"), or null when the caller did not send a price. */
  unitPrice: string | null;
  lineKey: string;
};

export type RecordInventorySaleInput = {
  businessId: number;
  source: string;
  externalSaleId?: string | null;
  idempotencyKey?: string | null;
  note?: string;
  createdByUserId?: number;
  lines: RecordInventorySaleLine[];
  tx?: Tx;
};

export type RecordedSaleMovement = {
  id: number;
  itemId: number;
  quantityDelta: number;
  quantityBefore: number;
  quantityAfter: number;
};

export type RecordInventorySaleResult = {
  saleId: number;
  created: boolean;
  movements: RecordedSaleMovement[];
};

function cleanKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

async function loadSaleResult(
  tx: Tx,
  saleId: number
): Promise<RecordInventorySaleResult> {
  const sale = await tx.inventorySale.findUnique({
    where: { id: saleId },
    include: {
      lines: {
        include: { movement: true },
        orderBy: { id: "asc" },
      },
    },
  });

  if (!sale) {
    return { saleId, created: false, movements: [] };
  }

  return {
    saleId: sale.id,
    created: false,
    movements: sale.lines.map((line) => ({
      id: line.movement.id,
      itemId: line.itemId,
      quantityDelta: line.movement.quantityDelta,
      quantityBefore: line.movement.quantityBefore,
      quantityAfter: line.movement.quantityAfter,
    })),
  };
}

async function findExistingSale(
  tx: Tx,
  businessId: number,
  externalSaleId: string | null,
  idempotencyKey: string | null
): Promise<RecordInventorySaleResult | null> {
  if (externalSaleId) {
    const processed = await tx.inventoryExternalSale.findUnique({
      where: {
        businessId_externalSaleId: { businessId, externalSaleId },
      },
    });
    if (processed) {
      const sale = await tx.inventorySale.findUnique({
        where: {
          businessId_externalSaleId: { businessId, externalSaleId },
        },
      });
      if (!sale) {
        return { saleId: 0, created: false, movements: [] };
      }
      return loadSaleResult(tx, sale.id);
    }

    const sale = await tx.inventorySale.findUnique({
      where: {
        businessId_externalSaleId: { businessId, externalSaleId },
      },
    });
    if (sale) return loadSaleResult(tx, sale.id);
  }

  if (idempotencyKey) {
    const sale = await tx.inventorySale.findUnique({
      where: {
        businessId_idempotencyKey: { businessId, idempotencyKey },
      },
    });
    if (sale) {
      if (sale.businessId !== businessId) {
        throw new InventoryValidationError("Sale idempotency key is not available");
      }
      return loadSaleResult(tx, sale.id);
    }
  }

  return null;
}

async function recordInTransaction(
  tx: Tx,
  input: RecordInventorySaleInput
): Promise<RecordInventorySaleResult> {
  const businessId = input.businessId;
  const source = input.source.trim();
  const externalSaleId = cleanKey(input.externalSaleId);
  const idempotencyKey = cleanKey(input.idempotencyKey);

  if (!source) {
    throw new InventoryValidationError("Sale source is required");
  }
  if (input.lines.length === 0) {
    throw new InventoryValidationError("Sale must include at least one item");
  }

  const seenKeys = new Set<string>();
  for (const line of input.lines) {
    if (!line.lineKey || seenKeys.has(line.lineKey)) {
      throw new InventoryValidationError("Sale line key must be unique");
    }
    seenKeys.add(line.lineKey);
    if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
      throw new InventoryValidationError("Invalid sale item quantity");
    }
  }

  const existing = await findExistingSale(
    tx,
    businessId,
    externalSaleId,
    idempotencyKey
  );
  if (existing) return existing;

  const sale = await tx.inventorySale.create({
    data: {
      businessId,
      source,
      externalSaleId,
      idempotencyKey,
    },
  });

  const movements: RecordedSaleMovement[] = [];

  for (const line of input.lines) {
    const movement = await inventoryService.removeStock(
      {
        businessId,
        itemId: line.itemId,
        quantityDelta: line.quantity,
        reason: "SALE",
        note: input.note,
        createdByUserId: input.createdByUserId,
      },
      { tx }
    );

    await tx.inventorySaleLine.create({
      data: {
        businessId,
        saleId: sale.id,
        itemId: line.itemId,
        movementId: movement.id,
        lineKey: line.lineKey,
        quantity: line.quantity,
        unitPrice:
          line.unitPrice === null ? null : new Prisma.Decimal(line.unitPrice),
      },
    });

    movements.push({
      id: movement.id,
      itemId: line.itemId,
      quantityDelta: movement.quantityDelta,
      quantityBefore: movement.quantityBefore,
      quantityAfter: movement.quantityAfter,
    });
  }

  if (externalSaleId) {
    await tx.inventoryExternalSale.create({
      data: {
        businessId,
        externalSaleId,
        source,
      },
    });
  }

  return { saleId: sale.id, created: true, movements };
}

export async function recordInventorySale(
  input: RecordInventorySaleInput
): Promise<RecordInventorySaleResult> {
  if (input.tx) return recordInTransaction(input.tx, input);
  return prisma.$transaction((tx) => recordInTransaction(tx, input));
}

export function isSaleIdempotencyConflict(error: unknown): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return false;
  }
  const target = error.meta?.target;
  const text = Array.isArray(target) ? target.join(",") : String(target ?? "");
  return text.includes("externalSaleId") || text.includes("idempotencyKey");
}
