-- ============================================================================
-- accountant-ops-preflight.sql
--
-- Read-only Production PREFLIGHT before migrations
--   20261107090000_accountant_ops_monitor
--   20261107091000_accountant_delivery_complained
--   20261107092000_accountant_ops_admin_read
--
-- Proves the database is where the three migrations expect it, from the catalog, the ledger and counts only:
--   * the ledger is clean; the accountant workflow and its link events (what these extend) are finished;
--   * none of the three is recorded, and no finished migration sorts after the first of them;
--   * none of the three monitoring tables exists yet;
--   * the event-type constraint is the 2026-11-05 one: present, validated, 26 values, DELIVERY_COMPLAINED not yet;
--   * the trail is still under FORCE RLS with both append-only triggers;
--   * the two roles the migrations give privileges to exist with the expected attributes: app_runtime and app_admin —
--     NOLOGIN groups, neither superuser nor BYPASSRLS.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== accountant ops preflight: legend (n -> check) =='
\echo ' 1 the evidence role is a superuser or has BYPASSRLS (it sees every row)'
\echo ' 2 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 3 20261027090000_accountant_month_close and 20261105090000_accountant_link_events are finished (observed = of 2)'
\echo ' 4 none of the three 20261107 migrations is recorded yet (observed = rows)'
\echo ' 5 no finished migration sorts after 20261107090000_accountant_ops_monitor (observed = later finished migrations)'
\echo ' 6 none of AccountantOpsRun / AccountantOpsAlert / AccountantBusinessAlert exists yet (observed = of 3)'
\echo ' 7 AccountantWorkflowEvent_type exists, is validated and lists exactly 26 values (observed = values)'
\echo ' 8 it does not list DELIVERY_COMPLAINED yet; it lists LINK_FILE_DOWNLOADED (observed = DELIVERY_COMPLAINED listed)'
\echo ' 9 AccountantWorkflowEvent has RLS ENABLED + FORCED and both append-only triggers enabled (observed = triggers of 2)'
\echo '10 app_runtime exists: NOLOGIN, not superuser, not BYPASSRLS (observed = such roles)'
\echo '11 app_admin exists: NOLOGIN, not superuser, not BYPASSRLS (observed = such roles)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

WITH
mig(name) AS (VALUES ('20261107090000_accountant_ops_monitor'), ('20261107091000_accountant_delivery_complained'),
                     ('20261107092000_accountant_ops_admin_read')),
con AS (SELECT c.convalidated, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
        WHERE c.conname = 'AccountantWorkflowEvent_type' AND c.conrelid = '"AccountantWorkflowEvent"'::regclass),
vals AS (SELECT (array_length(regexp_split_to_array(def, '::text'), 1) - 1) AS n, convalidated,
                def LIKE '%''DELIVERY_COMPLAINED''%' AS complained, def LIKE '%''LINK_FILE_DOWNLOADED''%' AS link_events
         FROM con),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) IS TRUE, 1
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, (SELECT count(DISTINCT migration_name) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
                         AND migration_name IN ('20261027090000_accountant_month_close', '20261105090000_accountant_link_events')) = 2,
                      (SELECT count(DISTINCT migration_name) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
                         AND migration_name IN ('20261027090000_accountant_month_close', '20261105090000_accountant_link_events'))
  UNION ALL SELECT 4, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name IN (SELECT name FROM mig)) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name IN (SELECT name FROM mig))
  UNION ALL SELECT 5, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND migration_name > '20261107090000_accountant_ops_monitor') = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND migration_name > '20261107090000_accountant_ops_monitor')
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace
                         AND relname IN ('AccountantOpsRun', 'AccountantOpsAlert', 'AccountantBusinessAlert')) = 0,
                      (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace
                         AND relname IN ('AccountantOpsRun', 'AccountantOpsAlert', 'AccountantBusinessAlert'))
  UNION ALL SELECT 7, coalesce((SELECT convalidated AND n = 26 FROM vals), false), coalesce((SELECT n FROM vals), 0)
  UNION ALL SELECT 8, coalesce((SELECT NOT complained AND link_events FROM vals), false),
                      coalesce((SELECT CASE WHEN complained THEN 1 ELSE 0 END FROM vals), 0)
  UNION ALL SELECT 9, EXISTS (SELECT 1 FROM pg_class WHERE oid = '"AccountantWorkflowEvent"'::regclass AND relrowsecurity AND relforcerowsecurity)
                      AND (SELECT count(*) FROM pg_trigger WHERE tgrelid = '"AccountantWorkflowEvent"'::regclass AND NOT tgisinternal AND tgenabled = 'O'
                             AND tgname IN ('AccountantWorkflowEvent_append_only', 'AccountantWorkflowEvent_no_truncate')) = 2,
                      (SELECT count(*) FROM pg_trigger WHERE tgrelid = '"AccountantWorkflowEvent"'::regclass AND NOT tgisinternal AND tgenabled = 'O'
                         AND tgname IN ('AccountantWorkflowEvent_append_only', 'AccountantWorkflowEvent_no_truncate'))
  UNION ALL SELECT 10, (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls) = 1,
                       (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls)
  UNION ALL SELECT 11, (SELECT count(*) FROM pg_roles WHERE rolname = 'app_admin' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls) = 1,
                       (SELECT count(*) FROM pg_roles WHERE rolname = 'app_admin' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
