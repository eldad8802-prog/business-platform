-- Rollback of 20261130100000_service_qa_track_defaults — only for a failed or abandoned rollout, run by the migration owner
-- in ONE transaction, BEFORE any product code writes the new table (the code PR merges only after the migration). It
-- REFUSES when the table already holds a row (a business's chosen default would be lost: the owner decides instead).
-- row_security = off: the table FORCEs row-level security, so the check must see every business's rows or fail, never
-- pass blind. No existing object was changed, so nothing is restored. The ledger row is removed in the same transaction,
-- so a later `prisma migrate deploy` applies the migration again (`migrate resolve` only handles a FAILED migration).
-- Cases are not touched: a case opened with a default names a list VERSION through #1124's own columns and journal.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL row_security = off;
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM "ServiceQaTrackDefault") THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: a QA track default exists; nothing was changed';
  END IF;
END
$do$;
DROP TABLE "ServiceQaTrackDefault";
DROP FUNCTION public.service_qa_track_defaults_erase_business();
DROP FUNCTION public.service_qa_track_default_guard();
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261130100000_service_qa_track_defaults';
COMMIT;
