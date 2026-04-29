-- CreateEnum
CREATE TYPE "InventoryUnitType" AS ENUM ('UNIT', 'ML', 'GRAM', 'KG', 'LITER', 'BOX');

-- CreateEnum
CREATE TYPE "InventoryMovementType" AS ENUM ('IN', 'OUT', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "InventoryMovementReason" AS ENUM ('INITIAL_STOCK', 'MANUAL_ADD', 'MANUAL_REMOVE', 'SALE', 'RETURN', 'DAMAGE', 'INVENTORY_COUNT_CORRECTION');

-- CreateEnum
CREATE TYPE "InventoryDraftStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'MERGED');

-- CreateEnum
CREATE TYPE "InventoryAlertType" AS ENUM ('LOW_STOCK', 'UNMATCHED_POS_PRODUCT');

-- CreateEnum
CREATE TYPE "POSConnectionStatus" AS ENUM ('ACTIVE', 'DISCONNECTED', 'ERROR');

-- CreateEnum
CREATE TYPE "POSSaleEventStatus" AS ENUM ('RECEIVED', 'MAPPED', 'APPLIED', 'FAILED', 'UNMATCHED');

-- CreateEnum
CREATE TYPE "POSMappingStatus" AS ENUM ('MAPPED', 'UNMAPPED');

-- CreateTable
CREATE TABLE "InventoryItem" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "barcode" TEXT,
    "unitType" "InventoryUnitType" NOT NULL,
    "currentQuantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "minimumQuantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reorderPoint" DOUBLE PRECISION,
    "costPerUnit" DOUBLE PRECISION,
    "sellPricePerUnit" DOUBLE PRECISION,
    "imageUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryMovement" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "itemId" INTEGER NOT NULL,
    "movementType" "InventoryMovementType" NOT NULL,
    "reason" "InventoryMovementReason" NOT NULL,
    "quantityDelta" DOUBLE PRECISION NOT NULL,
    "quantityBefore" DOUBLE PRECISION NOT NULL,
    "quantityAfter" DOUBLE PRECISION NOT NULL,
    "note" TEXT,
    "createdByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryDraft" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "imageUrl" TEXT,
    "detectedName" TEXT,
    "detectedCategory" TEXT,
    "detectedBarcode" TEXT,
    "detectedUnitType" "InventoryUnitType",
    "confidenceScore" DOUBLE PRECISION,
    "status" "InventoryDraftStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "createdByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryAlert" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "itemId" INTEGER,
    "type" "InventoryAlertType" NOT NULL,
    "message" TEXT,
    "isResolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "POSConnection" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "POSConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "POSConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "POSSaleEvent" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "externalSaleId" TEXT NOT NULL,
    "externalLineId" TEXT,
    "rawPayload" JSONB NOT NULL,
    "status" "POSSaleEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "POSSaleEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "POSProductMapping" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "externalProductId" TEXT,
    "externalSku" TEXT,
    "externalBarcode" TEXT,
    "inventoryItemId" INTEGER,
    "status" "POSMappingStatus" NOT NULL DEFAULT 'UNMAPPED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "POSProductMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InventoryItem_businessId_idx" ON "InventoryItem"("businessId");

-- CreateIndex
CREATE INDEX "InventoryItem_sku_idx" ON "InventoryItem"("sku");

-- CreateIndex
CREATE INDEX "InventoryItem_barcode_idx" ON "InventoryItem"("barcode");

-- CreateIndex
CREATE INDEX "InventoryItem_businessId_isActive_idx" ON "InventoryItem"("businessId", "isActive");

-- CreateIndex
CREATE INDEX "InventoryMovement_businessId_idx" ON "InventoryMovement"("businessId");

-- CreateIndex
CREATE INDEX "InventoryMovement_itemId_idx" ON "InventoryMovement"("itemId");

-- CreateIndex
CREATE INDEX "InventoryMovement_createdByUserId_idx" ON "InventoryMovement"("createdByUserId");

-- CreateIndex
CREATE INDEX "InventoryMovement_businessId_createdAt_idx" ON "InventoryMovement"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryDraft_businessId_idx" ON "InventoryDraft"("businessId");

-- CreateIndex
CREATE INDEX "InventoryDraft_createdByUserId_idx" ON "InventoryDraft"("createdByUserId");

-- CreateIndex
CREATE INDEX "InventoryDraft_status_idx" ON "InventoryDraft"("status");

-- CreateIndex
CREATE INDEX "InventoryAlert_businessId_idx" ON "InventoryAlert"("businessId");

-- CreateIndex
CREATE INDEX "InventoryAlert_itemId_idx" ON "InventoryAlert"("itemId");

-- CreateIndex
CREATE INDEX "InventoryAlert_type_idx" ON "InventoryAlert"("type");

-- CreateIndex
CREATE INDEX "InventoryAlert_isResolved_idx" ON "InventoryAlert"("isResolved");

-- CreateIndex
CREATE INDEX "POSConnection_businessId_idx" ON "POSConnection"("businessId");

-- CreateIndex
CREATE INDEX "POSConnection_provider_idx" ON "POSConnection"("provider");

-- CreateIndex
CREATE INDEX "POSConnection_status_idx" ON "POSConnection"("status");

-- CreateIndex
CREATE INDEX "POSSaleEvent_businessId_idx" ON "POSSaleEvent"("businessId");

-- CreateIndex
CREATE INDEX "POSSaleEvent_provider_idx" ON "POSSaleEvent"("provider");

-- CreateIndex
CREATE INDEX "POSSaleEvent_externalSaleId_idx" ON "POSSaleEvent"("externalSaleId");

-- CreateIndex
CREATE INDEX "POSSaleEvent_status_idx" ON "POSSaleEvent"("status");

-- CreateIndex
CREATE INDEX "POSSaleEvent_businessId_createdAt_idx" ON "POSSaleEvent"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "POSProductMapping_businessId_idx" ON "POSProductMapping"("businessId");

-- CreateIndex
CREATE INDEX "POSProductMapping_provider_idx" ON "POSProductMapping"("provider");

-- CreateIndex
CREATE INDEX "POSProductMapping_inventoryItemId_idx" ON "POSProductMapping"("inventoryItemId");

-- CreateIndex
CREATE INDEX "POSProductMapping_status_idx" ON "POSProductMapping"("status");

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryDraft" ADD CONSTRAINT "InventoryDraft_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryDraft" ADD CONSTRAINT "InventoryDraft_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryAlert" ADD CONSTRAINT "InventoryAlert_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryAlert" ADD CONSTRAINT "InventoryAlert_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSConnection" ADD CONSTRAINT "POSConnection_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSSaleEvent" ADD CONSTRAINT "POSSaleEvent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSProductMapping" ADD CONSTRAINT "POSProductMapping_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSProductMapping" ADD CONSTRAINT "POSProductMapping_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
