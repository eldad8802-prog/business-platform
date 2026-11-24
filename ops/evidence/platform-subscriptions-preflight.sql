-- ============================================================================
-- platform-subscriptions-preflight.sql — read-only PREFLIGHT before migration
--   20261224090000_platform_subscriptions   (NOT applied)
-- Proves Production is the shape the migration expects. Catalog, ledger and counts only — no write, no row content.
-- OUTPUT: n | result | observed_count (the release-migrate gate reads the PASS / FAIL cells).
-- ============================================================================
\echo '== platform subscriptions preflight: legend (n -> check) =='
\echo ' 1 ledger: no unfinished and no rolled-back row'
\echo ' 2 20261224090000_platform_subscriptions is NOT recorded'
\echo ' 3 prerequisite 20261221200000_activity_packs_open_all is recorded and finished'
\echo ' 4 Business exists'
\echo ' 5 roles app_runtime and app_ctlplane both exist'
\echo ' 6 PlatformSubscription is not there yet'
\echo ' 7 PlatformSubscriptionEvent is not there yet'
\echo ' 8 the function platform_subscription_event_append_only is not there yet'
\echo ' 9 businesses in total = the rows the backfill will write (informational)'
\echo '10 live businesses: not deleted, not the platform system business (informational)'
\echo '11 platform system businesses = INTERNAL rows the backfill will write (informational)'
\echo '12 later migrations on main already recorded: 20261222090000, 20261223090000, 20261223100000 (informational)'
WITH c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) AS observed, 0 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261224090000_platform_subscriptions'), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261221200000_activity_packs_open_all' AND finished_at IS NOT NULL AND rolled_back_at IS NULL), 1
  UNION ALL SELECT 4, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = 'Business' AND relkind = 'r'), 1
  UNION ALL SELECT 5, (SELECT count(*) FROM pg_roles WHERE rolname IN ('app_runtime', 'app_ctlplane')), 2
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = 'PlatformSubscription'), 0
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = 'PlatformSubscriptionEvent'), 0
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'platform_subscription_event_append_only'), 0
  UNION ALL SELECT 9, (SELECT count(*) FROM "Business"), NULL
  UNION ALL SELECT 10, (SELECT count(*) FROM "Business" WHERE "deletedAt" IS NULL AND "name" <> '__PLATFORM_SYSTEM__'), NULL
  UNION ALL SELECT 11, (SELECT count(*) FROM "Business" WHERE "name" = '__PLATFORM_SYSTEM__'), NULL
  UNION ALL SELECT 12, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name IN ('20261222090000_service_desk_case_records', '20261223090000_issuer_reauth_google', '20261223100000_issuer_declaration_status_change')), NULL
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
