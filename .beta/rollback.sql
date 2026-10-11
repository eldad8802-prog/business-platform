-- Reversal of 20261017090000_beta_cohort_enrollment. OWNER-RUN ONLY, never automatic.
--
-- Safe only while no code reads or writes the table (the application PR not deployed, or reverted first).
-- It REFUSES while any row exists: a row is a business opened through the closed beta, and forgetting
-- that is a separate, explicit owner decision — never a side effect of a rollback. (Ending the beta does
-- NOT need this: BETA_COHORT_RESTRICTIONS off lifts every restriction without touching the table.)
-- It removes its own ledger row in the same transaction, so a later release re-applies it whole.

BEGIN;
DO $rb$
BEGIN
  IF EXISTS (SELECT 1 FROM "BusinessBetaEnrollment") THEN
    RAISE EXCEPTION 'beta cohort enrollment rollback refused: rows exist';
  END IF;
END
$rb$;
DROP TABLE "BusinessBetaEnrollment";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261017090000_beta_cohort_enrollment';
COMMIT;
