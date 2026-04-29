-- CreateTable
CREATE TABLE "InventoryExternalSale" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "externalSaleId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryExternalSale_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InventoryExternalSale_businessId_idx" ON "InventoryExternalSale"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryExternalSale_businessId_externalSaleId_key" ON "InventoryExternalSale"("businessId", "externalSaleId");
