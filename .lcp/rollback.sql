-- Rollback of 20261108090000_lead_claimed_phone — ONLY for a database where nothing used it yet.
-- Refused (raises, changes nothing) while ANY lead carries a claimed phone: those are enquiries people sent and the
-- owner must still be able to reach them; dropping the column would erase them silently. In that case roll back the
-- APPLICATION code only (the column is inert without it) and keep the data.
-- Otherwise removes exactly what the migration added, in one transaction, and its ledger row.
BEGIN;
DO $rb$
BEGIN
  IF EXISTS (SELECT 1 FROM "Lead" WHERE "claimedPhone" IS NOT NULL) THEN
    RAISE EXCEPTION 'lead claimedPhone rollback refused: claimed phones are stored';
  END IF;
END
$rb$;
DROP INDEX IF EXISTS "Lead_businessId_claimedPhone_idx";
ALTER TABLE "Lead" DROP CONSTRAINT IF EXISTS "Lead_claimedPhone_digits";
ALTER TABLE "Lead" DROP COLUMN IF EXISTS "claimedPhone";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261108090000_lead_claimed_phone';
COMMIT;
