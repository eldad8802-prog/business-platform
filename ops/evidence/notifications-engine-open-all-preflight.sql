-- ============================================================================
-- notifications-engine-open-all-preflight.sql
--
-- Read-only Production preflight BEFORE the notification engine is opened for every business
-- (release-migrate of 20261223090000_notifications_engine_open_all, then the application PR that flips the catalog
-- default and schedules the worker / status sweep / digest). Flags and counts only:
--   A.  1-9   the ledger: the migration is not recorded yet, nothing unfinished, and every migration on main before it
--             is already applied (release-migrate applies a prefix only: anything pending before it would have to
--             ship with it);
--   B. 10-15  the engine's rows: one definition and one policy row, both still OFF, emergency OFF, overrides
--             (business 9 = the pilot; a DISABLED business stays closed after the opening, by design);
--   C. 16-18  who the opening reaches: live businesses, their users;
--   D. 19-26  devices: Android (FCM) and browser (web push) devices, live or not, and how many are bound to a live
--             session (only those receive engine pushes; browser rows with no session stop receiving once the
--             application PR ships, until their own user opens the app again);
--   E. 27-31  what the opening would start sending: owed engine pushes already waiting (closed pre_cutover, never
--             sent), recent volume of push-eligible events and task reminders, saved preferences, activation records.
--
-- PRIVACY: guard-clean (no write keyword anywhere, prose included). No names, no ids except the pilot business.
-- ============================================================================

\echo '== notifications engine open-all preflight: legend (n -> check) =='
\echo ' 1 the evidence role is a superuser or has BYPASSRLS (flag; expected t)'
\echo ' 2 20261223090000_notifications_engine_open_all is not recorded yet (flag; expected t)'
\echo ' 3 ledger rows unfinished or rolled back (count; expected 0)'
\echo ' 4 20261212090000_notification_engine_activation applied (flag; expected t)'
\echo ' 5 20261213090000_notification_docs_stuck_appointment_lead applied (flag; expected t)'
\echo ' 6 20261214090000_service_desk_case_fields applied (flag; expected t)'
\echo ' 7 20261216090000_activity_packs applied (flag; expected t, else it is pending before ours)'
\echo ' 8 20261221090000_business_kind_transition applied (flag; expected t)'
\echo ' 9 ledger rows in total (count; info)'
\echo '10 notifications_engine: one definition row and one policy row (flag; expected t)'
\echo '11 notifications_engine: definition default OFF and policy global OFF (flag; expected t, the state the migration expects)'
\echo '12 notifications_engine: the emergency switch is set (flag; expected f)'
\echo '13 notifications_engine overrides ENABLED (count; expected 1, business 9)'
\echo '14 notifications_engine overrides DISABLED (count; expected 0; any such business stays closed)'
\echo '15 business 9: notifications_engine override is ENABLED (flag; expected t)'
\echo '16 live businesses (not deleted, no deletion requested) (count; every one without a DISABLED override is reached)'
\echo '17 users in live businesses (count)'
\echo '18 users in live businesses other than business 9 (count; newly reached)'
\echo '19 Android (FCM) devices not revoked (count)'
\echo '20   of them bound to a live session (count; these receive engine pushes)'
\echo '21   of them outside business 9 (count)'
\echo '22 browser (web push) subscriptions not revoked (count)'
\echo '23   of them bound to a live session (count; these receive engine pushes)'
\echo '24   of them with NO session (count; stop receiving until their user opens the app again)'
\echo '25 users with at least one device that would receive an engine push (count)'
\echo '26 live businesses with at least one such user (count)'
\echo '27 owed engine pushes still PENDING outside business 9 (count; closed pre_cutover or expired, never sent)'
\echo '28 owed engine pushes written in the last 7 days outside business 9 (count; the push volume the opening starts)'
\echo '29 task reminders surfaced in the last 7 days, all businesses (count; info)'
\echo '30 saved notification preferences (count; kept as they are)'
\echo '31 engine activation records (count; expected 1, business 9)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

