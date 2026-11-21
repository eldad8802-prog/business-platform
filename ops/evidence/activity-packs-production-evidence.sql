-- ============================================================================
-- activity-packs-production-evidence.sql — read-only EVIDENCE after migration
--   20261216090000_activity_packs
-- Proves the release did exactly what the migration says and nothing else. Catalog, ledger and counts only.
-- OUTPUT: n | result | observed_count.
-- ============================================================================
\echo '== activity packs evidence: legend (n -> check) =='
\echo ' 1 20261216090000_activity_packs recorded once, finished, not rolled back'
\echo ' 2 ledger: no unfinished and no rolled-back row'
\echo ' 3 BusinessActivityProfile exists'
\echo ' 4 RLS enabled and forced on it'
\echo ' 5 exactly its three tenant policies (read, add, change)'
\echo ' 6 app_runtime holds exactly arw on it (read, add, change) and nothing more'
\echo ' 7 app_runtime appears exactly once in its access list'
\echo ' 8 no role other than the owner and app_runtime holds anything on it'
\echo ' 9 the guard trigger BusinessActivityProfile_guard exists and is enabled'
\echo '10 feature definition activity_packs exists, OFF by default'
\echo '11 feature policy activity_packs is globally OFF, not emergency-disabled'
\echo '12 no per-business override for activity_packs (nobody switched it on)'
\echo '13 choices recorded: catalog row estimate, no table read (informational)'
WITH t AS (SELECT to_regclass('public."BusinessActivityProfile"') AS oid),
acl AS (
  SELECT a::text AS entry, pg_get_userbyid(c.relowner) AS owner
    FROM pg_class c CROSS JOIN LATERAL unnest(c.relacl) a
   WHERE c.oid = (SELECT oid FROM t)
),
c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261216090000_activity_packs' AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS observed, 1 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM t WHERE oid IS NOT NULL), 1
  UNION ALL SELECT 4, (SELECT count(*) FROM pg_class WHERE oid = (SELECT oid FROM t) AND relrowsecurity AND relforcerowsecurity), 1
  UNION ALL SELECT 5, (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'BusinessActivityProfile'
                         AND policyname LIKE 'business\_activity\_profile\_tenant\_%'), 3
  UNION ALL SELECT 6, (SELECT count(*) FROM acl WHERE split_part(entry, '/', 1) = 'app_runtime=arw'), 1
  UNION ALL SELECT 7, (SELECT count(*) FROM acl WHERE entry LIKE 'app\_runtime=%'), 1
  UNION ALL SELECT 8, (SELECT count(*) FROM acl WHERE entry NOT LIKE 'app\_runtime=%' AND split_part(entry, '=', 1) <> owner), 0
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_trigger WHERE tgrelid = (SELECT oid FROM t) AND tgname = 'BusinessActivityProfile_guard' AND NOT tgisinternal AND tgenabled = 'O'), 1
  UNION ALL SELECT 10, (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE "key" = 'activity_packs' AND "defaultEnabled" = false), 1
  UNION ALL SELECT 11, (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'activity_packs' AND "globalEnabled" = false AND "emergencyDisabled" = false), 1
  UNION ALL SELECT 12, (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'activity_packs'), 0
  UNION ALL SELECT 13, (SELECT COALESCE(sum(n_live_tup), 0) FROM pg_stat_user_tables WHERE schemaname = 'public' AND relname = 'BusinessActivityProfile'), NULL
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
