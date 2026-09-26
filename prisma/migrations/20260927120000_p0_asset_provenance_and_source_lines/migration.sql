-- Additive. Separate from 20260926120000_p0_business_evidence.
-- No backfill of prices, selections, impressions, or assets.

CREATE TYPE "BusinessAssetOrigin" AS ENUM ('OWNER_UPLOAD', 'GENERATED');

CREATE TABLE "BusinessAsset" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "origin" "BusinessAssetOrigin" NOT NULL,
  "storageKey" TEXT,
  "assetRef" TEXT,
  "contentRunId" INTEGER,
  "publicUseApproved" BOOLEAN NOT NULL DEFAULT false,
  "idempotencyKey" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BusinessAsset_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BusinessAsset_reference_present" CHECK ("storageKey" IS NOT NULL OR "assetRef" IS NOT NULL)
);

CREATE UNIQUE INDEX "BusinessAsset_businessId_idempotencyKey_key"
  ON "BusinessAsset"("businessId", "idempotencyKey");
CREATE UNIQUE INDEX "BusinessAsset_businessId_storageKey_key"
  ON "BusinessAsset"("businessId", "storageKey");
CREATE INDEX "BusinessAsset_businessId_createdAt_idx"
  ON "BusinessAsset"("businessId", "createdAt");

ALTER TABLE "BusinessAsset"
  ADD CONSTRAINT "BusinessAsset_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BusinessAsset"
  ADD CONSTRAINT "BusinessAsset_contentRunId_businessId_fkey"
  FOREIGN KEY ("contentRunId", "businessId")
  REFERENCES "ContentRun"("id", "businessId")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "InventorySaleLine_id_businessId_key"
  ON "InventorySaleLine"("id", "businessId");

CREATE TABLE "InventorySourceSaleLine" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "externalSaleId" TEXT NOT NULL,
  "lineKey" TEXT NOT NULL,
  "sku" TEXT,
  "barcode" TEXT,
  "name" TEXT,
  "quantity" DOUBLE PRECISION NOT NULL,
  "unitPrice" DECIMAL(18,2),
  "recognizedItemId" INTEGER,
  "saleLineId" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventorySourceSaleLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InventorySourceSaleLine_businessId_externalSaleId_lineKey_key"
  ON "InventorySourceSaleLine"("businessId", "externalSaleId", "lineKey");
CREATE INDEX "InventorySourceSaleLine_businessId_createdAt_idx"
  ON "InventorySourceSaleLine"("businessId", "createdAt");

ALTER TABLE "InventorySourceSaleLine"
  ADD CONSTRAINT "InventorySourceSaleLine_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InventorySourceSaleLine"
  ADD CONSTRAINT "InventorySourceSaleLine_recognizedItemId_businessId_fkey"
  FOREIGN KEY ("recognizedItemId", "businessId")
  REFERENCES "InventoryItem"("id", "businessId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InventorySourceSaleLine"
  ADD CONSTRAINT "InventorySourceSaleLine_saleLineId_businessId_fkey"
  FOREIGN KEY ("saleLineId", "businessId")
  REFERENCES "InventorySaleLine"("id", "businessId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InventoryPendingMatch" ADD COLUMN "resolvedMovementId" INTEGER;

ALTER TABLE "InventoryPendingMatch"
  ADD CONSTRAINT "InventoryPendingMatch_resolvedMovementId_businessId_fkey"
  FOREIGN KEY ("resolvedMovementId", "businessId")
  REFERENCES "InventoryMovement"("id", "businessId")
  ON DELETE SET NULL ON UPDATE CASCADE;
