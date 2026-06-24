/**
 * Supplier Connections Foundation — end-to-end (run manually, DIRECT url):
 *   DATABASE_URL=$DIRECT_URL npx tsx lib/services/inventory/supplier-connection.service.e2e.test.ts
 *
 * Proves the Foundation wires existing capabilities WITHOUT any external I/O:
 *   - a connection can be created / listed / updated / deactivated,
 *   - a connection never changes Supplier Identity or InventoryItem,
 *   - creating a connection creates NO catalog claims on its own,
 *   - importing via a MANUAL/CSV connection creates CatalogSource (+connectionId)
 *     and CatalogClaims through the existing ingestion,
 *   - sharing an order via a MANUAL/EMAIL connection sets sharedAt without
 *     changing PO status,
 *   - API_PLACEHOLDER / inactive connections are rejected for import.
 */
import assert from "node:assert/strict";
import {
  InventoryUnitType,
  PurchaseOrderStatus,
  SupplierConnectionCapability,
  SupplierConnectionStatus,
  SupplierConnectionType,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { deleteTestBusinesses } from "@/lib/testing/cleanup-test-businesses";
import { purchaseOrderService } from "@/lib/services/inventory/purchase-order.service";
import {
  createSupplierConnection,
  listSupplierConnections,
  getSupplierConnection,
  updateSupplierConnection,
  deactivateSupplierConnection,
  importCatalogViaConnection,
  shareOrderViaConnection,
} from "@/lib/services/inventory/supplier-connection.service";

const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

async function main() {
  const business = await prisma.business.create({
    data: {
      name: `Conn ${runId}`,
      users: { create: { email: `conn-${runId}@example.test`, password: "test-password", name: "Conn" } },
    },
    include: { users: true },
  });
  const businessId = business.id;
  const userId = business.users[0].id;
  const supplier = await prisma.supplier.create({
    data: { businessId, name: `ACME ${runId}`, taxId: "514000000" },
  });
  const item = await prisma.inventoryItem.create({
    data: { businessId, name: `Item ${runId}`, unitType: InventoryUnitType.UNIT, currentQuantity: 0, minimumQuantity: 0 },
  });

  try {
    const itemsBefore = await prisma.inventoryItem.count({ where: { businessId } });
    const supplierBefore = await prisma.supplier.findUniqueOrThrow({ where: { id: supplier.id } });

    // ===== Create connection =====
    const connection = await createSupplierConnection({
      businessId,
      supplierId: supplier.id,
      connectionType: SupplierConnectionType.MANUAL,
      capabilities: [
        SupplierConnectionCapability.CAN_IMPORT_CATALOG,
        SupplierConnectionCapability.CAN_RECEIVE_ORDER,
      ],
    });
    assert.equal(connection.status, SupplierConnectionStatus.ACTIVE, "new connection ACTIVE");
    assert.equal(connection.capabilities.length, 2, "capabilities stored");
    assert.equal(connection.lastSyncAt, null, "no sync yet");

    // Connection changes neither Supplier Identity nor InventoryItem.
    const supplierAfter = await prisma.supplier.findUniqueOrThrow({ where: { id: supplier.id } });
    assert.equal(supplierAfter.name, supplierBefore.name, "supplier name unchanged");
    assert.equal(supplierAfter.taxId, supplierBefore.taxId, "supplier taxId unchanged");
    assert.equal(await prisma.supplierProduct.count({ where: { businessId } }), 0, "no SupplierProduct from connection");
    assert.equal(await prisma.inventoryItem.count({ where: { businessId } }), itemsBefore, "InventoryItem unchanged");

    // Creating a connection creates NO catalog claims on its own.
    assert.equal(await prisma.catalogClaim.count({ where: { businessId } }), 0, "no CatalogClaim from connection alone");
    assert.equal(await prisma.catalogSource.count({ where: { businessId } }), 0, "no CatalogSource from connection alone");

    // ===== CRUD =====
    const list = await listSupplierConnections({ businessId, supplierId: supplier.id });
    assert.equal(list.length, 1, "list returns the connection");
    const fetched = await getSupplierConnection(businessId, connection.id);
    assert.equal(fetched.id, connection.id, "get returns the connection");
    const updated = await updateSupplierConnection({
      businessId,
      connectionId: connection.id,
      capabilities: [
        SupplierConnectionCapability.CAN_IMPORT_CATALOG,
        SupplierConnectionCapability.CAN_RECEIVE_ORDER,
        SupplierConnectionCapability.CAN_REPORT_AVAILABILITY,
      ],
      metadata: { note: "primary" },
    });
    assert.equal(updated.capabilities.length, 3, "update adds capability");

    // ===== Catalog import via MANUAL connection → CatalogSource(+connectionId) + claims =====
    const result = await importCatalogViaConnection({
      businessId,
      connectionId: connection.id,
      actorUserId: userId,
      rows: [{ externalSku: "SKU-1", name: "Cola", askingPrice: 120, currency: "ILS", availability: "IN_STOCK" }],
    });
    assert.equal(result.productsResolved, 1, "import resolved one product");
    assert.ok(result.claimsRecorded >= 1, "import recorded catalog claims");

    const source = await prisma.catalogSource.findUniqueOrThrow({ where: { id: result.sourceId } });
    assert.equal(source.connectionId, connection.id, "CatalogSource stamped with connectionId");
    assert.ok((await prisma.catalogClaim.count({ where: { businessId } })) >= 1, "CatalogClaims created via ingestion");

    const afterImport = await getSupplierConnection(businessId, connection.id);
    assert.ok(afterImport.lastSyncAt, "lastSyncAt set after import");

    // ===== Order sharing via connection → sharedAt set, PO status unchanged =====
    const po = await purchaseOrderService.createPurchaseOrder({
      businessId,
      createdByUserId: userId,
      status: PurchaseOrderStatus.CONFIRMED,
      lines: [{ itemId: item.id, orderedQty: 10, unitCost: 5 }],
    });
    await shareOrderViaConnection({ businessId, connectionId: connection.id, purchaseOrderId: po.id });
    const poAfter = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
    assert.ok(poAfter.sharedAt, "PO sharedAt set via connection");
    assert.equal(poAfter.status, PurchaseOrderStatus.CONFIRMED, "PO status unchanged by sharing");

    // ===== API_PLACEHOLDER import is rejected =====
    const apiConn = await createSupplierConnection({
      businessId,
      supplierId: supplier.id,
      connectionType: SupplierConnectionType.API_PLACEHOLDER,
    });
    await assert.rejects(
      () => importCatalogViaConnection({ businessId, connectionId: apiConn.id, rows: [{ externalSku: "X", askingPrice: 1 }] }),
      /MANUAL or CSV_IMPORT/,
      "API_PLACEHOLDER cannot import catalog"
    );

    // ===== Deactivate → inactive connection rejected for import =====
    const deactivated = await deactivateSupplierConnection(businessId, connection.id);
    assert.equal(deactivated.status, SupplierConnectionStatus.INACTIVE, "deactivated → INACTIVE");
    await assert.rejects(
      () => importCatalogViaConnection({ businessId, connectionId: connection.id, rows: [{ externalSku: "Y", askingPrice: 2 }] }),
      /not active/,
      "inactive connection cannot import"
    );

    // Final: identity + inventory still untouched by anything connection-related.
    assert.equal(await prisma.inventoryItem.count({ where: { businessId } }), itemsBefore, "InventoryItem still unchanged");

    console.log("\nAll supplier-connection foundation e2e checks passed");
  } finally {
    await deleteTestBusinesses([businessId]);
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