WITH
nowts AS (SELECT (now() AT TIME ZONE 'UTC')::timestamp(3) AS ts),
mig AS (SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),
d AS (SELECT "defaultEnabled" AS on_ FROM "PlatformFeatureDefinition" WHERE "key" = 'notifications_engine'),
p AS (SELECT "globalEnabled" AS g, "emergencyDisabled" AS e FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'notifications_engine'),
live_b AS (SELECT b."id" FROM "Business" b WHERE b."deletedAt" IS NULL AND b."deletionRequestedAt" IS NULL),
live_u AS (SELECT u."id", u."businessId" FROM "User" u JOIN live_b ON live_b."id" = u."businessId"),
live_s AS (
  SELECT s."id" FROM "AuthSession" s JOIN "User" u ON u."id" = s."userId", nowts
   WHERE s."revokedAt" IS NULL AND s."idleExpiresAt" > nowts.ts AND s."absoluteExpiresAt" > nowts.ts
     AND s."tokenVersionAtIssue" = u."tokenVersion"
),
dev AS (
  SELECT ps."businessId", ps."userId", ps."provider", (ps."authSessionId" IS NOT NULL) AS bound,
         (ps."authSessionId" IS NOT NULL AND EXISTS (SELECT 1 FROM live_s WHERE live_s."id" = ps."authSessionId")) AS live
    FROM "PushSubscription" ps JOIN live_b ON live_b."id" = ps."businessId"
   WHERE ps."revokedAt" IS NULL AND ps."endpoint" NOT LIKE 'erased:%'
),
reach AS (SELECT DISTINCT "businessId", "userId" FROM dev WHERE live),
lines(n, flag, observed_count) AS (
            SELECT 1, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user), NULL::bigint
  UNION ALL SELECT 2, NOT EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261223090000_notifications_engine_open_all'), NULL
  UNION ALL SELECT 3, NULL, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 4, EXISTS (SELECT 1 FROM mig WHERE migration_name = '20261212090000_notification_engine_activation'), NULL
  UNION ALL SELECT 5, EXISTS (SELECT 1 FROM mig WHERE migration_name = '20261213090000_notification_docs_stuck_appointment_lead'), NULL
  UNION ALL SELECT 6, EXISTS (SELECT 1 FROM mig WHERE migration_name = '20261214090000_service_desk_case_fields'), NULL
  UNION ALL SELECT 7, EXISTS (SELECT 1 FROM mig WHERE migration_name = '20261216090000_activity_packs'), NULL
  UNION ALL SELECT 8, EXISTS (SELECT 1 FROM mig WHERE migration_name = '20261221090000_business_kind_transition'), NULL
  UNION ALL SELECT 9, NULL, (SELECT count(*) FROM "_prisma_migrations")
  UNION ALL SELECT 10, (SELECT count(*) FROM d) = 1 AND (SELECT count(*) FROM p) = 1, NULL
  UNION ALL SELECT 11, EXISTS (SELECT 1 FROM d WHERE NOT on_) AND EXISTS (SELECT 1 FROM p WHERE NOT g), NULL
  UNION ALL SELECT 12, COALESCE((SELECT bool_or(e) FROM p), false), NULL
  UNION ALL SELECT 13, NULL, (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'notifications_engine' AND "state"::text = 'ENABLED')
  UNION ALL SELECT 14, NULL, (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'notifications_engine' AND "state"::text = 'DISABLED')
  UNION ALL SELECT 15, EXISTS (SELECT 1 FROM "BusinessFeatureAccess" WHERE "businessId" = 9 AND "featureKey" = 'notifications_engine' AND "state"::text = 'ENABLED'), NULL
  UNION ALL SELECT 16, NULL, (SELECT count(*) FROM live_b)
  UNION ALL SELECT 17, NULL, (SELECT count(*) FROM live_u)
  UNION ALL SELECT 18, NULL, (SELECT count(*) FROM live_u WHERE "businessId" <> 9)
  UNION ALL SELECT 19, NULL, (SELECT count(*) FROM dev WHERE "provider" = 'FCM')
  UNION ALL SELECT 20, NULL, (SELECT count(*) FROM dev WHERE "provider" = 'FCM' AND live)
  UNION ALL SELECT 21, NULL, (SELECT count(*) FROM dev WHERE "provider" = 'FCM' AND "businessId" <> 9)
  UNION ALL SELECT 22, NULL, (SELECT count(*) FROM dev WHERE "provider" = 'WEB_PUSH')
  UNION ALL SELECT 23, NULL, (SELECT count(*) FROM dev WHERE "provider" = 'WEB_PUSH' AND live)
  UNION ALL SELECT 24, NULL, (SELECT count(*) FROM dev WHERE "provider" = 'WEB_PUSH' AND NOT bound)
  UNION ALL SELECT 25, NULL, (SELECT count(*) FROM reach)
  UNION ALL SELECT 26, NULL, (SELECT count(DISTINCT "businessId") FROM reach)
  UNION ALL SELECT 27, NULL, (SELECT count(*) FROM "NotificationDelivery" dl WHERE dl."businessId" <> 9 AND dl."channel" = 'PUSH'
                                AND dl."status"::text = 'PENDING' AND dl."subscriptionId" IS NULL AND dl."expiresAt" IS NOT NULL)
  UNION ALL SELECT 28, NULL, (SELECT count(*) FROM "NotificationDelivery" dl, nowts WHERE dl."businessId" <> 9 AND dl."channel" = 'PUSH'
                                AND dl."subscriptionId" IS NULL AND dl."expiresAt" IS NOT NULL AND dl."createdAt" >= nowts.ts - INTERVAL '7 days')
  UNION ALL SELECT 29, NULL, (SELECT count(*) FROM "Notification" nt, nowts WHERE nt."domain" = 'tasks' AND nt."semanticCategory" = 'task_reminder'
                                AND nt."lastSurfacedAt" >= nowts.ts - INTERVAL '7 days')
  UNION ALL SELECT 30, NULL, (SELECT count(*) FROM "NotificationPreference")
  UNION ALL SELECT 31, NULL, (SELECT count(*) FROM "NotificationEngineActivation")
)
SELECT n, flag, observed_count FROM lines ORDER BY n;

ROLLBACK;
