-- Reversal of 20261013090000_p3e_landing_persistence. OWNER-RUN ONLY, never automatic.
--
-- Safe only while no code reads or writes the two tables (the P3-E application PR not deployed, or reverted
-- first). It REFUSES while any landing page exists: a saved or approved owner version is the owner's work,
-- and discarding it is a separate, explicit owner decision — never a side effect of a rollback.
-- It removes its own ledger row in the same transaction, so a later release re-applies it whole.

BEGIN;
DO $rb$
BEGIN
  IF EXISTS (SELECT 1 FROM "LandingPage") OR EXISTS (SELECT 1 FROM "LandingPageVersion") THEN
    RAISE EXCEPTION 'P3-E rollback refused: landing pages or versions exist';
  END IF;
END
$rb$;
DROP TABLE "LandingPageVersion", "LandingPage";
DROP FUNCTION public.p3e_landing_version_guard();
DROP FUNCTION public.p3e_landing_page_guard();
DROP FUNCTION public.p3e_landing_pointer_integrity();
DROP TYPE "LandingVersionStatus", "LandingVersionAuthority";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261013090000_p3e_landing_persistence';
COMMIT;
