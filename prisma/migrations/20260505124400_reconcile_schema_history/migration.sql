-- CreateEnum
CREATE TYPE "SupplierPurchaseDraftStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "SupplierLineDecision" AS ENUM ('MERGE', 'CREATE_NEW', 'REVIEW');

-- CreateEnum
CREATE TYPE "SupplierLineStatus" AS ENUM ('PENDING', 'MATCHED', 'NEEDS_REVIEW', 'APPROVED', 'REJECTED');

-- AlterEnum
ALTER TYPE "InventoryMovementReason" ADD VALUE 'SUPPLIER_PURCHASE';

-- DropForeignKey
ALTER TABLE "InventoryDraft" DROP CONSTRAINT "InventoryDraft_createdByUserId_fkey";

-- DropForeignKey
ALTER TABLE "InventoryMovement" DROP CONSTRAINT "InventoryMovement_createdByUserId_fkey";

-- DropForeignKey
ALTER TABLE "InventoryPendingMatch" DROP CONSTRAINT "InventoryPendingMatch_resolvedByUserId_fkey";

-- DropForeignKey
ALTER TABLE "POSConnection" DROP CONSTRAINT "POSConnection_businessId_fkey";

-- DropForeignKey
ALTER TABLE "POSProductMapping" DROP CONSTRAINT "POSProductMapping_inventoryItemId_fkey";

-- DropForeignKey
ALTER TABLE "POSSaleEvent" DROP CONSTRAINT "POSSaleEvent_businessId_fkey";

-- DropIndex
DROP INDEX "InventoryAlert_isResolved_idx";

-- DropIndex
DROP INDEX "InventoryAlert_type_idx";

-- DropIndex
DROP INDEX "InventoryDraft_createdByUserId_idx";

-- DropIndex
DROP INDEX "InventoryMovement_createdByUserId_idx";

-- DropIndex
DROP INDEX "InventoryPendingMatch_resolvedByUserId_idx";

-- DropIndex
DROP INDEX "InventoryPendingMatch_resolvedItemId_idx";

-- DropIndex
DROP INDEX "POSProductMapping_inventoryItemId_idx";

-- DropIndex
DROP INDEX "POSProductMapping_provider_idx";

-- DropIndex
DROP INDEX "POSProductMapping_status_idx";

-- AlterTable
ALTER TABLE "ExtractedData" DROP COLUMN "categorySource",
DROP COLUMN "categoryStatus",
DROP COLUMN "dateConfidence",
DROP COLUMN "suggestedCategoryLabel";

-- AlterTable
ALTER TABLE "InventoryAlert" ADD COLUMN     "resolvedAt" TIMESTAMP(3),
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "InventoryDraft" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "InventoryExternalSale" ALTER COLUMN "source" DROP NOT NULL;

-- AlterTable
ALTER TABLE "InventoryItem" ADD COLUMN     "categoryId" INTEGER;

-- AlterTable
ALTER TABLE "POSProductMapping" DROP COLUMN "externalBarcode",
DROP COLUMN "externalSku",
DROP COLUMN "inventoryItemId",
DROP COLUMN "provider",
DROP COLUMN "status",
ADD COLUMN     "barcode" TEXT,
ADD COLUMN     "itemId" INTEGER NOT NULL,
ADD COLUMN     "name" TEXT,
ADD COLUMN     "sku" TEXT,
ADD COLUMN     "source" TEXT NOT NULL,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- DropTable
DROP TABLE "POSConnection";

-- DropTable
DROP TABLE "POSSaleEvent";

-- DropEnum
DROP TYPE "POSConnectionStatus";

-- DropEnum
DROP TYPE "POSMappingStatus";

-- DropEnum
DROP TYPE "POSSaleEventStatus";

-- CreateTable
CREATE TABLE "InventoryCategory" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierPurchaseDraft" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "supplierName" TEXT,
    "externalOrderId" TEXT,
    "source" TEXT,
    "orderDate" TIMESTAMP(3),
    "status" "SupplierPurchaseDraftStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "createdByUserId" INTEGER,

    CONSTRAINT "SupplierPurchaseDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierPurchaseDraftLine" (
    "id" SERIAL NOT NULL,
    "draftId" INTEGER NOT NULL,
    "rawName" TEXT,
    "sku" TEXT,
    "barcode" TEXT,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unitType" "InventoryUnitType",
    "matchedItemId" INTEGER,
    "matchScore" DOUBLE PRECISION,
    "decision" "SupplierLineDecision",
    "status" "SupplierLineStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierPurchaseDraftLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InventoryCategory_businessId_idx" ON "InventoryCategory"("businessId");

-- CreateIndex
CREATE INDEX "SupplierPurchaseDraft_businessId_idx" ON "SupplierPurchaseDraft"("businessId");

-- CreateIndex
CREATE INDEX "SupplierPurchaseDraft_businessId_status_idx" ON "SupplierPurchaseDraft"("businessId", "status");

-- CreateIndex
CREATE INDEX "SupplierPurchaseDraftLine_draftId_idx" ON "SupplierPurchaseDraftLine"("draftId");

-- CreateIndex
CREATE INDEX "SupplierPurchaseDraftLine_matchedItemId_idx" ON "SupplierPurchaseDraftLine"("matchedItemId");

-- CreateIndex
CREATE INDEX "InventoryAlert_pendingMatchId_idx" ON "InventoryAlert"("pendingMatchId");

-- CreateIndex
CREATE INDEX "InventoryAlert_businessId_isResolved_idx" ON "InventoryAlert"("businessId", "isResolved");

-- CreateIndex
CREATE INDEX "InventoryAlert_businessId_type_idx" ON "InventoryAlert"("businessId", "type");

-- CreateIndex
CREATE INDEX "InventoryDraft_businessId_status_idx" ON "InventoryDraft"("businessId", "status");

-- CreateIndex
CREATE INDEX "InventoryPendingMatch_businessId_status_idx" ON "InventoryPendingMatch"("businessId", "status");

-- CreateIndex
CREATE INDEX "POSProductMapping_itemId_idx" ON "POSProductMapping"("itemId");

-- CreateIndex
CREATE INDEX "POSProductMapping_sku_idx" ON "POSProductMapping"("sku");

-- CreateIndex
CREATE INDEX "POSProductMapping_barcode_idx" ON "POSProductMapping"("barcode");

-- CreateIndex
CREATE UNIQUE INDEX "POSProductMapping_businessId_source_externalProductId_key" ON "POSProductMapping"("businessId", "source", "externalProductId");

-- AddForeignKey
ALTER TABLE "InventoryCategory" ADD CONSTRAINT "InventoryCategory_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "InventoryCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryExternalSale" ADD CONSTRAINT "InventoryExternalSale_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POSProductMapping" ADD CONSTRAINT "POSProductMapping_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPurchaseDraft" ADD CONSTRAINT "SupplierPurchaseDraft_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPurchaseDraftLine" ADD CONSTRAINT "SupplierPurchaseDraftLine_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "SupplierPurchaseDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPurchaseDraftLine" ADD CONSTRAINT "SupplierPurchaseDraftLine_matchedItemId_fkey" FOREIGN KEY ("matchedItemId") REFERENCES "InventoryItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

