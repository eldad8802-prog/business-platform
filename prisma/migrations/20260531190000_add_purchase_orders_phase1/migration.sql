-- Phase 1: Purchase Orders as ordering intent only.
-- No receiving tables, no stock mutations, and no SupplierPurchaseDraft FK.

CREATE TYPE "PurchaseOrderStatus" AS ENUM (
  'DRAFT',
  'CONFIRMED',
  'SENT',
  'AWAITING_DELIVERY',
  'CLOSED',
  'CANCELLED'
);

CREATE TYPE "PurchaseOrderLineStatus" AS ENUM (
  'ORDERED',
  'CANCELLED'
);

CREATE TABLE "PurchaseOrder" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "supplierName" TEXT,
  "externalOrderId" TEXT,
  "source" TEXT DEFAULT 'MANUAL',
  "orderDate" TIMESTAMP(3),
  "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
  "createdByUserId" INTEGER,
  "sourceSupplierPurchaseDraftId" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PurchaseOrderLine" (
  "id" SERIAL NOT NULL,
  "purchaseOrderId" INTEGER NOT NULL,
  "itemId" INTEGER,
  "rawName" TEXT,
  "sku" TEXT,
  "barcode" TEXT,
  "orderedQty" DOUBLE PRECISION NOT NULL,
  "unitType" "InventoryUnitType",
  "status" "PurchaseOrderLineStatus" NOT NULL DEFAULT 'ORDERED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PurchaseOrderLine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PurchaseOrder_businessId_idx" ON "PurchaseOrder"("businessId");
CREATE INDEX "PurchaseOrder_businessId_status_idx" ON "PurchaseOrder"("businessId", "status");
CREATE INDEX "PurchaseOrder_businessId_createdAt_idx" ON "PurchaseOrder"("businessId", "createdAt");
CREATE INDEX "PurchaseOrder_businessId_supplierName_idx" ON "PurchaseOrder"("businessId", "supplierName");
CREATE INDEX "PurchaseOrder_businessId_source_externalOrderId_idx" ON "PurchaseOrder"("businessId", "source", "externalOrderId");
CREATE INDEX "PurchaseOrder_sourceSupplierPurchaseDraftId_idx" ON "PurchaseOrder"("sourceSupplierPurchaseDraftId");

CREATE INDEX "PurchaseOrderLine_purchaseOrderId_idx" ON "PurchaseOrderLine"("purchaseOrderId");
CREATE INDEX "PurchaseOrderLine_itemId_idx" ON "PurchaseOrderLine"("itemId");
CREATE INDEX "PurchaseOrderLine_purchaseOrderId_status_idx" ON "PurchaseOrderLine"("purchaseOrderId", "status");
CREATE INDEX "PurchaseOrderLine_sku_idx" ON "PurchaseOrderLine"("sku");
CREATE INDEX "PurchaseOrderLine_barcode_idx" ON "PurchaseOrderLine"("barcode");

ALTER TABLE "PurchaseOrder"
  ADD CONSTRAINT "PurchaseOrder_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PurchaseOrderLine"
  ADD CONSTRAINT "PurchaseOrderLine_purchaseOrderId_fkey"
  FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PurchaseOrderLine"
  ADD CONSTRAINT "PurchaseOrderLine_itemId_fkey"
  FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
