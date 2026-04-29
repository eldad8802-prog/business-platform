-- DropForeignKey
ALTER TABLE "InventoryPendingMatch" DROP CONSTRAINT "InventoryPendingMatch_businessId_fkey";

-- AlterTable
ALTER TABLE "ExtractedData" ADD COLUMN     "amountConfidence" TEXT,
ADD COLUMN     "category" TEXT,
ADD COLUMN     "categoryConfidence" TEXT,
ADD COLUMN     "dateConfidence" TEXT,
ADD COLUMN     "vendorConfidence" TEXT;

-- AlterTable
ALTER TABLE "InventoryAlert" ADD COLUMN     "pendingMatchId" INTEGER;

-- AddForeignKey
ALTER TABLE "InventoryAlert" ADD CONSTRAINT "InventoryAlert_pendingMatchId_fkey" FOREIGN KEY ("pendingMatchId") REFERENCES "InventoryPendingMatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryPendingMatch" ADD CONSTRAINT "InventoryPendingMatch_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
