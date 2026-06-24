-- Accountant Package — Phase C (Document Number Persistence).
-- Persist the incoming document's own number (invoice / receipt / reference),
-- label-detected from OCR text. Additive and nullable on both the
-- extraction-belief table (ExtractedData) and the approved record
-- (FinancialRecord). No backfill, no engine change; existing rows keep NULL.

-- AlterTable
ALTER TABLE "ExtractedData" ADD COLUMN "documentNumber" TEXT;

-- AlterTable
ALTER TABLE "FinancialRecord" ADD COLUMN "documentNumber" TEXT;
