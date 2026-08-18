-- Phase 2B-1 · Canonical signed PDF artifact metadata. Additive, expand-only.
-- Three nullable columns for the cryptographically-signed PDF artifact (Phase 2B).
-- Operational (post-issuance) metadata — NOT legal snapshot fields. Distinct from
-- pdfStorageKey/pdfHash (the unsigned generated PDF). Nullable so legacy/unsigned
-- documents stay valid; NO default, NO backfill, NO ALTER/DROP of existing columns.

-- AlterTable
ALTER TABLE "BillingDocument" ADD COLUMN "signedPdfStorageKey" TEXT;
ALTER TABLE "BillingDocument" ADD COLUMN "signedPdfHash" TEXT;
ALTER TABLE "BillingDocument" ADD COLUMN "signedAt" TIMESTAMP(3);
