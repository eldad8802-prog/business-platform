-- AlterTable
ALTER TABLE "InventoryDraft" ADD COLUMN     "mergedToItemId" INTEGER;

-- AddForeignKey
ALTER TABLE "InventoryDraft" ADD CONSTRAINT "InventoryDraft_mergedToItemId_fkey" FOREIGN KEY ("mergedToItemId") REFERENCES "InventoryItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
