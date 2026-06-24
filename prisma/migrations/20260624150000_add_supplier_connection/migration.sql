-- CreateEnum
CREATE TYPE "SupplierConnectionType" AS ENUM ('MANUAL', 'EMAIL', 'CSV_IMPORT', 'API_PLACEHOLDER');

-- CreateEnum
CREATE TYPE "SupplierConnectionStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "SupplierConnectionCapability" AS ENUM ('CAN_IMPORT_CATALOG', 'CAN_RECEIVE_ORDER', 'CAN_REPORT_STATUS', 'CAN_REPORT_AVAILABILITY');

-- AlterTable
ALTER TABLE "CatalogSource" ADD COLUMN     "connectionId" INTEGER;

-- CreateTable
CREATE TABLE "SupplierConnection" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "supplierId" INTEGER NOT NULL,
    "connectionType" "SupplierConnectionType" NOT NULL,
    "status" "SupplierConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "capabilities" "SupplierConnectionCapability"[],
    "metadata" JSONB,
    "lastSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupplierConnection_businessId_idx" ON "SupplierConnection"("businessId");

-- CreateIndex
CREATE INDEX "SupplierConnection_supplierId_idx" ON "SupplierConnection"("supplierId");

-- CreateIndex
CREATE INDEX "SupplierConnection_businessId_supplierId_idx" ON "SupplierConnection"("businessId", "supplierId");

-- CreateIndex
CREATE INDEX "SupplierConnection_businessId_status_idx" ON "SupplierConnection"("businessId", "status");

-- CreateIndex
CREATE INDEX "CatalogSource_connectionId_idx" ON "CatalogSource"("connectionId");

-- AddForeignKey
ALTER TABLE "SupplierConnection" ADD CONSTRAINT "SupplierConnection_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierConnection" ADD CONSTRAINT "SupplierConnection_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogSource" ADD CONSTRAINT "CatalogSource_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "SupplierConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

