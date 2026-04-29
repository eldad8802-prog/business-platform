-- CreateEnum
CREATE TYPE "InventoryPendingMatchStatus" AS ENUM ('PENDING', 'RESOLVED', 'REJECTED');

-- CreateTable
CREATE TABLE "InventoryPendingMatch" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "externalSaleId" TEXT NOT NULL,
    "status" "InventoryPendingMatchStatus" NOT NULL DEFAULT 'PENDING',
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" INTEGER,
    "resolvedItemId" INTEGER,

    CONSTRAINT "InventoryPendingMatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InventoryPendingMatch_businessId_idx" ON "InventoryPendingMatch"("businessId");

-- CreateIndex
CREATE INDEX "InventoryPendingMatch_status_idx" ON "InventoryPendingMatch"("status");

-- CreateIndex
CREATE INDEX "InventoryPendingMatch_resolvedItemId_idx" ON "InventoryPendingMatch"("resolvedItemId");

-- CreateIndex
CREATE INDEX "InventoryPendingMatch_resolvedByUserId_idx" ON "InventoryPendingMatch"("resolvedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryPendingMatch_businessId_externalSaleId_key" ON "InventoryPendingMatch"("businessId", "externalSaleId");

-- AddForeignKey
ALTER TABLE "InventoryPendingMatch" ADD CONSTRAINT "InventoryPendingMatch_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryPendingMatch" ADD CONSTRAINT "InventoryPendingMatch_resolvedByUserId_fkey" FOREIGN KEY ("resolvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryPendingMatch" ADD CONSTRAINT "InventoryPendingMatch_resolvedItemId_fkey" FOREIGN KEY ("resolvedItemId") REFERENCES "InventoryItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
