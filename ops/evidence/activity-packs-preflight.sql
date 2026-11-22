-- ============================================================================
-- activity-packs-preflight.sql — read-only PREFLIGHT before migration
--   20261216090000_activity_packs   (NOT applied)
-- Proves Production is the shape the migration expects. Catalog, ledger and counts only — no write, no data read
-- beyond counts. OUTPUT: n | result | observed_count (the release-migrate gate reads the PASS / FAIL cells).
-- ============================================================================
\echo '== activity packs preflight: legend (n -> check) =='
\echo ' 1 ledger: no unfinished and no rolled-back row'
\echo ' 2 20261216090000_activity_packs is NOT recorded'
\echo ' 3 prerequisite 20261221090000_business_kind_transition (the last migration on main, applied 2026-11-22) is recorded and finished'
\echo ' 4 Business exists'
\echo ' 5 PlatformFeatureDefinition and PlatformFeaturePolicy exist'
\echo ' 6 role app_runtime exists'
\echo ' 7 BusinessActivityProfile does not exist yet'
\echo ' 8 the guard function business_activity_profile_guard does not exist yet'
\echo ' 9 no feature definition activity_packs yet'
\echo '10 no feature policy activity_packs yet'
\echo '11 no per-business override for activity_packs'
\echo '12 businesses (informational)'
WITH c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) AS observed, 0 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261216090000_activity_packs'), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261221090000_business_kind_transition' AND finished_at IS NOT NULL AND rolled_back_at IS NULL), 1
  UNION ALL SELECT 4, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = 'Business' AND relkind = 'r'), 1
  UNION ALL SELECT 5, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('PlatformFeatureDefinition', 'PlatformFeaturePolicy') AND relkind = 'r'), 2
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime'), 1
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = 'BusinessActivityProfile'), 0
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'business_activity_profile_guard'), 0
  UNION ALL SELECT 9, (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE "key" = 'activity_packs'), 0
  UNION ALL SELECT 10, (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'activity_packs'), 0
  UNION ALL SELECT 11, (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'activity_packs'), 0
  UNION ALL SELECT 12, (SELECT COALESCE(sum(n_live_tup), 0) FROM pg_stat_user_tables WHERE schemaname = 'public' AND relname = 'Business'), NULL
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
