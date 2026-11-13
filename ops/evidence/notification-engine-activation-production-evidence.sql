-- ============================================================================
-- notification-engine-activation-production-evidence.sql
--
-- Read-only Production EVIDENCE after migration
--   20261212090000_notification_engine_activation
-- (which depends on 20261211090000_notification_engine_followup, check 10, itself on the foundation 20261210090000).
--
-- Proves the migration's outcome, from the catalog and counts only:
--   * it is recorded and finished, its sha256 is the reviewed one, nothing is unfinished or rolled back;
--   * "NotificationEngineActivation": row level security enabled AND forced, exactly one policy — FOR SELECT, keyed on
--     app.current_business_id — so no role writes or removes a row through a policy; app_runtime holds SELECT
--     alone, PUBLIC nothing, no other role anything; primary key on businessId, a foreign key to Business that
--     cascades, the two CHECKs (moment order, source tokens);
--   * the five functions: the two trigger functions and notification_engine_observe SECURITY DEFINER, the two
--     helpers SECURITY INVOKER, every one with search_path pinned and owned by the migration role; EXECUTE on
--     notification_engine_observe for app_runtime alone, on the other four for nobody but the owner;
--   * the two triggers: AFTER, row level, enabled, on BusinessFeatureAccess (a new row, a change of the state column) and on
--     PlatformFeaturePolicy (a new row, any change), each calling its own function;
--   * the backfill: every business whose notifications_engine override is ENABLED has a record (the policy not in
--     emergency), and no record written by the migration predates the release.
--
-- Checks 21 and 22 run first: row counts are taken with row_security = off, so a query that row level security
-- would filter stops the run with an ERROR instead of reporting a smaller number.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== notification engine activation production evidence: legend (n -> check) =='
\echo '21 V1 the evidence role is a superuser or has BYPASSRLS, so it sees every row (runs first)'
\echo '22 V2 row level security is not active on "NotificationEngineActivation" for the evidence role (runs first)'
\echo ' 1 the migration is recorded and finished (observed = finished rows)'
\echo ' 2 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 3 the recorded checksum is the reviewed sha256 of migration.sql'
\echo ' 4 the table has RLS enabled and forced and exactly one policy: FOR SELECT on the tenant setting (observed = policies)'
\echo ' 5 table privileges: app_runtime SELECT only; PUBLIC and every other role nothing (observed = other privileges)'
\echo ' 6 primary key businessId, foreign key to Business that cascades, the order and source CHECKs (observed = of 4)'
\echo ' 7 the five functions: definer / invoker as designed, search_path pinned, owned by the migration role (observed = of 5)'
\echo ' 8 EXECUTE: observe for app_runtime alone, the other four for nobody but the owner, no PUBLIC (observed = other grants)'
\echo ' 9 the two triggers: AFTER, row level, enabled, on their tables, events and functions (observed = of 2)'
\echo '10 the follow-up 20261211090000 is recorded and finished, the dependency (observed = such rows)'
\echo '11 backfill: every ENABLED notifications_engine override has a record unless the kill switch is on (observed = without)'
\echo '12 backfill: no record written by the migration predates the release (observed = such rows)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

\echo '== visibility checks (21, 22) =='
WITH
tbl AS (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'NotificationEngineActivation' AND c.relkind = 'r'),
checks(n, ok, observed_count) AS (
            SELECT 21, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) IS TRUE, 1
  UNION ALL SELECT 22, row_security_active((SELECT oid FROM tbl)) IS FALSE, 1
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

\echo '== evidence checks (1-12) =='
WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
rel(nm, oid, relowner, relrowsecurity, relforcerowsecurity, relacl) AS (
  SELECT c.relname, c.oid, c.relowner, c.relrowsecurity, c.relforcerowsecurity, c.relacl FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub)),
