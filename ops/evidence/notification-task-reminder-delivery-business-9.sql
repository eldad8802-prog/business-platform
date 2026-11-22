-- ============================================================================
-- notification-task-reminder-delivery-business-9.sql
--
-- Read-only Production EVIDENCE for the first real task reminders sent through the notification engine
-- (#1218: a business with notifications_engine ON sends a due task reminder as ONE owed engine push to every live
-- device of its user; the legacy web push loop sends nothing for that business). Window: the last 6 hours.
--   A. 2-6    business 9's task reminders: each has exactly one in-app row and exactly one owed ENGINE push, and NO
--             legacy push row (the legacy loop writes subscription-less PUSH rows without expiresAt);
--   B. 7-10   how the owed pushes ended;
--   C. 11-17  per-device attempts: FCM (Android) and web push, sent / failed; NO device got the same reminder twice;
--   D. 20-24  other businesses: no engine push for a task reminder outside business 9, their legacy path intact
--             (informational), no live FCM device outside business 9, the engine policy and overrides unchanged.
--
-- OUTPUT (redaction-friendly): n | flag | observed_count + an \echo legend. Public logs: counts and booleans only —
-- no id, token, endpoint, title, name or e-mail is selected.
-- PRIVACY: guard-clean (no write keyword anywhere, prose included).
-- ============================================================================

\echo '== task reminders through the engine, business 9, last 6 hours: legend (n -> check) =='
\echo ' 1 the evidence role is a superuser or has BYPASSRLS (flag; expected t)'
\echo ' 2 task reminder notifications of business 9 surfaced in the window (count)'
\echo ' 3   of them with exactly ONE in-app row (count; expected = 2)'
\echo ' 4   of them with exactly ONE owed engine push (count; expected = 2 for reminders not over a day old)'
\echo ' 5   of them with MORE than one owed engine push (count; expected 0)'
\echo ' 6   legacy push rows on them (subscription-less, no expiry) (count; expected 0)'
\echo ' 7 owed engine pushes SENT (count)'
\echo ' 8 owed engine pushes SUPPRESSED (count; pref_off / no_device are possible, see 9)'
\echo ' 9 owed engine pushes SUPPRESSED as no_device (count)'
\echo '10 owed engine pushes still PENDING or FAILED (count)'
\echo '11 device attempts to an FCM (Android) device (count)'
\echo '12   SENT = Firebase answered 200 (count)'
\echo '13   FAILED (count)'
\echo '14 device attempts to a web push (browser) device (count)'
\echo '15   SENT (count)'
\echo '16   FAILED (count)'
\echo '17 (reminder, device) pairs SENT more than once (count; expected 0 — no duplicate)'
\echo '20 owed engine pushes for task reminders OUTSIDE business 9 in the window (count; expected 0)'
\echo '21 legacy task reminder push rows outside business 9 in the window (count; informational — their unchanged path)'
\echo '22 live FCM devices outside business 9 (count; expected 0)'
\echo '23 the notifications_engine policy: globalEnabled false, not emergency-disabled (flag; expected t)'
\echo '24 notifications_engine overrides ENABLED: business 9 only (flag; expected t)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

