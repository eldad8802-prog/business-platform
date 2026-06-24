import {
  CatalogSourceType,
  Prisma,
  SupplierConnectionCapability,
  SupplierConnectionStatus,
  SupplierConnectionType,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  InventoryNotFoundError,
  InventoryUnauthorizedError,
  InventoryValidationError,
} from "@/lib/services/inventory/inventory.errors";
import {
  ingestCatalog,
  type CatalogImportRow,
  type IngestCatalogResult,
  type SupplierTermsInput,
} from "@/lib/services/inventory/catalog-ingestion.service";
import { purchaseOrderService } from "@/lib/services/inventory/purchase-order.service";

/**
 * Supplier Domain — Connections Foundation (minimal).
 *
 * A SupplierConnection records HOW a business exchanges data with a supplier
 * (manual / email / CSV import / API placeholder) and WHAT a connection could do
 * (capabilities). It is a capability + provenance shell ONLY:
 *   - no transport, no real supplier API, no credentials/OAuth,
 *   - no scheduler, no background sync, no external side effects,
 *   - it NEVER authors Supplier Identity or InventoryItem,
 *   - catalog data still enters solely via explicit Catalog ingestion,
 *   - orders are still shared via the existing sharedAt event.
 *
 * The two "wiring" helpers (importCatalogViaConnection / shareOrderViaConnection)
 * only route to capabilities we already built — they perform no network I/O.
 */

function assertBusinessId(businessId: number) {
  if (!businessId || Number.isNaN(businessId)) {
    throw new InventoryUnauthorizedError("Invalid business id");
  }
}

function normalizeCapabilities(
  capabilities?: SupplierConnectionCapability[] | null
): SupplierConnectionCapability[] {
  if (!capabilities || capabilities.length === 0) return [];
  // Dedup while preserving the declared set.
  return Array.from(new Set(capabilities));
}

export type CreateSupplierConnectionInput = {
  businessId: number;
  supplierId: number;
  connectionType: SupplierConnectionType;
  capabilities?: SupplierConnectionCapability[] | null;
  status?: SupplierConnectionStatus | null;
  metadata?: Prisma.InputJsonValue | null;
};

/** Create a connection for a supplier (no external call). */
export async function createSupplierConnection(input: CreateSupplierConnectionInput) {
  assertBusinessId(input.businessId);

  const supplier = await prisma.supplier.findFirst({
    where: { id: input.supplierId, businessId: input.businessId },
    select: { id: true },
  });
  if (!supplier) {
    throw new InventoryNotFoundError("Supplier not found");
  }

  return prisma.supplierConnection.create({
    data: {
      businessId: input.businessId,
      supplierId: input.supplierId,
      connectionType: input.connectionType,
      status: input.status ?? SupplierConnectionStatus.ACTIVE,
      capabilities: normalizeCapabilities(input.capabilities),
      metadata: input.metadata ?? undefined,
    },
  });
}

export type ListSupplierConnectionsInput = {
  businessId: number;
  supplierId?: number | null;
  status?: SupplierConnectionStatus | null;
};

