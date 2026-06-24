-- Supplier Domain Phase 3 — Measure / Representation Conversion (additive only).
-- Adds the Measure dimension (purchase-unit ↔ stock-unit `factor`) to
-- RepresentationMapping, and immutable per-order Measure snapshots to
-- PurchaseOrderLine and ReceivingLine. `factor` NULL ⇒ 1:1 (no behavior change
-- for existing data). No Catalog, no price-list, no availability, no connectivity.

-- AlterTable
ALTER TABLE "RepresentationMapping" ADD COLUMN     "purchaseUnitName" TEXT,
ADD COLUMN     "factor" DOUBLE PRECISION,
ADD COLUMN     "measureConfidence" "PartyClaimConfidence",
ADD COLUMN     "measureSource" TEXT,
ADD COLUMN     "measureResolvedByUserId" INTEGER;

-- AlterTable
ALTER TABLE "PurchaseOrderLine" ADD COLUMN     "purchaseUnitName" TEXT,
ADD COLUMN     "purchaseQty" DOUBLE PRECISION,
ADD COLUMN     "conversionFactor" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "ReceivingLine" ADD COLUMN     "purchaseUnitName" TEXT,
ADD COLUMN     "receivedPurchaseQty" DOUBLE PRECISION,
ADD COLUMN     "conversionFactor" DOUBLE PRECISION;
