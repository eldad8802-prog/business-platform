-- AlterTable: Invoice Record projection fields for authority allocation (read model copy).
-- Write Source of Truth remains BillingAuthoritySubmission; no backfill in this migration.
ALTER TABLE "BillingDocument" ADD COLUMN "allocationNumber" TEXT;
ALTER TABLE "BillingDocument" ADD COLUMN "allocationApprovedAt" TIMESTAMP(3);
ALTER TABLE "BillingDocument" ADD COLUMN "isEmergencyAllocation" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "BillingDocument_businessId_allocationNumber_idx" ON "BillingDocument"("businessId", "allocationNumber");
