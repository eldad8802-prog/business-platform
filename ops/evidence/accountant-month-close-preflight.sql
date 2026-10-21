-- ============================================================================
-- accountant-month-close-preflight.sql
--
-- Read-only Production PREFLIGHT before migration
--   20261023090000_accountant_month_close
--
-- Proves the database is where the migration expects it, from the catalog and counts only:
--   * the ledger is clean, the Daily Tasks foundation (what this builds on) is finished, and no finished migration
--     sorts after this one (it would then be applied out of order);
--   * none of the migration's objects exist yet (tables, functions, policies, the flag);
--   * what it builds on exists: app_runtime, Business, User, PlatformFeatureDefinition / Policy,
--     BusinessFeatureAccess; Business is under FORCE RLS (B4), so the business list the sweep reads is the
--     sanctioned ids-only read;
--   * the evidence role sees every row (it can tell "empty" from "hidden").
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== accountant month close preflight: legend (n -> check) =='
\echo ' 1 the evidence role is a superuser or has BYPASSRLS (it sees every row)'
\echo ' 2 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 3 the Daily Tasks foundation is finished and no finished migration sorts after this one (observed = later finished migrations)'
\echo ' 4 20261023090000_accountant_month_close is not recorded yet (observed = rows)'
\echo ' 5 none of the five accountant tables exists (observed = tables)'
\echo ' 6 no accountant function exists (observed = functions)'
\echo ' 7 no accountant policy exists (observed = policies)'
\echo ' 8 the flag accountant_month_close is not defined and has no override (observed = rows)'
\echo ' 9 the role app_runtime exists'
\echo '10 Business, User, PlatformFeatureDefinition, PlatformFeaturePolicy, BusinessFeatureAccess exist (observed = of 5)'
\echo '11 Business has RLS ENABLED + FORCED (B4)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
rel AS (SELECT c.relname AS nm, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
        WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relkind = 'r'),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) IS TRUE, 1
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL
                         AND migration_name > '20261023090000_accountant_month_close') = 0
                      AND EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261018090000_daily_tasks_foundation' AND finished_at IS NOT NULL),
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL
                         AND migration_name > '20261023090000_accountant_month_close')
  UNION ALL SELECT 4, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261023090000_accountant_month_close') = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261023090000_accountant_month_close')
  UNION ALL SELECT 5, (SELECT count(*) FROM rel WHERE nm LIKE 'Accountant%') = 0, (SELECT count(*) FROM rel WHERE nm LIKE 'Accountant%')
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_proc WHERE pronamespace = (SELECT oid FROM pub) AND proname LIKE 'accountant\_%') = 0,
                      (SELECT count(*) FROM pg_proc WHERE pronamespace = (SELECT oid FROM pub) AND proname LIKE 'accountant\_%')
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_policy WHERE polname LIKE 'accountant\_%') = 0,
                      (SELECT count(*) FROM pg_policy WHERE polname LIKE 'accountant\_%')
  UNION ALL SELECT 8, (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE "key" = 'accountant_month_close')
                      + (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'accountant_month_close')
                      + (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'accountant_month_close') = 0,
                      (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE "key" = 'accountant_month_close')
                      + (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'accountant_month_close')
                      + (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'accountant_month_close')
  UNION ALL SELECT 9, EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime'), 1
  UNION ALL SELECT 10, (SELECT count(*) FROM rel WHERE nm IN ('Business', 'User', 'PlatformFeatureDefinition', 'PlatformFeaturePolicy', 'BusinessFeatureAccess')) = 5,
                       (SELECT count(*) FROM rel WHERE nm IN ('Business', 'User', 'PlatformFeatureDefinition', 'PlatformFeaturePolicy', 'BusinessFeatureAccess'))
  UNION ALL SELECT 11, EXISTS (SELECT 1 FROM rel WHERE nm = 'Business' AND relrowsecurity AND relforcerowsecurity), 1
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
