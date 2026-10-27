-- ============================================================================
-- accountant-link-events-preflight.sql
--
-- Read-only Production PREFLIGHT before migration
--   20261105090000_accountant_link_events
--
-- Proves the database is where the migration expects it, from the catalog, the ledger and counts only:
--   * the ledger is clean and the accountant workflow (what this extends) is finished;
--   * this migration is not recorded, and no finished migration sorts after it;
--   * the event-type constraint is the 2026-10-27 one: present, validated, 24 values, neither new value yet;
--   * no trail row uses a new value (none can: the constraint refuses them);
--   * the trail table is still under FORCE RLS with its two append-only triggers.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== accountant link events preflight: legend (n -> check) =='
\echo ' 1 the evidence role is a superuser or has BYPASSRLS (it sees every row)'
\echo ' 2 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 3 20261027090000_accountant_month_close is finished (observed = finished rows)'
\echo ' 4 20261105090000_accountant_link_events is not recorded yet (observed = rows)'
\echo ' 5 no finished migration sorts after this one (observed = later finished migrations)'
\echo ' 6 AccountantWorkflowEvent_type exists and is validated (observed = such constraints)'
\echo ' 7 it lists exactly 24 values (observed = values)'
\echo ' 8 it lists neither LINK_VIEWED nor LINK_FILE_DOWNLOADED (observed = of 2)'
\echo ' 9 no trail row uses a new value (observed = rows)'
\echo '10 AccountantWorkflowEvent has RLS ENABLED + FORCED'
\echo '11 both of its append-only triggers (row and table level) are enabled (observed = of 2)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

WITH
con AS (SELECT c.convalidated, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
        WHERE c.conname = 'AccountantWorkflowEvent_type' AND c.conrelid = '"AccountantWorkflowEvent"'::regclass),
vals AS (SELECT (array_length(regexp_split_to_array(def, '::text'), 1) - 1) AS n,
                (CASE WHEN def LIKE '%''LINK_VIEWED''%' THEN 1 ELSE 0 END) + (CASE WHEN def LIKE '%''LINK_FILE_DOWNLOADED''%' THEN 1 ELSE 0 END) AS new_vals
         FROM con),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) IS TRUE, 1
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261027090000_accountant_month_close' AND finished_at IS NOT NULL) = 1,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261027090000_accountant_month_close' AND finished_at IS NOT NULL)
  UNION ALL SELECT 4, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261105090000_accountant_link_events') = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261105090000_accountant_link_events')
  UNION ALL SELECT 5, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND migration_name > '20261105090000_accountant_link_events') = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND migration_name > '20261105090000_accountant_link_events')
  UNION ALL SELECT 6, (SELECT count(*) FROM con WHERE convalidated) = 1, (SELECT count(*) FROM con WHERE convalidated)
  UNION ALL SELECT 7, (SELECT n FROM vals) = 24, coalesce((SELECT n FROM vals), 0)
  UNION ALL SELECT 8, (SELECT new_vals FROM vals) = 0, coalesce((SELECT new_vals FROM vals), 0)
  UNION ALL SELECT 9, (SELECT count(*) FROM "AccountantWorkflowEvent" WHERE "eventType" IN ('LINK_VIEWED', 'LINK_FILE_DOWNLOADED')) = 0,
                      (SELECT count(*) FROM "AccountantWorkflowEvent" WHERE "eventType" IN ('LINK_VIEWED', 'LINK_FILE_DOWNLOADED'))
  UNION ALL SELECT 10, EXISTS (SELECT 1 FROM pg_class WHERE oid = '"AccountantWorkflowEvent"'::regclass AND relrowsecurity AND relforcerowsecurity), 1
  UNION ALL SELECT 11, (SELECT count(*) FROM pg_trigger WHERE tgrelid = '"AccountantWorkflowEvent"'::regclass AND NOT tgisinternal AND tgenabled = 'O'
                         AND tgname IN ('AccountantWorkflowEvent_append_only', 'AccountantWorkflowEvent_no_truncate')) = 2,
                       (SELECT count(*) FROM pg_trigger WHERE tgrelid = '"AccountantWorkflowEvent"'::regclass AND NOT tgisinternal AND tgenabled = 'O'
                         AND tgname IN ('AccountantWorkflowEvent_append_only', 'AccountantWorkflowEvent_no_truncate'))
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
