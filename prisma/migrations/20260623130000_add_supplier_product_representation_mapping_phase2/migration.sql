-- Supplier Domain Phase 2 — Identity Learning (additive only).
-- Adds SupplierProduct (Reported Reality reference, scoped to a Supplier) and
-- RepresentationMapping (corrigible Identity binding-belief, mirrors
-- PartyResolutionClaim) plus an optional forward-link on the draft line.
-- Reuses the existing Party* enums (Representation Resolution is the same
-- canonical pattern). No Catalog, no Measure, no price/availability columns.
-- Single ACTIVE mapping per SupplierProduct is enforced in application code.

-- CreateTable
CREATE TABLE "SupplierProduct" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "supplierId" INTEGER NOT NULL,
    "externalSku" TEXT,
    "barcode" TEXT,
    "rawName" TEXT,
    "normalizedName" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepresentationMapping" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "supplierProductId" INTEGER NOT NULL,
    "inventoryItemId" INTEGER NOT NULL,
    "identityConfidence" "PartyClaimConfidence" NOT NULL,
    "method" "PartyResolutionMethod" NOT NULL DEFAULT 'HUMAN_CONFIRMED',
    "identitySignal" TEXT,
    "source" TEXT NOT NULL,
    "resolvedByUserId" INTEGER,
    "status" "PartyClaimStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepresentationMapping_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "SupplierPurchaseDraftLine" ADD COLUMN     "supplierProductId" INTEGER;

-- CreateIndex
CREATE INDEX "SupplierProduct_businessId_idx" ON "SupplierProduct"("businessId");

-- CreateIndex
CREATE INDEX "SupplierProduct_supplierId_idx" ON "SupplierProduct"("supplierId");

-- CreateIndex
CREATE INDEX "SupplierProduct_supplierId_externalSku_idx" ON "SupplierProduct"("supplierId", "externalSku");

-- CreateIndex
CREATE INDEX "SupplierProduct_supplierId_barcode_idx" ON "SupplierProduct"("supplierId", "barcode");

-- CreateIndex
CREATE INDEX "SupplierProduct_supplierId_normalizedName_idx" ON "SupplierProduct"("supplierId", "normalizedName");

-- CreateIndex
CREATE INDEX "RepresentationMapping_businessId_idx" ON "RepresentationMapping"("businessId");

-- CreateIndex
CREATE INDEX "RepresentationMapping_supplierProductId_idx" ON "RepresentationMapping"("supplierProductId");

-- CreateIndex
CREATE INDEX "RepresentationMapping_supplierProductId_status_idx" ON "RepresentationMapping"("supplierProductId", "status");

-- CreateIndex
CREATE INDEX "RepresentationMapping_businessId_inventoryItemId_idx" ON "RepresentationMapping"("businessId", "inventoryItemId");

-- CreateIndex
CREATE INDEX "RepresentationMapping_businessId_status_idx" ON "RepresentationMapping"("businessId", "status");

-- CreateIndex
CREATE INDEX "SupplierPurchaseDraftLine_supplierProductId_idx" ON "SupplierPurchaseDraftLine"("supplierProductId");

-- AddForeignKey
ALTER TABLE "SupplierProduct" ADD CONSTRAINT "SupplierProduct_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierProduct" ADD CONSTRAINT "SupplierProduct_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepresentationMapping" ADD CONSTRAINT "RepresentationMapping_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepresentationMapping" ADD CONSTRAINT "RepresentationMapping_supplierProductId_fkey" FOREIGN KEY ("supplierProductId") REFERENCES "SupplierProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepresentationMapping" ADD CONSTRAINT "RepresentationMapping_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPurchaseDraftLine" ADD CONSTRAINT "SupplierPurchaseDraftLine_supplierProductId_fkey" FOREIGN KEY ("supplierProductId") REFERENCES "SupplierProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;
