-- Additive-only Phase 1A immutable issued foundation fields.
ALTER TABLE "BillingDocument"
ADD COLUMN "lockedAt" TIMESTAMP(3),
ADD COLUMN "legalSnapshotHash" TEXT;
