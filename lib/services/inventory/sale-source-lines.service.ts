import { Prisma } from "@prisma/client";

export type SourceSaleLineInput = {
  lineKey: string;
  sku: string | null;
  barcode: string | null;
  name: string | null;
  quantity: number;
  unitPrice: string | null;
  recognizedItemId?: number | null;
};

function isUniqueConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );
}

/** Durable upstream lines. Existing rows are left unchanged on retry. */
export async function recordInventorySourceSaleLines(
  tx: Prisma.TransactionClient,
  input: {
    businessId: number;
    externalSaleId: string;
    lines: SourceSaleLineInput[];
  }
) {
  for (const line of input.lines) {
    try {
      await tx.inventorySourceSaleLine.create({
        data: {
          businessId: input.businessId,
          externalSaleId: input.externalSaleId,
          lineKey: line.lineKey,
          sku: line.sku,
          barcode: line.barcode,
          name: line.name,
          quantity: line.quantity,
          unitPrice:
            line.unitPrice === null ? null : new Prisma.Decimal(line.unitPrice),
          recognizedItemId: line.recognizedItemId ?? null,
        },
      });
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
    }
  }
}

/** Link a source line to the sale line that movement actually created. */
export async function linkSourceLinesToSale(
  tx: Prisma.TransactionClient,
  input: { businessId: number; externalSaleId: string; saleId: number }
) {
  const saleLines = await tx.inventorySaleLine.findMany({
    where: { businessId: input.businessId, saleId: input.saleId },
    select: { id: true, lineKey: true },
  });

  for (const saleLine of saleLines) {
    await tx.inventorySourceSaleLine.updateMany({
      where: {
        businessId: input.businessId,
        externalSaleId: input.externalSaleId,
        lineKey: saleLine.lineKey,
        saleLineId: null,
      },
      data: { saleLineId: saleLine.id },
    });
  }
}
