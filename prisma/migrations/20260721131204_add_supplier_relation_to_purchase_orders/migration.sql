-- Supplier Foundation S4-P1 — PurchaseOrder <-> Supplier entity relation.
-- Party Identity Strategy Tier 2 (Entity-FK). Additive, nullable, expand-only.
-- `supplierName` (Tier 1 snapshot) is unchanged; no backfill, no data change,
-- no write-path change (that is P2). Supplier deletion sets supplierId NULL and
-- never removes purchase history. See docs/dubiz-party-identity-strategy-v1.md.

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "supplierId" INTEGER;

-- CreateIndex
CREATE INDEX "PurchaseOrder_businessId_supplierId_idx" ON "PurchaseOrder"("businessId", "supplierId");

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