/** List connections for a business (optionally by supplier / status). */
export async function listSupplierConnections(input: ListSupplierConnectionsInput) {
  assertBusinessId(input.businessId);

  return prisma.supplierConnection.findMany({
    where: {
      businessId: input.businessId,
      ...(input.supplierId ? { supplierId: input.supplierId } : {}),
      ...(input.status ? { status: input.status } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}

/** Get one connection (throws if not found in this business). */
export async function getSupplierConnection(businessId: number, connectionId: number) {
  assertBusinessId(businessId);

  const connection = await prisma.supplierConnection.findFirst({
    where: { id: connectionId, businessId },
  });
  if (!connection) {
    throw new InventoryNotFoundError("Supplier connection not found");
  }
  return connection;
}

export type UpdateSupplierConnectionInput = {
  businessId: number;
  connectionId: number;
  connectionType?: SupplierConnectionType | null;
  capabilities?: SupplierConnectionCapability[] | null;
  status?: SupplierConnectionStatus | null;
  metadata?: Prisma.InputJsonValue | null;
};

/** Update a connection's type / capabilities / status / metadata. */
export async function updateSupplierConnection(input: UpdateSupplierConnectionInput) {
  await getSupplierConnection(input.businessId, input.connectionId);

  const data: Prisma.SupplierConnectionUpdateInput = {};
  if (input.connectionType != null) data.connectionType = input.connectionType;
  if (input.status != null) data.status = input.status;
  if (input.capabilities != null) {
    data.capabilities = normalizeCapabilities(input.capabilities);
  }
  if (input.metadata !== undefined) {
    data.metadata = input.metadata ?? Prisma.JsonNull;
  }

  return prisma.supplierConnection.update({
    where: { id: input.connectionId },
    data,
  });
}

/** Soft-disable a connection (status = INACTIVE). Never deletes. */
export async function deactivateSupplierConnection(
  businessId: number,
  connectionId: number
) {
  await getSupplierConnection(businessId, connectionId);
  return prisma.supplierConnection.update({
    where: { id: connectionId },
    data: { status: SupplierConnectionStatus.INACTIVE },
  });
}

const CATALOG_IMPORT_SOURCE: Partial<Record<SupplierConnectionType, CatalogSourceType>> = {
  [SupplierConnectionType.MANUAL]: CatalogSourceType.MANUAL_ENTRY,
  [SupplierConnectionType.CSV_IMPORT]: CatalogSourceType.FILE_IMPORT,
};

export type ImportCatalogViaConnectionInput = {
  businessId: number;
  connectionId: number;
  rows: CatalogImportRow[];
  supplierTerms?: SupplierTermsInput;
  actorUserId?: number | null;
};

/**
 * Route an EXPLICIT catalog import through a MANUAL / CSV_IMPORT connection. This
 * is not a fetch/sync — the caller already holds the rows; we only stamp the
 * connection as provenance on the CatalogSource via the existing ingestion. The
 * connection must be ACTIVE and of a manual/file type (no API placeholder import).
 */
export async function importCatalogViaConnection(
  input: ImportCatalogViaConnectionInput
): Promise<IngestCatalogResult> {
  const connection = await getSupplierConnection(input.businessId, input.connectionId);

  if (connection.status !== SupplierConnectionStatus.ACTIVE) {
    throw new InventoryValidationError("Connection is not active");
  }

  const sourceType = CATALOG_IMPORT_SOURCE[connection.connectionType];
  if (!sourceType) {
    throw new InventoryValidationError(
      "Catalog import is only supported for MANUAL or CSV_IMPORT connections"
    );
  }

  const result = await ingestCatalog({
    businessId: input.businessId,
    supplierId: connection.supplierId,
    sourceType,
    actorUserId: input.actorUserId ?? null,
    rows: input.rows,
    supplierTerms: input.supplierTerms,
    connectionId: connection.id,
  });

  // Record that the connection was used to exchange data (no background sync).
  await prisma.supplierConnection.update({
    where: { id: connection.id },
    data: { lastSyncAt: new Date() },
  });

  return result;
}

export type ShareOrderViaConnectionInput = {
  businessId: number;
  connectionId: number;
  purchaseOrderId: number;
  sharedAt?: Date | string | null;
};

/**
 * Record that a PurchaseOrder was shared/sent to the supplier through a MANUAL /
 * EMAIL connection. This only writes the sharedAt EVENT (via the existing
 * markPurchaseOrderShared) and the connection's lastSyncAt — it performs NO
 * external submission and never changes PO status / fulfillment.
 */
export async function shareOrderViaConnection(input: ShareOrderViaConnectionInput) {
  const connection = await getSupplierConnection(input.businessId, input.connectionId);

  if (connection.status !== SupplierConnectionStatus.ACTIVE) {
    throw new InventoryValidationError("Connection is not active");
  }

  if (
    connection.connectionType !== SupplierConnectionType.MANUAL &&
    connection.connectionType !== SupplierConnectionType.EMAIL
  ) {
    throw new InventoryValidationError(
      "Order sharing is only supported for MANUAL or EMAIL connections"
    );
  }

  const purchaseOrder = await purchaseOrderService.markPurchaseOrderShared({
    businessId: input.businessId,
    purchaseOrderId: input.purchaseOrderId,
    sharedAt: input.sharedAt,
  });

  await prisma.supplierConnection.update({
    where: { id: connection.id },
    data: { lastSyncAt: new Date() },
  });

  return purchaseOrder;
}
