-- ============================================================================
-- notification-engine-activation-preflight.sql
--
-- Read-only Production PREFLIGHT before migration
--   20261212090000_notification_engine_activation
--
-- Proves, from the catalog and counts only, that the migration will apply exactly as it did in the lab:
--   * it is not recorded yet and the ledger is clean;
--   * what it builds on is there: the follow-up 20261211090000_notification_engine_followup recorded and finished
--     (it seeds the policy row of notifications_engine the triggers read), that policy row, and the role
--     app_runtime; the evidence role owns Business, BusinessFeatureAccess and PlatformFeaturePolicy (the foreign key
--     and the two triggers need it);
--   * every name it introduces is free: the table, its constraints, its policy, the five functions, the two
--     triggers;
--   * INFO: how many notifications_engine overrides are ENABLED (the rows the backfill will write) — a count, never
--     a failure.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== notification engine activation preflight: legend (n -> check) =='
\echo ' 1 the migration is not recorded (observed = ledger rows with its name)'
\echo ' 2 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 3 the follow-up migration 20261211090000 is recorded and finished (observed = such rows)'
\echo ' 4 the policy row of notifications_engine exists and the role app_runtime exists (observed = of 2)'
\echo ' 5 none of the new names is taken: table, constraints, policy, five functions, two triggers (observed = taken)'
\echo ' 6 the evidence role owns Business, BusinessFeatureAccess, PlatformFeaturePolicy (observed = of 3)'
\echo ' 7 INFO: notifications_engine overrides in state ENABLED (rows the backfill writes)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
rel(nm, oid, relowner) AS (SELECT c.relname, c.oid, c.relowner FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub)),
me AS (SELECT oid FROM pg_roles WHERE rolname = current_user),
new_rel(nm) AS (VALUES ('NotificationEngineActivation'), ('NotificationEngineActivation_pkey')),
new_con(nm) AS (VALUES ('NotificationEngineActivation_pkey'), ('NotificationEngineActivation_order'),
  ('NotificationEngineActivation_source'), ('NotificationEngineActivation_businessId_fkey')),
new_fn(nm) AS (VALUES ('notification_engine_effective'), ('notification_engine_record'), ('notification_engine_override_changed'),
  ('notification_engine_policy_changed'), ('notification_engine_observe')),
new_tg(nm) AS (VALUES ('BusinessFeatureAccess_notification_engine_activation'), ('PlatformFeaturePolicy_notification_engine_activation')),
taken(nm) AS (
            SELECT nm FROM new_rel WHERE EXISTS (SELECT 1 FROM rel WHERE rel.nm = new_rel.nm)
  UNION ALL SELECT nm FROM new_con WHERE EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conname = new_con.nm AND k.connamespace = (SELECT oid FROM pub))
  UNION ALL SELECT nm FROM new_fn WHERE EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname = new_fn.nm AND p.pronamespace = (SELECT oid FROM pub))
  UNION ALL SELECT nm FROM new_tg WHERE EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname = new_tg.nm)
  UNION ALL SELECT 'policy' WHERE EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'notification_engine_activation_tenant_select')
),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261212090000_notification_engine_activation') = 0,
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261212090000_notification_engine_activation')
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261211090000_notification_engine_followup'
                         AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261211090000_notification_engine_followup'
                         AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 4, (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'notifications_engine')
                      + (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime') = 2,
                      (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'notifications_engine')
                      + (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime')
  UNION ALL SELECT 5, NOT EXISTS (SELECT 1 FROM taken), (SELECT count(*) FROM taken)
  UNION ALL SELECT 6, (SELECT count(*) FROM rel WHERE nm IN ('Business', 'BusinessFeatureAccess', 'PlatformFeaturePolicy')
                         AND relowner = (SELECT oid FROM me)) = 3,
                      (SELECT count(*) FROM rel WHERE nm IN ('Business', 'BusinessFeatureAccess', 'PlatformFeaturePolicy')
                         AND relowner = (SELECT oid FROM me))
  UNION ALL SELECT 7, true, (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'notifications_engine' AND "state" = 'ENABLED')
)
SELECT n, CASE WHEN n = 7 THEN 'INFO' WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
