import { CatalogSourceType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Supplier Domain Catalog — CatalogSource runtime.
 *
 * CatalogSource is a provenance anchor ONLY: it records *who/how/when* a batch of
 * catalog claims entered the system (manual entry / file import). It holds NO
 * catalog values — every value lives on CatalogClaim. Append-only; never mutated.
 */

export type CreateCatalogSourceInput = {
  businessId: number;
  supplierId: number;
  sourceType: CatalogSourceType;
  actorUserId?: number | null;
  /** When the underlying observation happened; defaults to now (DB default). */
  occurredAt?: Date | null;
  /** Batch/import context (file name, row count, …). Never catalog values. */
  metadata?: Prisma.InputJsonValue | null;
  /** Optional SupplierConnection this batch came through (provenance). */
  connectionId?: number | null;
};

/** Create the provenance anchor for a catalog ingestion batch. */
export function createCatalogSourceTx(
  tx: Prisma.TransactionClient,
  input: CreateCatalogSourceInput
) {
  return tx.catalogSource.create({
    data: {
      businessId: input.businessId,
      supplierId: input.supplierId,
      sourceType: input.sourceType,
      actorUserId: input.actorUserId ?? null,
      occurredAt: input.occurredAt ?? undefined,
      metadata: input.metadata ?? undefined,
      connectionId: input.connectionId ?? null,
    },
  });
}

/** Lookup the provenance trail for a supplier (most recent first). */
export function getCatalogSourcesForSupplier(
  businessId: number,
  supplierId: number
) {
  return prisma.catalogSource.findMany({
    where: { businessId, supplierId },
    orderBy: { occurredAt: "desc" },
  });
}

/** Lookup a single source with its claims (provenance → claims relation). */
export function getCatalogSourceWithClaims(businessId: number, sourceId: number) {
  return prisma.catalogSource.findFirst({
    where: { id: sourceId, businessId },
    include: { claims: true },
  });
}
