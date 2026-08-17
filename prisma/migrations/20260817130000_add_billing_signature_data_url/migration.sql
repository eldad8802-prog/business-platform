-- Phase 1 · Business graphical signature. Additive, expand-only, nullable.
-- Adds ONE nullable column for the business's VISUAL signature/stamp (data URL),
-- mirroring billingLogoDataUrl. Presentation only — NOT a cryptographic signature.
-- No ALTER of existing columns, no data migration, no backfill, no default.

-- AlterTable
ALTER TABLE "BusinessProfile" ADD COLUMN "billingSignatureDataUrl" TEXT;
