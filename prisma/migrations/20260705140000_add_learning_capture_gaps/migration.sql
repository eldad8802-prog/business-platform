-- Learning capture gaps (additive, nullable) — see
-- docs/documents-learning-mechanism-architecture-v1.md §5.
-- Gap 1: capture failed / no-extraction documents in the ledger.
ALTER TABLE "ExtractionSnapshot" ADD COLUMN "extractionOutcome" TEXT;
-- Gap 3: capture engine confidence in the routing (documentType) decision.
ALTER TABLE "ExtractionSnapshot" ADD COLUMN "documentTypeConfidence" TEXT;
-- Gap 2: capture a stable normalized vendor key alongside the raw name.
ALTER TABLE "VendorLearning" ADD COLUMN "vendorNameNormalized" TEXT;
CREATE INDEX "VendorLearning_businessId_vendorNameNormalized_idx" ON "VendorLearning"("businessId", "vendorNameNormalized");
