-- ============================================================================
-- accountant-link-events-production-evidence.sql
--
-- Read-only Production PROOF after migration
--   20261105090000_accountant_link_events
--   (migration.sql sha256 '9546eaffe8f443040ac4af947900f6751de19631f3a77f77630dfad2037de619')
--
-- Proves, from the catalog, the ledger and counts only, that exactly what the migration says happened:
--   * it is recorded once, finished, with the checksum of the reviewed file, and the ledger is clean;
--   * the event-type constraint keeps its name, is validated, and lists 26 values: the 24 of 2026-10-27
--     (LINK_DOWNLOADED and PERIOD_COMPLETED_MANUALLY sampled) plus LINK_VIEWED and LINK_FILE_DOWNLOADED;
--   * the closed-payload constraint is still there; the trail is still under FORCE RLS with both append-only
--     triggers enabled;
--   * nothing used the new values yet (the portal code ships after this proof).
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== accountant link events proof: legend (n -> check) =='
\echo ' 1 the evidence role is a superuser or has BYPASSRLS (it sees every row)'
\echo ' 2 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 3 20261105090000_accountant_link_events is recorded once, finished, with the pinned checksum (observed = rows)'
\echo ' 4 AccountantWorkflowEvent_type exists and is validated (observed = such constraints)'
\echo ' 5 it lists exactly 26 values (observed = values)'
\echo ' 6 it lists LINK_VIEWED and LINK_FILE_DOWNLOADED (observed = of 2)'
\echo ' 7 it still lists LINK_DOWNLOADED and PERIOD_COMPLETED_MANUALLY (observed = of 2)'
\echo ' 8 AccountantWorkflowEvent_payload_closed still exists and is validated (observed = such constraints)'
\echo ' 9 AccountantWorkflowEvent has RLS ENABLED + FORCED'
\echo '10 both of its append-only triggers (row and table level) are enabled (observed = of 2)'
\echo '11 no trail row uses a new value yet (observed = rows)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

WITH
con AS (SELECT c.convalidated, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
        WHERE c.conname = 'AccountantWorkflowEvent_type' AND c.conrelid = '"AccountantWorkflowEvent"'::regclass),
has(v) AS (VALUES ('LINK_VIEWED'), ('LINK_FILE_DOWNLOADED'), ('LINK_DOWNLOADED'), ('PERIOD_COMPLETED_MANUALLY')),
listed AS (SELECT h.v FROM has h, con WHERE con.def LIKE '%''' || h.v || '''::text%'),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) IS TRUE, 1
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261105090000_accountant_link_events'
                         AND finished_at IS NOT NULL AND rolled_back_at IS NULL
                         AND checksum = '9546eaffe8f443040ac4af947900f6751de19631f3a77f77630dfad2037de619') = 1
                      AND (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261105090000_accountant_link_events') = 1,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261105090000_accountant_link_events')
  UNION ALL SELECT 4, (SELECT count(*) FROM con WHERE convalidated) = 1, (SELECT count(*) FROM con WHERE convalidated)
  UNION ALL SELECT 5, (SELECT (array_length(regexp_split_to_array(def, '::text'), 1) - 1) FROM con) = 26,
                      coalesce((SELECT (array_length(regexp_split_to_array(def, '::text'), 1) - 1) FROM con), 0)
  UNION ALL SELECT 6, (SELECT count(*) FROM listed WHERE v IN ('LINK_VIEWED', 'LINK_FILE_DOWNLOADED')) = 2,
                      (SELECT count(*) FROM listed WHERE v IN ('LINK_VIEWED', 'LINK_FILE_DOWNLOADED'))
  UNION ALL SELECT 7, (SELECT count(*) FROM listed WHERE v IN ('LINK_DOWNLOADED', 'PERIOD_COMPLETED_MANUALLY')) = 2,
                      (SELECT count(*) FROM listed WHERE v IN ('LINK_DOWNLOADED', 'PERIOD_COMPLETED_MANUALLY'))
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_constraint WHERE conname = 'AccountantWorkflowEvent_payload_closed' AND convalidated) = 1,
                      (SELECT count(*) FROM pg_constraint WHERE conname = 'AccountantWorkflowEvent_payload_closed' AND convalidated)
  UNION ALL SELECT 9, EXISTS (SELECT 1 FROM pg_class WHERE oid = '"AccountantWorkflowEvent"'::regclass AND relrowsecurity AND relforcerowsecurity), 1
  UNION ALL SELECT 10, (SELECT count(*) FROM pg_trigger WHERE tgrelid = '"AccountantWorkflowEvent"'::regclass AND NOT tgisinternal AND tgenabled = 'O'
                         AND tgname IN ('AccountantWorkflowEvent_append_only', 'AccountantWorkflowEvent_no_truncate')) = 2,
                       (SELECT count(*) FROM pg_trigger WHERE tgrelid = '"AccountantWorkflowEvent"'::regclass AND NOT tgisinternal AND tgenabled = 'O'
                         AND tgname IN ('AccountantWorkflowEvent_append_only', 'AccountantWorkflowEvent_no_truncate'))
  UNION ALL SELECT 11, (SELECT count(*) FROM "AccountantWorkflowEvent" WHERE "eventType" IN ('LINK_VIEWED', 'LINK_FILE_DOWNLOADED')) = 0,
                       (SELECT count(*) FROM "AccountantWorkflowEvent" WHERE "eventType" IN ('LINK_VIEWED', 'LINK_FILE_DOWNLOADED'))
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
