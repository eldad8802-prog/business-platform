-- ============================================================================
-- notification-engine-foundation-preflight.sql
--
-- Read-only Production PREFLIGHT before migration
--   20261210090000_notification_engine_foundation
--
-- Proves, from the catalog and counts only, that the migration will apply exactly as it did in the lab:
--   * it is not recorded yet and the ledger is clean;
--   * what it builds on is there: "PushSubscription" with its current endpoint check (no FCM branch yet),
--     "Notification" / "NotificationDelivery" under FORCE RLS, "AuthSession" with the columns
--     auth_sessions_live reads, "User"."tokenVersion", the "Business" deletion columns, the trigger function
--     task_user_same_business and the app_runtime role; the migration role owns every table it changes;
--   * every name it introduces is free (columns, constraints, indexes, triggers, tables, functions);
--   * every existing "PushSubscription" row satisfies the new endpoint check as a WEB_PUSH row (the default
--     each one receives), so the check cannot fail on Production data;
--   * INFO: how many PUSH deliveries the current code has left PENDING (each would be due at once for a
--     future push worker) — a count, reported, never a failure.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== notification engine foundation preflight: legend (n -> check) =='
\echo ' 1 the migration is not recorded (observed = ledger rows with its name)'
\echo ' 2 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 3 "PushSubscription_endpoint_shape" exists, validated, without an FCM branch (observed = matching)'
\echo ' 4 none of the new columns exists yet on PushSubscription / Notification / NotificationDelivery (observed = present, of 13)'
\echo ' 5 "NotificationSettings" and "NotificationPreference" are absent (observed = present)'
\echo ' 6 none of the three functions exists (observed = present)'
\echo ' 7 none of the new constraint, index or trigger names is taken (observed = taken)'
\echo ' 8 "Notification" and "NotificationDelivery" are RLS ENABLED + FORCED (observed = tables, of 2)'
\echo ' 9 "AuthSession" has id (uuid), userId, revokedAt, idleExpiresAt, absoluteExpiresAt, tokenVersionAtIssue; "User"."tokenVersion"; "Business" deletionRequestedAt + deletedAt (observed = of 9)'
\echo '10 task_user_same_business() exists and the role app_runtime exists (observed = of 2)'
\echo '11 the evidence role owns PushSubscription, Notification, NotificationDelivery, AuthSession, User, Business (observed = of 6)'
\echo '12 every existing PushSubscription endpoint is a web push URL of at most 1024 characters or erased:<n> (observed = rows outside)'
\echo '13 INFO: PENDING PUSH deliveries already written by the current code (observed = rows)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
rel(nm, oid, relowner, relrowsecurity, relforcerowsecurity) AS (
  SELECT c.relname, c.oid, c.relowner, c.relrowsecurity, c.relforcerowsecurity
  FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub)),
me AS (SELECT oid FROM pg_roles WHERE rolname = current_user),
new_cols(tbl, col) AS (VALUES ('PushSubscription', 'provider'), ('PushSubscription', 'authSessionId'),
  ('PushSubscription', 'revokedReason'), ('PushSubscription', 'lastSeenAt'), ('PushSubscription', 'appVersion'),
  ('Notification', 'userId'), ('NotificationDelivery', 'userId'), ('NotificationDelivery', 'subscriptionId'),
  ('NotificationDelivery', 'attempts'), ('NotificationDelivery', 'nextAttemptAt'), ('NotificationDelivery', 'leaseUntil'),
  ('NotificationDelivery', 'expiresAt'), ('NotificationDelivery', 'completedAt')),
dep_cols(tbl, col, typ) AS (VALUES ('AuthSession', 'id', 'uuid'), ('AuthSession', 'userId', 'integer'),
  ('AuthSession', 'revokedAt', 'timestamp(3) without time zone'), ('AuthSession', 'idleExpiresAt', 'timestamp(3) without time zone'),
  ('AuthSession', 'absoluteExpiresAt', 'timestamp(3) without time zone'), ('AuthSession', 'tokenVersionAtIssue', 'integer'),
  ('User', 'tokenVersion', 'integer'), ('Business', 'deletionRequestedAt', 'timestamp(3) without time zone'),
  ('Business', 'deletedAt', 'timestamp(3) without time zone')),
new_names(nm) AS (VALUES ('PushSubscription_provider'), ('PushSubscription_revoked_reason_shape'),
  ('PushSubscription_app_version_shape'), ('PushSubscription_id_businessId_key'), ('PushSubscription_authSessionId_fkey'),
  ('PushSubscription_authSessionId_live_idx'), ('Notification_userId_fkey'), ('Notification_businessId_userId_lastSurfacedAt_idx'),
  ('NotificationDelivery_attempts_range'), ('NotificationDelivery_userId_fkey'), ('NotificationDelivery_subscription_fkey'),
  ('NotificationDelivery_push_owed_idx'), ('NotificationDelivery_push_sent_by_user_idx'),
  ('Notification_user_same_business'), ('NotificationDelivery_user_same_business')),
