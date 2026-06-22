-- Supplier Domain Phase 1 — Supplier as Party Role (additive only).
-- Adds optional taxId identity signal to Supplier, the SUPPLIER party role,
-- and the HUMAN_CONFIRMED resolution method. No data backfill here; no FK to
-- Party (the link is a corrigible PartyResolutionClaim, not a hard FK).

-- AlterEnum
ALTER TYPE "PartyRoleType" ADD VALUE 'SUPPLIER';

-- AlterEnum
ALTER TYPE "PartyResolutionMethod" ADD VALUE 'HUMAN_CONFIRMED';

-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN     "taxId" TEXT,
ADD COLUMN     "taxIdType" "CustomerTaxIdType";

-- CreateIndex
CREATE INDEX "Supplier_businessId_taxId_idx" ON "Supplier"("businessId", "taxId");
