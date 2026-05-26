-- Additive-only Phase 2A credit/reversal foundation.
ALTER TYPE "BillingDocumentType" ADD VALUE 'CREDIT_NOTE';

ALTER TABLE "BillingDocument"
ADD COLUMN "referenceDocumentId" INTEGER;

ALTER TABLE "BillingDocument"
ADD CONSTRAINT "BillingDocument_referenceDocumentId_fkey"
FOREIGN KEY ("referenceDocumentId") REFERENCES "BillingDocument"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "BillingDocument_businessId_referenceDocumentId_idx"
ON "BillingDocument"("businessId", "referenceDocumentId");