taken AS (SELECT nm FROM new_names WHERE EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conname = new_names.nm AND k.connamespace = (SELECT oid FROM pub))
                                       OR EXISTS (SELECT 1 FROM rel WHERE rel.nm = new_names.nm)
                                       OR EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgname = new_names.nm AND NOT g.tgisinternal)),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261210090000_notification_engine_foundation') = 0,
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261210090000_notification_engine_foundation')
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM rel WHERE nm = 'PushSubscription')
                         AND k.conname = 'PushSubscription_endpoint_shape' AND k.contype = 'c' AND k.convalidated
                         AND pg_get_constraintdef(k.oid) NOT LIKE '%FCM%') = 1,
                      (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM rel WHERE nm = 'PushSubscription')
                         AND k.conname = 'PushSubscription_endpoint_shape' AND k.contype = 'c' AND k.convalidated
                         AND pg_get_constraintdef(k.oid) NOT LIKE '%FCM%')
  UNION ALL SELECT 4, (SELECT count(*) FROM new_cols c JOIN rel r ON r.nm = c.tbl JOIN pg_attribute a ON a.attrelid = r.oid AND a.attname = c.col AND NOT a.attisdropped) = 0,
                      (SELECT count(*) FROM new_cols c JOIN rel r ON r.nm = c.tbl JOIN pg_attribute a ON a.attrelid = r.oid AND a.attname = c.col AND NOT a.attisdropped)
  UNION ALL SELECT 5, (SELECT count(*) FROM rel WHERE nm IN ('NotificationSettings', 'NotificationPreference', 'NotificationSettings_id_seq', 'NotificationPreference_id_seq')) = 0,
                      (SELECT count(*) FROM rel WHERE nm IN ('NotificationSettings', 'NotificationPreference', 'NotificationSettings_id_seq', 'NotificationPreference_id_seq'))
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_proc WHERE pronamespace = (SELECT oid FROM pub)
                         AND proname IN ('notification_push_due', 'notification_live_businesses', 'auth_sessions_live')) = 0,
                      (SELECT count(*) FROM pg_proc WHERE pronamespace = (SELECT oid FROM pub)
                         AND proname IN ('notification_push_due', 'notification_live_businesses', 'auth_sessions_live'))
  UNION ALL SELECT 7, NOT EXISTS (SELECT 1 FROM taken), (SELECT count(*) FROM taken)
  UNION ALL SELECT 8, (SELECT count(*) FROM rel WHERE nm IN ('Notification', 'NotificationDelivery') AND relrowsecurity AND relforcerowsecurity) = 2,
                      (SELECT count(*) FROM rel WHERE nm IN ('Notification', 'NotificationDelivery') AND relrowsecurity AND relforcerowsecurity)
  UNION ALL SELECT 9, (SELECT count(*) FROM dep_cols c JOIN rel r ON r.nm = c.tbl JOIN pg_attribute a ON a.attrelid = r.oid AND a.attname = c.col
                         WHERE NOT a.attisdropped AND format_type(a.atttypid, a.atttypmod) = c.typ) = 9,
                      (SELECT count(*) FROM dep_cols c JOIN rel r ON r.nm = c.tbl JOIN pg_attribute a ON a.attrelid = r.oid AND a.attname = c.col
                         WHERE NOT a.attisdropped AND format_type(a.atttypid, a.atttypmod) = c.typ)
  UNION ALL SELECT 10, (SELECT count(*) FROM pg_proc WHERE pronamespace = (SELECT oid FROM pub) AND proname = 'task_user_same_business' AND pronargs = 0)
                       + (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime') = 2,
                       (SELECT count(*) FROM pg_proc WHERE pronamespace = (SELECT oid FROM pub) AND proname = 'task_user_same_business' AND pronargs = 0)
                       + (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime')
  UNION ALL SELECT 11, (SELECT count(*) FROM rel WHERE nm IN ('PushSubscription', 'Notification', 'NotificationDelivery', 'AuthSession', 'User', 'Business')
                          AND relowner = (SELECT oid FROM me)) = 6,
                       (SELECT count(*) FROM rel WHERE nm IN ('PushSubscription', 'Notification', 'NotificationDelivery', 'AuthSession', 'User', 'Business')
                          AND relowner = (SELECT oid FROM me))
  UNION ALL SELECT 12, (SELECT count(*) FROM "PushSubscription"
                          WHERE NOT (("endpoint" ~ '^https://[^[:space:]]+$' AND char_length("endpoint") <= 1024) OR "endpoint" ~ '^erased:[0-9]+$')) = 0,
                       (SELECT count(*) FROM "PushSubscription"
                          WHERE NOT (("endpoint" ~ '^https://[^[:space:]]+$' AND char_length("endpoint") <= 1024) OR "endpoint" ~ '^erased:[0-9]+$'))
  UNION ALL SELECT 13, true, (SELECT count(*) FROM "NotificationDelivery" WHERE "channel" = 'PUSH' AND "status" = 'PENDING')
)
SELECT n, CASE WHEN n = 13 THEN 'INFO' WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
