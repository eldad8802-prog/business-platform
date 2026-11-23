-- ============================================================================
-- notifications-engine-open-all-production-evidence.sql
--
-- Read-only Production EVIDENCE AFTER the notification engine is opened for every business (20261215100000 applied,
-- the application PR live). Window for sends: the last 2 hours. Flags and counts only:
--   A.  2-6   the migration is recorded once with the pinned checksum; the engine rows are ON; overrides unchanged;
--   B.  7-9   activation: every live business gets its record as the status sweep / worker observes it ON;
--   C. 10-18  real sends: owed engine pushes by outcome, per-device attempts (Android / browser), sent / failed;
--   D. 19-24  safety: no device got the same notification twice, no delivery crosses a business, a personal
--             notification reaches only its own user's devices, the legacy push loop is silent, no browser push went
--             to a device without a session.
--
-- PRIVACY: guard-clean (no write keyword anywhere, prose included). No names, no ids, no tokens, no endpoints.
-- ============================================================================

\echo '== notifications engine open-all proof: legend (n -> check) =='
\echo ' 1 the evidence role is a superuser or has BYPASSRLS (flag; expected t)'
\echo ' 2 20261215100000_notifications_engine_open_all recorded once, finished, not rolled back, pinned checksum (flag; expected t)'
\echo ' 3 ledger rows unfinished or rolled back (count; expected 0)'
\echo ' 4 notifications_engine: definition default ON, policy global ON, emergency OFF (flag; expected t)'
\echo ' 5 notifications_engine overrides ENABLED (count; expected = preflight 13)'
\echo ' 6 notifications_engine overrides DISABLED (count; expected = preflight 14)'
\echo ' 7 engine activation records (count; grows to the live businesses as the sweep observes them)'
\echo ' 8   of them recorded by the worker observation (count)'
\echo ' 9 live businesses with NO activation record (count; expected 0 from about 15 minutes after go-live)'
\echo '10 owed engine pushes written in the window (count)'
\echo '11   SENT (count)'
\echo '12   SUPPRESSED (count; preferences, quiet hours, no device)'
\echo '13   still PENDING (count; quiet-hours deferrals and retries in flight)'
\echo '14   FAILED (count; expected 0 or few: expired / retries exhausted)'
\echo '15 device attempts to an Android (FCM) device in the window, SENT (count)'
\echo '16 device attempts to an Android (FCM) device in the window, FAILED (count)'
\echo '17 device attempts to a browser (web push) device in the window, SENT (count)'
\echo '18 device attempts to a browser (web push) device in the window, FAILED (count)'
\echo '19 (notification, device) pairs SENT more than once in the last 24 hours (count; expected 0)'
\echo '20 deliveries whose device belongs to another business (count; expected 0)'
\echo '21 deliveries of a personal notification to another user''s device (count; expected 0)'
\echo '22 legacy task reminder push rows (no device, no expiry) in the window (count; expected 0)'
\echo '23 browser pushes SENT in the window to a device with no session (count; expected 0)'
\echo '24 businesses with an engine push SENT in the window (count; info)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