t AS (SELECT * FROM rel WHERE nm = 'NotificationEngineActivation'),
me AS (SELECT oid FROM pg_roles WHERE rolname = current_user),
rt AS (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime'),
pol AS (SELECT p.polcmd, pg_get_expr(p.polqual, p.polrelid) AS q FROM pg_policy p WHERE p.polrelid = (SELECT oid FROM t)),
tacl AS (SELECT x.grantee, x.privilege_type FROM t CROSS JOIN LATERAL aclexplode(t.relacl) x WHERE x.grantee <> t.relowner),
con AS (SELECT k.conname, k.contype, k.confdeltype, k.confrelid FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM t)),
con_ok AS (
            SELECT 1 FROM con WHERE conname = 'NotificationEngineActivation_pkey' AND contype = 'p'
  UNION ALL SELECT 1 FROM con WHERE conname = 'NotificationEngineActivation_businessId_fkey' AND contype = 'f' AND confdeltype = 'c'
                                AND confrelid = (SELECT oid FROM rel WHERE nm = 'Business')
  UNION ALL SELECT 1 FROM con WHERE conname = 'NotificationEngineActivation_order' AND contype = 'c'
  UNION ALL SELECT 1 FROM con WHERE conname = 'NotificationEngineActivation_source' AND contype = 'c'),
fn AS (SELECT p.oid, p.proname, p.prosecdef, p.proowner, p.proconfig, p.proacl FROM pg_proc p
       WHERE p.pronamespace = (SELECT oid FROM pub)
         AND p.proname IN ('notification_engine_effective', 'notification_engine_record', 'notification_engine_override_changed',
                           'notification_engine_policy_changed', 'notification_engine_observe')),
fn_ok AS (SELECT 1 FROM fn WHERE proowner = (SELECT oid FROM me)
            AND proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
            AND prosecdef = (proname IN ('notification_engine_override_changed', 'notification_engine_policy_changed', 'notification_engine_observe'))),
fn_exec AS (SELECT fn.proname, x.grantee FROM fn CROSS JOIN LATERAL aclexplode(coalesce(fn.proacl, acldefault('f', fn.proowner))) x
            WHERE x.privilege_type = 'EXECUTE' AND x.grantee <> fn.proowner),
tg AS (SELECT tg.tgname, tg.tgrelid, tg.tgtype, tg.tgenabled, tg.tgattr, p.proname FROM pg_trigger tg JOIN pg_proc p ON p.oid = tg.tgfoid
       WHERE NOT tg.tgisinternal AND tg.tgname IN ('BusinessFeatureAccess_notification_engine_activation', 'PlatformFeaturePolicy_notification_engine_activation')),
-- tgtype bits: 1 row level, 2 before, 4 on a new row, 8 on removal, 16 on a change, 64 instead (here 1 | 4 | 16 = 21)
tg_ok AS (
            SELECT 1 FROM tg WHERE tgname = 'BusinessFeatureAccess_notification_engine_activation'
              AND tgrelid = (SELECT oid FROM rel WHERE nm = 'BusinessFeatureAccess') AND tgtype = (1 | 4 | 16) AND tgenabled = 'O'
              AND proname = 'notification_engine_override_changed'
              AND array_length(tgattr::int2[], 1) = 1
              AND (SELECT attname FROM pg_attribute WHERE attrelid = tgrelid AND attnum = tgattr[0]) = 'state'
  UNION ALL SELECT 1 FROM tg WHERE tgname = 'PlatformFeaturePolicy_notification_engine_activation'
              AND tgrelid = (SELECT oid FROM rel WHERE nm = 'PlatformFeaturePolicy') AND tgtype = (1 | 4 | 16) AND tgenabled = 'O'
              AND proname = 'notification_engine_policy_changed' AND coalesce(array_length(tgattr::int2[], 1), 0) = 0),
