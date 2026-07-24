-- Customer Foundation C2-P1 — Customer lifecycle (active / inactive).
-- Additive, expand-only. Adds `isActive` (Boolean, DEFAULT true) so every existing
-- customer is treated as active — the column default is the backfill mechanism, so
-- no manual UPDATE / data change is performed. Adds a (businessId, isActive) index
-- for the CRM lifecycle list filter. No existing column, constraint, Billing,
-- Supplier or Party artifact is touched. Wiring (service/API/UI) is C2-P2.

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX "Customer_businessId_isActive_idx" ON "Customer"("businessId", "isActive");
