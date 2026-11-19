-- ============================================================================
-- notification-engine-followup-production-evidence.sql
--
-- Read-only Production EVIDENCE after migration
--   20261211090000_notification_engine_followup
-- (which depends on 20261210090000_notification_engine_foundation, check 11).
--
-- Proves the migration's outcome, from the catalog and counts only:
--   * it is recorded and finished, its sha256 is the reviewed one, nothing is unfinished or rolled back;
--   * task_reminders_due_excluding: SECURITY DEFINER, STABLE, search_path pinned, owned by the migration role,
--     the documented output columns, EXECUTE for app_runtime alone (no PUBLIC);
--   * the owed-push index in the worker's order (first key NULLS FIRST) and the three cascade indexes, all
--     partial, none unique; the foundation's owed-push index is still there (kept: expand-only);
--   * the feature notifications_engine is defined OFF (defaultEnabled false, mutable) with its global policy OFF
--     (globalEnabled false, not emergency-disabled), and no business override exists at release time.
--
-- Checks 21 and 22 run first: row counts are taken with row_security = off, so a query that row level security
-- would filter stops the run with an ERROR instead of reporting a smaller number.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== notification engine follow-up production evidence: legend (n -> check) =='
\echo '21 V1 the evidence role is a superuser or has BYPASSRLS, so it sees every row (runs first)'
\echo '22 V2 row level security is not active on "BusinessFeatureAccess" for the evidence role (runs first)'
\echo ' 1 the migration is recorded and finished (observed = finished rows)'
\echo ' 2 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 3 the recorded checksum is the reviewed sha256 of migration.sql'
\echo ' 4 task_reminders_due_excluding: SECURITY DEFINER, STABLE, search_path pinned, owned by the migration role (observed = of 1)'
\echo ' 5 task_reminders_due_excluding returns businessId, remindAt, taskId; EXECUTE for app_runtime alone, no PUBLIC (observed = other grants)'
\echo ' 6 the four new indexes: on their table, partial, valid, not unique (observed = of 4)'
\echo ' 7 the owed-push index orders nextAttemptAt NULLS FIRST, then id (observed = of 1)'
\echo ' 8 the foundation index NotificationDelivery_push_owed_idx is kept (observed = of 1)'
\echo ' 9 PlatformFeatureDefinition notifications_engine: defaultEnabled false, mutable true (observed = of 1)'
\echo '10 PlatformFeaturePolicy notifications_engine: globalEnabled false, emergencyDisabled false (observed = of 1)'
\echo '11 the foundation 20261210090000 is recorded and finished, the dependency (observed = such rows)'
\echo '12 at release time no business override exists for notifications_engine (observed = rows)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

\echo '== visibility checks (21, 22) =='
WITH
bfa AS (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'BusinessFeatureAccess' AND c.relkind = 'r'),
checks(n, ok, observed_count) AS (
            SELECT 21, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) IS TRUE, 1
  UNION ALL SELECT 22, row_security_active((SELECT oid FROM bfa)) IS FALSE, 1
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

\echo '== evidence checks (1-12) =='
WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
rel(nm, oid) AS (SELECT c.relname, c.oid FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub)),
me AS (SELECT oid FROM pg_roles WHERE rolname = current_user),
rt AS (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime'),
idx(tbl, nm) AS (VALUES ('NotificationDelivery', 'NotificationDelivery_push_owed_due_idx'),
  ('NotificationDelivery', 'NotificationDelivery_subscriptionId_idx'), ('NotificationDelivery', 'NotificationDelivery_userId_idx'),
  ('Notification', 'Notification_userId_idx')),
idx_ok AS (SELECT x.nm FROM idx x JOIN rel i ON i.nm = x.nm JOIN pg_index p ON p.indexrelid = i.oid
           WHERE p.indrelid = (SELECT oid FROM rel WHERE nm = x.tbl) AND p.indpred IS NOT NULL AND NOT p.indisunique AND p.indisvalid),
due_order AS (SELECT p.indexrelid FROM pg_index p JOIN rel i ON i.oid = p.indexrelid
              WHERE i.nm = 'NotificationDelivery_push_owed_due_idx' AND p.indnatts = 2
                AND (SELECT attname FROM pg_attribute WHERE attrelid = p.indrelid AND attnum = p.indkey[0]) = 'nextAttemptAt'
                AND (SELECT attname FROM pg_attribute WHERE attrelid = p.indrelid AND attnum = p.indkey[1]) = 'id'
                AND (p.indoption[0] & 3) = 2 AND (p.indoption[1] & 3) = 0),
fn AS (SELECT p.oid, p.proname, p.prosecdef, p.provolatile, p.proowner, p.proconfig, p.proacl, p.proargnames, p.proargmodes
       FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pub) AND p.proname = 'task_reminders_due_excluding'),
fn_out AS (SELECT string_agg(a.n, ',' ORDER BY a.n) AS outs
           FROM fn CROSS JOIN LATERAL unnest(fn.proargnames, fn.proargmodes) AS a(n, m) WHERE a.m = 't'),
fn_exec AS (SELECT x.grantee FROM fn CROSS JOIN LATERAL aclexplode(fn.proacl) x
            WHERE x.privilege_type = 'EXECUTE' AND x.grantee <> fn.proowner),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261211090000_notification_engine_followup'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1,
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261211090000_notification_engine_followup'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261211090000_notification_engine_followup'
                        AND checksum = '0414db8a72f027fdedd64d1b91c05885a580cf2296a63b317f4817cdce0c020b'), 1
  UNION ALL SELECT 4, (SELECT count(*) FROM fn WHERE prosecdef AND provolatile = 's' AND proowner = (SELECT oid FROM me)
                         AND proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']::text[]) = 1,
                      (SELECT count(*) FROM fn WHERE prosecdef AND provolatile = 's' AND proowner = (SELECT oid FROM me)
                         AND proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']::text[])
  UNION ALL SELECT 5, (SELECT count(*) FROM fn) = 1
                      AND (SELECT outs FROM fn_out) = 'businessId,remindAt,taskId'
                      AND (SELECT count(*) FROM fn_exec WHERE grantee = (SELECT oid FROM rt)) = 1
                      AND NOT EXISTS (SELECT 1 FROM fn_exec WHERE grantee <> (SELECT oid FROM rt)),
                      (SELECT count(*) FROM fn_exec WHERE grantee <> (SELECT oid FROM rt))
  UNION ALL SELECT 6, (SELECT count(*) FROM idx_ok) = 4, (SELECT count(*) FROM idx_ok)
  UNION ALL SELECT 7, (SELECT count(*) FROM due_order) = 1, (SELECT count(*) FROM due_order)
  UNION ALL SELECT 8, (SELECT count(*) FROM rel WHERE nm = 'NotificationDelivery_push_owed_idx') = 1,
                      (SELECT count(*) FROM rel WHERE nm = 'NotificationDelivery_push_owed_idx')
  UNION ALL SELECT 9, (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE "key" = 'notifications_engine' AND NOT "defaultEnabled" AND "mutable") = 1,
                      (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE "key" = 'notifications_engine' AND NOT "defaultEnabled" AND "mutable")
  UNION ALL SELECT 10, (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'notifications_engine' AND NOT "globalEnabled" AND NOT "emergencyDisabled") = 1,
                       (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'notifications_engine' AND NOT "globalEnabled" AND NOT "emergencyDisabled")
  UNION ALL SELECT 11, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261210090000_notification_engine_foundation'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1,
                       (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261210090000_notification_engine_foundation'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 12, (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'notifications_engine') = 0,
                       (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'notifications_engine')
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
