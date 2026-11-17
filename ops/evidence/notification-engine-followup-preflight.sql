-- ============================================================================
-- notification-engine-followup-preflight.sql
--
-- Read-only Production PREFLIGHT before migration
--   20261211090000_notification_engine_followup
--
-- Proves, from the catalog and counts only, that the migration will apply exactly as it did in the lab:
--   * it is not recorded yet and the ledger is clean;
--   * what it builds on is there: the foundation 20261210090000_notification_engine_foundation recorded and
--     finished (it adds the columns this one indexes), task_reminders_due() (whose conditions the new function
--     mirrors), the columns indexed, and the role app_runtime; the evidence role owns every table it touches;
--   * every name it introduces is free (the function, the four indexes) and the feature `notifications_engine`
--     has no definition or policy row yet (the seed would otherwise keep a different row);
--   * INFO: how many PUSH deliveries are PENDING (the size of the new partial index) — a count, never a failure.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== notification engine follow-up preflight: legend (n -> check) =='
\echo ' 1 the migration is not recorded (observed = ledger rows with its name)'
\echo ' 2 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 3 the foundation migration 20261210090000 is recorded and finished (observed = such rows)'
\echo ' 4 task_reminders_due(timestamp, integer) exists and the role app_runtime exists (observed = of 2)'
\echo ' 5 task_reminders_due_excluding does not exist (observed = present)'
\echo ' 6 none of the four new index names is taken (observed = taken)'
\echo ' 7 the indexed columns exist: NotificationDelivery nextAttemptAt, subscriptionId, userId; Notification userId (observed = of 4)'
\echo ' 8 the feature notifications_engine has no definition and no policy row yet (observed = rows)'
\echo ' 9 the evidence role owns Task, Notification, NotificationDelivery, PlatformFeatureDefinition, PlatformFeaturePolicy (observed = of 5)'
\echo '10 INFO: PENDING PUSH deliveries (rows the new partial index will hold)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
rel(nm, oid, relowner) AS (SELECT c.relname, c.oid, c.relowner FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub)),
me AS (SELECT oid FROM pg_roles WHERE rolname = current_user),
dep_cols(tbl, col) AS (VALUES ('NotificationDelivery', 'nextAttemptAt'), ('NotificationDelivery', 'subscriptionId'),
  ('NotificationDelivery', 'userId'), ('Notification', 'userId')),
new_names(nm) AS (VALUES ('NotificationDelivery_push_owed_due_idx'), ('NotificationDelivery_subscriptionId_idx'),
  ('NotificationDelivery_userId_idx'), ('Notification_userId_idx')),
taken AS (SELECT nm FROM new_names WHERE EXISTS (SELECT 1 FROM rel WHERE rel.nm = new_names.nm)
                                       OR EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conname = new_names.nm AND k.connamespace = (SELECT oid FROM pub))),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261211090000_notification_engine_followup') = 0,
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261211090000_notification_engine_followup')
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261210090000_notification_engine_foundation'
                         AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261210090000_notification_engine_foundation'
                         AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 4, (SELECT count(*) FROM pg_proc WHERE pronamespace = (SELECT oid FROM pub) AND proname = 'task_reminders_due' AND pronargs = 2)
                      + (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime') = 2,
                      (SELECT count(*) FROM pg_proc WHERE pronamespace = (SELECT oid FROM pub) AND proname = 'task_reminders_due' AND pronargs = 2)
                      + (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime')
  UNION ALL SELECT 5, (SELECT count(*) FROM pg_proc WHERE pronamespace = (SELECT oid FROM pub) AND proname = 'task_reminders_due_excluding') = 0,
                      (SELECT count(*) FROM pg_proc WHERE pronamespace = (SELECT oid FROM pub) AND proname = 'task_reminders_due_excluding')
  UNION ALL SELECT 6, NOT EXISTS (SELECT 1 FROM taken), (SELECT count(*) FROM taken)
  UNION ALL SELECT 7, (SELECT count(*) FROM dep_cols c JOIN rel r ON r.nm = c.tbl
                         JOIN pg_attribute a ON a.attrelid = r.oid AND a.attname = c.col AND NOT a.attisdropped) = 4,
                      (SELECT count(*) FROM dep_cols c JOIN rel r ON r.nm = c.tbl
                         JOIN pg_attribute a ON a.attrelid = r.oid AND a.attname = c.col AND NOT a.attisdropped)
  UNION ALL SELECT 8, (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE "key" = 'notifications_engine')
                      + (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'notifications_engine') = 0,
                      (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE "key" = 'notifications_engine')
                      + (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'notifications_engine')
  UNION ALL SELECT 9, (SELECT count(*) FROM rel WHERE nm IN ('Task', 'Notification', 'NotificationDelivery', 'PlatformFeatureDefinition', 'PlatformFeaturePolicy')
                         AND relowner = (SELECT oid FROM me)) = 5,
                      (SELECT count(*) FROM rel WHERE nm IN ('Task', 'Notification', 'NotificationDelivery', 'PlatformFeatureDefinition', 'PlatformFeaturePolicy')
                         AND relowner = (SELECT oid FROM me))
  UNION ALL SELECT 10, true, (SELECT count(*) FROM "NotificationDelivery" WHERE "channel" = 'PUSH' AND "status" = 'PENDING')
)
SELECT n, CASE WHEN n = 10 THEN 'INFO' WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
