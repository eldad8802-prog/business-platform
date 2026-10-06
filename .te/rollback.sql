-- Reversal of 20261015090000_transactional_email_foundation. OWNER-RUN ONLY, never automatic.
--
-- Safe only while no code reads or writes the table (the application PR not deployed, or reverted first).
-- It REFUSES while any row exists: a row is an email Dubiz owes (or sent) a recipient, and discarding
-- that record is a separate, explicit owner decision — never a side effect of a rollback.
-- It removes its own ledger row in the same transaction, so a later release re-applies it whole.

BEGIN;
DO $rb$
BEGIN
  IF EXISTS (SELECT 1 FROM "TransactionalEmail") THEN
    RAISE EXCEPTION 'transactional email rollback refused: rows exist';
  END IF;
END
$rb$;
DROP TABLE "TransactionalEmail";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261015090000_transactional_email_foundation';
COMMIT;
