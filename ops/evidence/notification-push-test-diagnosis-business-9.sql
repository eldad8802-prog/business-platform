-- ============================================================================
-- notification-push-test-diagnosis-business-9.sql
--
-- Read-only Production DIAGNOSIS of the owner's test push in business 9 (2026-11-21: the request reached the
-- server at 20:04:45Z and answered 200, the phone showed nothing). Stage by stage, counts and flags only:
--   A. 1-9   was a system.test notification recorded for business 9 from 20:00Z, for the business's only user, and
--            how its owed push row ended (SENT / FAILED / PENDING / SUPPRESSED, and why);
--   B. 10-24 the per-device attempts to the ANDROID (FCM) device(s): sent, or which class of Firebase answer
--            (the worker's sanitized `<kind>:<code>`, lib/notifications/push/fcm-client.ts classifyFcmError) —
--            counted per known code, never printed;
--   C. 25-27 the per-device attempts to BROWSER (web push) devices;
--   D. 30-46 business 9's FCM devices: live / revoked (and why), and whether the login session each live one is
--            bound to passes the worker's own conditions (public.auth_sessions_live: session not revoked, idle and
--            absolute expiry in the future, token version unchanged). A live FCM device whose session fails them is
--            SKIPPED by the worker (worker-decision.ts eligibleDevices): no attempt row at all;
--   E. 50    no live FCM device exists outside business 9.
--
-- OUTPUT (redaction-friendly): n | flag | observed_count + an \echo legend. Public logs: no token, endpoint,
-- key, id, name, e-mail, user agent or error text is selected — only counts and booleans.
-- PRIVACY: guard-clean (no write keyword anywhere, prose included).
-- ============================================================================

\echo '== test push diagnosis, business 9, from 2026-11-21 20:00Z: legend (n -> check) =='
\echo ' 1 the evidence role is a superuser or has BYPASSRLS (flag; expected t)'
\echo ' 2 system.test notifications of business 9 from 20:00Z (count; expected >= 1)'
\echo ' 3 of them, addressed to the only user of business 9 (count; expected = 2)'
\echo ' 4 their owed push rows (count; expected = 2)'
\echo ' 5 owed rows SENT (count)'
\echo ' 6 owed rows FAILED (count)'
\echo ' 7 owed rows still PENDING (count)'
\echo ' 8 owed rows SUPPRESSED (count)'
\echo ' 9 owed rows SUPPRESSED as no_device (no eligible device at all) (count)'
\echo '10 device attempts to an FCM (Android) device (count; 0 = the phone was never tried)'
\echo '11   of them SENT = Firebase answered 200 (count)'
\echo '12   of them FAILED (count)'
\echo '13   FAILED transient (retry class) (count)'
\echo '14   FAILED permanent (count)'
\echo '15   FAILED gone (token refused: UNREGISTERED / SENDER_ID_MISMATCH / 404) (count)'
\echo '16   code UNREGISTERED (count)'
\echo '17   code SENDER_ID_MISMATCH (count)'
\echo '18   code INVALID_ARGUMENT or 400 (count)'
\echo '19   code THIRD_PARTY_AUTH_ERROR / 401 / UNAUTHENTICATED (count)'
\echo '20   code PERMISSION_DENIED / 403 (count)'
\echo '21   OAuth (service account token exchange) failure (count)'
\echo '22   network or timeout (count)'
\echo '23   UNAVAILABLE / INTERNAL / QUOTA_EXCEEDED / 429 / 5xx (count)'
\echo '24   FAILED with a code none of 16-23 covers (count; > 0 = needs a follow-up)'
\echo '25 device attempts to a web push (browser) device (count)'
\echo '26   of them SENT (count)'
\echo '27   of them FAILED (count)'
\echo '30 FCM devices of business 9, revoked included (count)'
\echo '31 live FCM devices (not revoked) (count)'
\echo '32 FCM devices revoked as replaced (count)'
\echo '33 FCM devices revoked as gone (count)'
\echo '34 FCM devices revoked for another reason (count)'
\echo '35 FCM devices revoked from 20:00Z (count)'
\echo '36 live FCM devices of the only user of business 9 (count)'
\echo '37 live FCM devices with NO session bound (count; such a device is never pushed to)'
\echo '38 live FCM devices whose session passes the worker conditions (count; expected >= 1)'
\echo '39 live FCM devices whose session is revoked (count)'
\echo '40 live FCM devices whose session idle expiry has passed (count)'
\echo '41 live FCM devices whose session absolute expiry has passed (count)'
\echo '42 live FCM devices whose session token version is stale (count)'
\echo '43 live FCM devices with a success recorded from 20:00Z (count)'
\echo '44 live FCM devices with a failure recorded from 20:00Z (count)'
\echo '45 live FCM devices registered or re-registered from 18:00Z (count)'
\echo '46 live web push devices of business 9 (count)'
\echo '50 live FCM devices outside business 9 (count; expected 0)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

