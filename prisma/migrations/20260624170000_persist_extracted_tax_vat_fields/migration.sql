-- Accountant Package — Phase B (OCR Persistence).
-- Persist fields the extraction engine already detects but previously dropped:
-- vendor tax id (ח.פ/ע.מ), VAT amount, and subtotal (pre-VAT) amount. Additive
-- and nullable on both the extraction-belief table (ExtractedData) and the
-- approved record (FinancialRecord). No backfill, no engine/logic change,
-- existing rows keep NULLs.

-- AlterTable
ALTER TABLE "ExtractedData" ADD COLUMN "vendorTaxId" TEXT;
ALTER TABLE "ExtractedData" ADD COLUMN "vatAmount" DOUBLE PRECISION;
ALTER TABLE "ExtractedData" ADD COLUMN "subtotalAmount" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "FinancialRecord" ADD COLUMN "vendorTaxId" TEXT;
ALTER TABLE "FinancialRecord" ADD COLUMN "vatAmount" DOUBLE PRECISION;
ALTER TABLE "FinancialRecord" ADD COLUMN "subtotalAmount" DOUBLE PRECISION;
