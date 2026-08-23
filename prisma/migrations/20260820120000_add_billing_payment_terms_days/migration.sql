-- Collection MVP · Business-wide payment terms. Additive, expand-only.
-- One nullable column: when payment on an issued invoice is expected, in days
-- from issuedAt. NULL = never configured; the collection read-model falls back
-- to its own default, so no backfill is required and existing rows stay valid.
-- Collection-only: NOT a legal snapshot field. NO default, NO backfill,
-- NO ALTER/DROP of existing columns.

-- AlterTable
ALTER TABLE "BusinessProfile" ADD COLUMN "billingPaymentTermsDays" INTEGER;