WITH
since AS (SELECT ((now() AT TIME ZONE 'UTC') - INTERVAL '6 hours')::timestamp(3) AS ts),
rem AS (
  SELECT n."id", n."businessId" FROM "Notification" n
   WHERE n."domain" = 'tasks' AND n."semanticCategory" = 'task_reminder' AND n."lastSurfacedAt" >= (SELECT ts FROM since)
),
r9 AS (SELECT "id" FROM rem WHERE "businessId" = 9),
d9 AS (
  SELECT d."notificationId", d."channel"::text AS channel, d."status"::text AS status, d."error", d."subscriptionId", d."expiresAt", d."createdAt"
    FROM "NotificationDelivery" d JOIN r9 ON r9."id" = d."notificationId" WHERE d."businessId" = 9
),
owed AS (SELECT * FROM d9 WHERE channel = 'PUSH' AND "subscriptionId" IS NULL AND "expiresAt" IS NOT NULL),
legacy AS (SELECT * FROM d9 WHERE channel = 'PUSH' AND "subscriptionId" IS NULL AND "expiresAt" IS NULL),
att AS (
  SELECT d9.*, p."provider" FROM d9 JOIN "PushSubscription" p ON p."id" = d9."subscriptionId" AND p."businessId" = 9
   WHERE d9.channel = 'PUSH'
),
per AS (
  SELECT r9."id",
         (SELECT count(*) FROM d9 WHERE d9."notificationId" = r9."id" AND d9.channel = 'IN_APP') AS inapp,
         (SELECT count(*) FROM owed WHERE owed."notificationId" = r9."id") AS owed
    FROM r9
),
lines(n, flag, observed_count) AS (
            SELECT 1, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user), NULL::bigint
  UNION ALL SELECT 2, NULL, (SELECT count(*) FROM r9)
  UNION ALL SELECT 3, NULL, (SELECT count(*) FROM per WHERE inapp = 1)
  UNION ALL SELECT 4, NULL, (SELECT count(*) FROM per WHERE owed = 1)
  UNION ALL SELECT 5, NULL, (SELECT count(*) FROM per WHERE owed > 1)
  UNION ALL SELECT 6, NULL, (SELECT count(*) FROM legacy)
  UNION ALL SELECT 7, NULL, (SELECT count(*) FROM owed WHERE status = 'SENT')
  UNION ALL SELECT 8, NULL, (SELECT count(*) FROM owed WHERE status = 'SUPPRESSED')
  UNION ALL SELECT 9, NULL, (SELECT count(*) FROM owed WHERE status = 'SUPPRESSED' AND "error" = 'no_device')
  UNION ALL SELECT 10, NULL, (SELECT count(*) FROM owed WHERE status IN ('PENDING', 'FAILED'))
  UNION ALL SELECT 11, NULL, (SELECT count(*) FROM att WHERE "provider" = 'FCM')
  UNION ALL SELECT 12, NULL, (SELECT count(*) FROM att WHERE "provider" = 'FCM' AND status = 'SENT')
  UNION ALL SELECT 13, NULL, (SELECT count(*) FROM att WHERE "provider" = 'FCM' AND status = 'FAILED')
  UNION ALL SELECT 14, NULL, (SELECT count(*) FROM att WHERE "provider" = 'WEB_PUSH')
  UNION ALL SELECT 15, NULL, (SELECT count(*) FROM att WHERE "provider" = 'WEB_PUSH' AND status = 'SENT')
  UNION ALL SELECT 16, NULL, (SELECT count(*) FROM att WHERE "provider" = 'WEB_PUSH' AND status = 'FAILED')
  UNION ALL SELECT 17, NULL, (SELECT count(*) FROM (SELECT 1 FROM att WHERE status = 'SENT' GROUP BY "notificationId", "subscriptionId" HAVING count(*) > 1) x)
  UNION ALL SELECT 20, NULL, (SELECT count(*) FROM "NotificationDelivery" d JOIN rem ON rem."id" = d."notificationId"
                               WHERE rem."businessId" <> 9 AND d."businessId" = rem."businessId" AND d."channel" = 'PUSH'
                                 AND d."subscriptionId" IS NULL AND d."expiresAt" IS NOT NULL)
  UNION ALL SELECT 21, NULL, (SELECT count(*) FROM "NotificationDelivery" d JOIN rem ON rem."id" = d."notificationId"
                               WHERE rem."businessId" <> 9 AND d."businessId" = rem."businessId" AND d."channel" = 'PUSH'
                                 AND d."subscriptionId" IS NULL AND d."expiresAt" IS NULL)
  UNION ALL SELECT 22, NULL, (SELECT count(*) FROM "PushSubscription" WHERE "provider" = 'FCM' AND "revokedAt" IS NULL AND "businessId" <> 9)
  UNION ALL SELECT 23, EXISTS (SELECT 1 FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'notifications_engine' AND "globalEnabled" = false AND "emergencyDisabled" = false), NULL
  UNION ALL SELECT 24, (SELECT bool_and("businessId" = 9) AND count(*) = 1 FROM "BusinessFeatureAccess"
                         WHERE "featureKey" = 'notifications_engine' AND "state"::text = 'ENABLED'), NULL
)
SELECT n, flag, observed_count FROM lines ORDER BY n;

ROLLBACK;