mig AS (SELECT started_at FROM "_prisma_migrations" WHERE migration_name = '20261212090000_notification_engine_activation'
          AND finished_at IS NOT NULL AND rolled_back_at IS NULL),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM mig) = 1, (SELECT count(*) FROM mig)
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261212090000_notification_engine_activation'
                        AND checksum = '49c21b567573a1da5f204faa93ee31971ad43d3c2052f3b7daa66f4dc40bdd07'), 1
  UNION ALL SELECT 4, (SELECT count(*) FROM t WHERE relrowsecurity AND relforcerowsecurity) = 1
                      AND (SELECT count(*) FROM pol) = 1
                      AND (SELECT count(*) FROM pol WHERE polcmd = 'r' AND q LIKE '%app.current_business_id%') = 1,
                      (SELECT count(*) FROM pol)
  UNION ALL SELECT 5, (SELECT count(*) FROM tacl WHERE grantee = (SELECT oid FROM rt) AND privilege_type = 'SELECT') = 1
                      AND NOT EXISTS (SELECT 1 FROM tacl WHERE NOT (grantee = (SELECT oid FROM rt) AND privilege_type = 'SELECT')),
                      (SELECT count(*) FROM tacl WHERE NOT (grantee = (SELECT oid FROM rt) AND privilege_type = 'SELECT'))
  UNION ALL SELECT 6, (SELECT count(*) FROM con_ok) = 4, (SELECT count(*) FROM con_ok)
  UNION ALL SELECT 7, (SELECT count(*) FROM fn) = 5 AND (SELECT count(*) FROM fn_ok) = 5, (SELECT count(*) FROM fn_ok)
  UNION ALL SELECT 8, (SELECT count(*) FROM fn_exec WHERE proname = 'notification_engine_observe' AND grantee = (SELECT oid FROM rt)) = 1
                      AND NOT EXISTS (SELECT 1 FROM fn_exec WHERE NOT (proname = 'notification_engine_observe' AND grantee = (SELECT oid FROM rt))),
                      (SELECT count(*) FROM fn_exec WHERE NOT (proname = 'notification_engine_observe' AND grantee = (SELECT oid FROM rt)))
  UNION ALL SELECT 9, (SELECT count(*) FROM tg_ok) = 2, (SELECT count(*) FROM tg_ok)
  UNION ALL SELECT 10, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261211090000_notification_engine_followup'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1,
                       (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261211090000_notification_engine_followup'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 11, (SELECT count(*) FROM "BusinessFeatureAccess" a
                          WHERE a."featureKey" = 'notifications_engine' AND a."state" = 'ENABLED'
                            AND NOT EXISTS (SELECT 1 FROM "PlatformFeaturePolicy" p WHERE p."featureKey" = 'notifications_engine' AND p."emergencyDisabled")
                            AND NOT EXISTS (SELECT 1 FROM "NotificationEngineActivation" e WHERE e."businessId" = a."businessId")) = 0,
                       (SELECT count(*) FROM "BusinessFeatureAccess" a
                          WHERE a."featureKey" = 'notifications_engine' AND a."state" = 'ENABLED'
                            AND NOT EXISTS (SELECT 1 FROM "PlatformFeaturePolicy" p WHERE p."featureKey" = 'notifications_engine' AND p."emergencyDisabled")
                            AND NOT EXISTS (SELECT 1 FROM "NotificationEngineActivation" e WHERE e."businessId" = a."businessId"))
  UNION ALL SELECT 12, (SELECT count(*) FROM "NotificationEngineActivation" e
                          WHERE e."lastSource" = 'migration'
                            AND e."firstActivatedAt" < ((SELECT started_at FROM mig) AT TIME ZONE 'UTC') - interval '1 minute') = 0,
                       (SELECT count(*) FROM "NotificationEngineActivation" e
                          WHERE e."lastSource" = 'migration'
                            AND e."firstActivatedAt" < ((SELECT started_at FROM mig) AT TIME ZONE 'UTC') - interval '1 minute')
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
