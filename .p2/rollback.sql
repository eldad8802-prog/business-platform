-- P2 (#601) rollback — 20261004090000_p2_business_identity.
--
-- OWNER-RUN ONLY, never by the app, never by a workflow without a separate owner decision.
-- Proven in the lab (.github/workflows/p2-forensic-lab.yml step 6): after it, the preflight is
-- 19/19 again (the database is back to "P2 pending") and the ledger no longer records P2.
--
-- SAFE ONLY WHILE THE TABLES ARE EMPTY. P2's application (PR-2) is not built; until it ships nothing
-- writes these tables. The guard below refuses if either table holds a row — owner statements are
-- not erased by a rollback.
BEGIN;
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM "BusinessIdentityStatement") OR EXISTS (SELECT 1 FROM "BusinessIdentityFactAuthority") THEN
    RAISE EXCEPTION 'P2 rollback refused: owner identity rows exist — inspect before rolling back';
  END IF;
END
$guard$;
DROP TABLE "BusinessIdentityFactAuthority";
DROP TABLE "BusinessIdentityStatement";
DROP TYPE "BusinessIdentityFact";
DROP TYPE "BusinessIdentityDimension";
DROP TYPE "BusinessIdentitySource";
DROP TYPE "BusinessIdentityStatus";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261004090000_p2_business_identity';
COMMIT;