WITH
only_user AS (
  SELECT CASE WHEN count(*) = 1 THEN min(u."id") END AS uid FROM "User" u WHERE u."businessId" = 9
),
tn AS (
  SELECT n."id", n."userId" FROM "Notification" n
   WHERE n."businessId" = 9 AND n."semanticCategory" = 'system.test' AND n."createdAt" >= TIMESTAMP '2026-11-21 20:00:00'
),
owed AS (
  SELECT d."status"::text AS status, d."error" FROM "NotificationDelivery" d JOIN tn ON tn."id" = d."notificationId"
   WHERE d."businessId" = 9 AND d."channel" = 'PUSH' AND d."subscriptionId" IS NULL
),
att AS (
  SELECT d."status"::text AS status, coalesce(d."error", '') AS err, p."provider"
    FROM "NotificationDelivery" d JOIN tn ON tn."id" = d."notificationId"
    JOIN "PushSubscription" p ON p."id" = d."subscriptionId" AND p."businessId" = 9
   WHERE d."businessId" = 9 AND d."channel" = 'PUSH' AND d."subscriptionId" IS NOT NULL
),
fa AS (SELECT * FROM att WHERE "provider" = 'FCM' AND status = 'FAILED'),
nowts AS (SELECT (now() AT TIME ZONE 'UTC')::timestamp(3) AS ts),
fcm AS (
  SELECT p."revokedAt", p."revokedReason", p."userId", p."authSessionId", p."lastSuccessAt", p."lastFailureAt", p."updatedAt",
         s."id" AS sid, s."revokedAt" AS s_revoked, s."idleExpiresAt", s."absoluteExpiresAt", s."tokenVersionAtIssue", u."tokenVersion"
    FROM "PushSubscription" p
    LEFT JOIN "AuthSession" s ON s."id"::text = p."authSessionId"::text
    LEFT JOIN "User" u ON u."id" = s."userId"
   WHERE p."businessId" = 9 AND p."provider" = 'FCM'
),
lv AS (SELECT * FROM fcm WHERE "revokedAt" IS NULL),
lines(n, flag, observed_count) AS (
            SELECT 1, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user), NULL::bigint
  UNION ALL SELECT 2, NULL, (SELECT count(*) FROM tn)
  UNION ALL SELECT 3, NULL, (SELECT count(*) FROM tn WHERE tn."userId" = (SELECT uid FROM only_user))
  UNION ALL SELECT 4, NULL, (SELECT count(*) FROM owed)
  UNION ALL SELECT 5, NULL, (SELECT count(*) FROM owed WHERE status = 'SENT')
  UNION ALL SELECT 6, NULL, (SELECT count(*) FROM owed WHERE status = 'FAILED')
  UNION ALL SELECT 7, NULL, (SELECT count(*) FROM owed WHERE status = 'PENDING')
  UNION ALL SELECT 8, NULL, (SELECT count(*) FROM owed WHERE status = 'SUPPRESSED')
  UNION ALL SELECT 9, NULL, (SELECT count(*) FROM owed WHERE status = 'SUPPRESSED' AND "error" = 'no_device')
  UNION ALL SELECT 10, NULL, (SELECT count(*) FROM att WHERE "provider" = 'FCM')
  UNION ALL SELECT 11, NULL, (SELECT count(*) FROM att WHERE "provider" = 'FCM' AND status = 'SENT')
  UNION ALL SELECT 12, NULL, (SELECT count(*) FROM fa)
  UNION ALL SELECT 13, NULL, (SELECT count(*) FROM fa WHERE err LIKE 'transient:%')
  UNION ALL SELECT 14, NULL, (SELECT count(*) FROM fa WHERE err LIKE 'permanent:%')
  UNION ALL SELECT 15, NULL, (SELECT count(*) FROM fa WHERE err LIKE 'gone:%')
  UNION ALL SELECT 16, NULL, (SELECT count(*) FROM fa WHERE err LIKE '%UNREGISTERED%')
  UNION ALL SELECT 17, NULL, (SELECT count(*) FROM fa WHERE err LIKE '%SENDER_ID_MISMATCH%')
  UNION ALL SELECT 18, NULL, (SELECT count(*) FROM fa WHERE err LIKE '%INVALID_ARGUMENT%' OR err LIKE '%fcm_400')
  UNION ALL SELECT 19, NULL, (SELECT count(*) FROM fa WHERE err LIKE '%THIRD_PARTY_AUTH_ERROR%' OR err LIKE '%UNAUTHENTICATED%' OR err LIKE '%fcm_401')
  UNION ALL SELECT 20, NULL, (SELECT count(*) FROM fa WHERE err LIKE '%PERMISSION_DENIED%' OR err LIKE '%fcm_403')
  UNION ALL SELECT 21, NULL, (SELECT count(*) FROM fa WHERE err LIKE '%oauth_%' OR err LIKE '%fcm_key_invalid%')
  UNION ALL SELECT 22, NULL, (SELECT count(*) FROM fa WHERE err LIKE '%fcm_network' OR err LIKE '%fcm_timeout' OR err LIKE '%sender_error')
  UNION ALL SELECT 23, NULL, (SELECT count(*) FROM fa WHERE err LIKE '%UNAVAILABLE%' OR err LIKE '%INTERNAL%' OR err LIKE '%QUOTA_EXCEEDED%'
                                OR err LIKE '%fcm_429' OR err LIKE '%fcm_5__')
  UNION ALL SELECT 24, NULL, (SELECT count(*) FROM fa WHERE NOT (
                                err LIKE '%UNREGISTERED%' OR err LIKE '%SENDER_ID_MISMATCH%' OR err LIKE '%INVALID_ARGUMENT%' OR err LIKE '%fcm_400'
                                OR err LIKE '%THIRD_PARTY_AUTH_ERROR%' OR err LIKE '%UNAUTHENTICATED%' OR err LIKE '%fcm_401'
                                OR err LIKE '%PERMISSION_DENIED%' OR err LIKE '%fcm_403' OR err LIKE '%oauth_%' OR err LIKE '%fcm_key_invalid%'
                                OR err LIKE '%fcm_network' OR err LIKE '%fcm_timeout' OR err LIKE '%sender_error'
                                OR err LIKE '%UNAVAILABLE%' OR err LIKE '%INTERNAL%' OR err LIKE '%QUOTA_EXCEEDED%' OR err LIKE '%fcm_429' OR err LIKE '%fcm_5__'))
  UNION ALL SELECT 25, NULL, (SELECT count(*) FROM att WHERE "provider" = 'WEB_PUSH')
  UNION ALL SELECT 26, NULL, (SELECT count(*) FROM att WHERE "provider" = 'WEB_PUSH' AND status = 'SENT')
  UNION ALL SELECT 27, NULL, (SELECT count(*) FROM att WHERE "provider" = 'WEB_PUSH' AND status = 'FAILED')
  UNION ALL SELECT 30, NULL, (SELECT count(*) FROM fcm)
  UNION ALL SELECT 31, NULL, (SELECT count(*) FROM lv)
  UNION ALL SELECT 32, NULL, (SELECT count(*) FROM fcm WHERE "revokedAt" IS NOT NULL AND "revokedReason" = 'replaced')
  UNION ALL SELECT 33, NULL, (SELECT count(*) FROM fcm WHERE "revokedAt" IS NOT NULL AND "revokedReason" = 'gone')
  UNION ALL SELECT 34, NULL, (SELECT count(*) FROM fcm WHERE "revokedAt" IS NOT NULL AND ("revokedReason" IS NULL OR "revokedReason" NOT IN ('replaced', 'gone')))
  UNION ALL SELECT 35, NULL, (SELECT count(*) FROM fcm WHERE "revokedAt" >= TIMESTAMP '2026-11-21 20:00:00')
  UNION ALL SELECT 36, NULL, (SELECT count(*) FROM lv WHERE "userId" = (SELECT uid FROM only_user))
  UNION ALL SELECT 37, NULL, (SELECT count(*) FROM lv WHERE "authSessionId" IS NULL OR sid IS NULL)
  UNION ALL SELECT 38, NULL, (SELECT count(*) FROM lv WHERE sid IS NOT NULL AND s_revoked IS NULL AND "idleExpiresAt" > (SELECT ts FROM nowts)
                                AND "absoluteExpiresAt" > (SELECT ts FROM nowts) AND "tokenVersionAtIssue" = "tokenVersion")
  UNION ALL SELECT 39, NULL, (SELECT count(*) FROM lv WHERE sid IS NOT NULL AND s_revoked IS NOT NULL)
  UNION ALL SELECT 40, NULL, (SELECT count(*) FROM lv WHERE sid IS NOT NULL AND "idleExpiresAt" <= (SELECT ts FROM nowts))
  UNION ALL SELECT 41, NULL, (SELECT count(*) FROM lv WHERE sid IS NOT NULL AND "absoluteExpiresAt" <= (SELECT ts FROM nowts))
  UNION ALL SELECT 42, NULL, (SELECT count(*) FROM lv WHERE sid IS NOT NULL AND "tokenVersionAtIssue" IS DISTINCT FROM "tokenVersion")
  UNION ALL SELECT 43, NULL, (SELECT count(*) FROM lv WHERE "lastSuccessAt" >= TIMESTAMP '2026-11-21 20:00:00')
  UNION ALL SELECT 44, NULL, (SELECT count(*) FROM lv WHERE "lastFailureAt" >= TIMESTAMP '2026-11-21 20:00:00')
  UNION ALL SELECT 45, NULL, (SELECT count(*) FROM lv WHERE "updatedAt" >= TIMESTAMP '2026-11-21 18:00:00')
  UNION ALL SELECT 46, NULL, (SELECT count(*) FROM "PushSubscription" WHERE "businessId" = 9 AND "provider" = 'WEB_PUSH' AND "revokedAt" IS NULL)
  UNION ALL SELECT 50, NULL, (SELECT count(*) FROM "PushSubscription" WHERE "provider" = 'FCM' AND "revokedAt" IS NULL AND "businessId" <> 9)
)
SELECT n, flag, observed_count FROM lines ORDER BY n;

ROLLBACK;
