-- Wave 1B · Account-deletion lifecycle on Business. Additive, expand-only.
-- Two nullable timestamps: deletionRequestedAt (sole user initiated deletion),
-- deletedAt (erasure completed → tenant closed, login fails closed). Nullable so
-- existing rows stay valid; NO default, NO backfill, NO ALTER/DROP of existing columns.

-- AlterTable
ALTER TABLE "Business" ADD COLUMN "deletionRequestedAt" TIMESTAMP(3);
ALTER TABLE "Business" ADD COLUMN "deletedAt" TIMESTAMP(3);