WITH
pin(lf, crlf) AS (VALUES ('89857a9b9b10ff6f0f10083926126c2d522e9138f3a0460c89a93d593d3ef9e9', 'a86b9d2e28e5be617c7ed23c97d5b34368cda056c99944346c4b6a35d6597197')),
nowts AS (SELECT (now() AT TIME ZONE 'UTC')::timestamp(3) AS ts),
live_b AS (SELECT b."id" FROM "Business" b WHERE b."deletedAt" IS NULL AND b."deletionRequestedAt" IS NULL),
owed AS (
  SELECT dl."status"::text AS status, dl."businessId" FROM "NotificationDelivery" dl, nowts
   WHERE dl."channel" = 'PUSH' AND dl."subscriptionId" IS NULL AND dl."expiresAt" IS NOT NULL AND dl."createdAt" >= nowts.ts - INTERVAL '2 hours'
),
att AS (
  SELECT dl."notificationId", dl."subscriptionId", dl."status"::text AS status, dl."createdAt", ps."provider", ps."authSessionId"
    FROM "NotificationDelivery" dl JOIN "PushSubscription" ps ON ps."id" = dl."subscriptionId"
   WHERE dl."channel" = 'PUSH'
),
lines(n, flag, observed_count) AS (
            SELECT 1, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user), NULL::bigint
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" m, pin WHERE m.migration_name = '20261215100000_notifications_engine_open_all'
                         AND m.finished_at IS NOT NULL AND m.rolled_back_at IS NULL AND m.checksum IN (pin.lf, pin.crlf)) = 1
                    AND (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261215100000_notifications_engine_open_all') = 1, NULL
  UNION ALL SELECT 3, NULL, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 4, EXISTS (SELECT 1 FROM "PlatformFeatureDefinition" fd JOIN "PlatformFeaturePolicy" fp ON fp."featureKey" = fd."key"
                               WHERE fd."key" = 'notifications_engine' AND fd."defaultEnabled" AND fp."globalEnabled" AND NOT fp."emergencyDisabled"), NULL
  UNION ALL SELECT 5, NULL, (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'notifications_engine' AND "state"::text = 'ENABLED')
  UNION ALL SELECT 6, NULL, (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'notifications_engine' AND "state"::text = 'DISABLED')
  UNION ALL SELECT 7, NULL, (SELECT count(*) FROM "NotificationEngineActivation")
  UNION ALL SELECT 8, NULL, (SELECT count(*) FROM "NotificationEngineActivation" WHERE "lastSource" = 'worker')
  UNION ALL SELECT 9, NULL, (SELECT count(*) FROM live_b WHERE NOT EXISTS (SELECT 1 FROM "NotificationEngineActivation" a WHERE a."businessId" = live_b."id"))
  UNION ALL SELECT 10, NULL, (SELECT count(*) FROM owed)
  UNION ALL SELECT 11, NULL, (SELECT count(*) FROM owed WHERE status = 'SENT')
  UNION ALL SELECT 12, NULL, (SELECT count(*) FROM owed WHERE status = 'SUPPRESSED')
  UNION ALL SELECT 13, NULL, (SELECT count(*) FROM owed WHERE status = 'PENDING')
  UNION ALL SELECT 14, NULL, (SELECT count(*) FROM owed WHERE status = 'FAILED')
  UNION ALL SELECT 15, NULL, (SELECT count(*) FROM att, nowts WHERE "provider" = 'FCM' AND status = 'SENT' AND att."createdAt" >= nowts.ts - INTERVAL '2 hours')
  UNION ALL SELECT 16, NULL, (SELECT count(*) FROM att, nowts WHERE "provider" = 'FCM' AND status = 'FAILED' AND att."createdAt" >= nowts.ts - INTERVAL '2 hours')
  UNION ALL SELECT 17, NULL, (SELECT count(*) FROM att, nowts WHERE "provider" = 'WEB_PUSH' AND status = 'SENT' AND att."createdAt" >= nowts.ts - INTERVAL '2 hours')
  UNION ALL SELECT 18, NULL, (SELECT count(*) FROM att, nowts WHERE "provider" = 'WEB_PUSH' AND status = 'FAILED' AND att."createdAt" >= nowts.ts - INTERVAL '2 hours')
  UNION ALL SELECT 19, NULL, (SELECT count(*) FROM (SELECT 1 FROM att, nowts WHERE status = 'SENT' AND att."createdAt" >= nowts.ts - INTERVAL '24 hours'
                                GROUP BY "notificationId", "subscriptionId" HAVING count(*) > 1) x)
  UNION ALL SELECT 20, NULL, (SELECT count(*) FROM "NotificationDelivery" dl JOIN "PushSubscription" ps ON ps."id" = dl."subscriptionId"
                                WHERE ps."businessId" <> dl."businessId")
  UNION ALL SELECT 21, NULL, (SELECT count(*) FROM "NotificationDelivery" dl JOIN "PushSubscription" ps ON ps."id" = dl."subscriptionId"
                                JOIN "Notification" nt ON nt."id" = dl."notificationId"
                                WHERE nt."userId" IS NOT NULL AND ps."userId" <> nt."userId")
  UNION ALL SELECT 22, NULL, (SELECT count(*) FROM "NotificationDelivery" dl JOIN "Notification" nt ON nt."id" = dl."notificationId", nowts
                                WHERE nt."domain" = 'tasks' AND nt."semanticCategory" = 'task_reminder' AND dl."channel" = 'PUSH'
                                  AND dl."subscriptionId" IS NULL AND dl."expiresAt" IS NULL AND dl."createdAt" >= nowts.ts - INTERVAL '2 hours')
  UNION ALL SELECT 23, NULL, (SELECT count(*) FROM att, nowts WHERE "provider" = 'WEB_PUSH' AND status = 'SENT' AND "authSessionId" IS NULL
                                AND att."createdAt" >= nowts.ts - INTERVAL '2 hours')
  UNION ALL SELECT 24, NULL, (SELECT count(DISTINCT "businessId") FROM owed WHERE status = 'SENT')
)
SELECT n, flag, observed_count FROM lines ORDER BY n;

ROLLBACK;
