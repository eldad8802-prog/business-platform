-- ============================================================================================================
-- Notification engine foundation (notifications track, PR 2 — migration only; owner approval 2026-11-12).
--
-- Expand-only. Every existing row stays valid and every statement the current application issues keeps working:
-- new columns are nullable or defaulted, one CHECK is replaced by a strictly wider one, nothing is dropped,
-- renamed or narrowed. The application that uses these objects comes in a later PR (migration-first rule).
--
--   1. PushSubscription: a provider (WEB_PUSH today, FCM for the Android app), the FCM token kept in "endpoint"
--      as `fcm:<token>` (so the existing (businessId, endpoint) uniqueness and the in-place erasure `erased:<id>`
--      keep working unchanged), the device's login session ("authSessionId" — logout ends the device's push),
--      a revoke reason, last-seen and app version. (id, businessId) unique, for a composite FK.
--   2. Notification."userId": NULL = the whole business (every row today), set = one user only (a digest, a
--      reminder for its assignee). Same-business trigger.
--   3. NotificationDelivery: the worker's columns (recipient, device, attempts, next attempt, lease, expiry,
--      completion) and the two indexes it reads by. Device attachment is a COMPOSITE FK, so a delivery can never
--      name another business's device.
--   4. NotificationSettings (one per user, every column NULL = the product default) and NotificationPreference
--      (one override per user per domain / category). Tenant RLS: ENABLE + FORCE, one policy per command, explicit
--      grants, same-business trigger on userId.
--   5. Definer functions for the worker (identifiers only): notification_push_due(), notification_live_businesses(),
--      auth_sessions_live(). EXECUTE for app_runtime alone; search_path pinned.
-- ============================================================================================================

-- ── 1. PushSubscription ──────────────────────────────────────────────────────────────────────────────────────

ALTER TABLE "PushSubscription"
  ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'WEB_PUSH',
  ADD COLUMN "authSessionId" UUID,
  ADD COLUMN "revokedReason" TEXT,
  ADD COLUMN "lastSeenAt" TIMESTAMP(3),
  ADD COLUMN "appVersion" VARCHAR(32);

ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_provider"
  CHECK ("provider" IN ('WEB_PUSH', 'FCM'));
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_revoked_reason_shape"
  CHECK ("revokedReason" IS NULL OR "revokedReason" ~ '^[a-z_]{1,32}$');
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_app_version_shape"
  CHECK ("appVersion" IS NULL OR "appVersion" ~ '^[0-9A-Za-z.+_-]{1,32}$');

-- Strictly wider than before: every endpoint the old CHECK accepted (a web push URL, or the erasure marker) is still
-- accepted for provider WEB_PUSH (the default every existing row receives); an FCM token is accepted only as
-- `fcm:<token>` on an FCM row. A web push URL can never be stored as FCM, nor an FCM token as WEB_PUSH.
-- The token's length (20..4096) is bounded by char_length, not by a regex bound: PostgreSQL's regex engine refuses
-- any repetition count above 255 ("invalid repetition count(s)").
ALTER TABLE "PushSubscription" DROP CONSTRAINT "PushSubscription_endpoint_shape";
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_endpoint_shape" CHECK (
     ("provider" = 'WEB_PUSH' AND "endpoint" ~ '^https://[^[:space:]]+$' AND char_length("endpoint") <= 1024)
  OR ("provider" = 'FCM' AND "endpoint" ~ '^fcm:[A-Za-z0-9_:.-]+$' AND char_length("endpoint") BETWEEN 24 AND 4100)
  OR "endpoint" ~ '^erased:[0-9]+$');

ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_id_businessId_key" UNIQUE ("id", "businessId");

-- The device's login session. SET NULL when the session row is deleted: the worker treats a device with no live
-- session as unreachable (auth_sessions_live below), so a deleted session can never be pushed to.
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_authSessionId_fkey"
  FOREIGN KEY ("authSessionId") REFERENCES "AuthSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "PushSubscription_authSessionId_live_idx" ON "PushSubscription"("authSessionId")
  WHERE "revokedAt" IS NULL AND "authSessionId" IS NOT NULL;

-- ── 2. Notification."userId" ─────────────────────────────────────────────────────────────────────────────────

ALTER TABLE "Notification" ADD COLUMN "userId" INTEGER;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Notification_businessId_userId_lastSurfacedAt_idx" ON "Notification"("businessId", "userId", "lastSurfacedAt");
CREATE TRIGGER "Notification_user_same_business"
  BEFORE INSERT OR UPDATE OF "businessId", "userId" ON "Notification"
  FOR EACH ROW EXECUTE FUNCTION public.task_user_same_business('userId');

-- ── 3. NotificationDelivery: the worker's columns ────────────────────────────────────────────────────────────

ALTER TABLE "NotificationDelivery"
  ADD COLUMN "userId" INTEGER,
  ADD COLUMN "subscriptionId" INTEGER,
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "leaseUntil" TIMESTAMP(3),
  ADD COLUMN "expiresAt" TIMESTAMP(3),
  ADD COLUMN "completedAt" TIMESTAMP(3);

ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_attempts_range"
  CHECK ("attempts" BETWEEN 0 AND 50);
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- COMPOSITE, like the notification FK: a delivery can never attach to another business's device.
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_subscription_fkey"
  FOREIGN KEY ("subscriptionId", "businessId") REFERENCES "PushSubscription"("id", "businessId")
  ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TRIGGER "NotificationDelivery_user_same_business"
  BEFORE INSERT OR UPDATE OF "businessId", "userId" ON "NotificationDelivery"
  FOR EACH ROW EXECUTE FUNCTION public.task_user_same_business('userId');

-- What the worker scans (owed pushes), and what the per-user rate limit counts (pushes actually sent).
CREATE INDEX "NotificationDelivery_push_owed_idx" ON "NotificationDelivery"("nextAttemptAt", "id")
  WHERE "status" = 'PENDING' AND "channel" = 'PUSH';
CREATE INDEX "NotificationDelivery_push_sent_by_user_idx" ON "NotificationDelivery"("businessId", "userId", "attemptedAt")
  WHERE "status" = 'SENT' AND "channel" = 'PUSH';

-- ── 4. Per-user settings and overrides ───────────────────────────────────────────────────────────────────────

-- Every column NULL = the product default (lib/notifications/defaults). A row only records what the user changed,
-- so a better default later reaches everyone who did not choose otherwise. "Restore defaults" deletes the row.
CREATE TABLE "NotificationSettings" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "userId" INTEGER NOT NULL,
  "pushEnabled" BOOLEAN,
  "quietHoursEnabled" BOOLEAN,
  "quietStartMinute" SMALLINT,
  "quietEndMinute" SMALLINT,
  "digestEnabled" BOOLEAN,
  "digestMinute" SMALLINT,
  "lockScreenDetails" BOOLEAN,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NotificationSettings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NotificationSettings_minutes" CHECK (
        ("quietStartMinute" IS NULL OR "quietStartMinute" BETWEEN 0 AND 1439)
    AND ("quietEndMinute" IS NULL OR "quietEndMinute" BETWEEN 0 AND 1439)
    AND ("digestMinute" IS NULL OR "digestMinute" BETWEEN 0 AND 1439))
);
CREATE UNIQUE INDEX "NotificationSettings_businessId_userId_key" ON "NotificationSettings"("businessId", "userId");
ALTER TABLE "NotificationSettings" ADD CONSTRAINT "NotificationSettings_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationSettings" ADD CONSTRAINT "NotificationSettings_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TRIGGER "NotificationSettings_user_same_business"
  BEFORE INSERT OR UPDATE OF "businessId", "userId" ON "NotificationSettings"
  FOR EACH ROW EXECUTE FUNCTION public.task_user_same_business('userId');

-- One override per user per domain ("domain:inventory") or category ("category:inventory.critical_stock").
-- NULL in a column = no override for that aspect.
CREATE TABLE "NotificationPreference" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "userId" INTEGER NOT NULL,
  "key" VARCHAR(80) NOT NULL,
  "inApp" BOOLEAN,
  "push" BOOLEAN,
  "delivery" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NotificationPreference_key_shape" CHECK ("key" ~ '^(domain|category):[a-z0-9_.]{1,64}$'),
  CONSTRAINT "NotificationPreference_delivery" CHECK ("delivery" IS NULL OR "delivery" IN ('instant', 'digest'))
);
CREATE UNIQUE INDEX "NotificationPreference_businessId_userId_key_key" ON "NotificationPreference"("businessId", "userId", "key");
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TRIGGER "NotificationPreference_user_same_business"
  BEFORE INSERT OR UPDATE OF "businessId", "userId" ON "NotificationPreference"
  FOR EACH ROW EXECUTE FUNCTION public.task_user_same_business('userId');

-- RLS: ENABLE + FORCE, one policy per command, keyed on the tenant GUC (rules R1/R2).
ALTER TABLE "NotificationSettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NotificationSettings" FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_settings_tenant_select ON "NotificationSettings" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY notification_settings_tenant_insert ON "NotificationSettings" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY notification_settings_tenant_update ON "NotificationSettings" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY notification_settings_tenant_delete ON "NotificationSettings" FOR DELETE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "NotificationPreference" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NotificationPreference" FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_preference_tenant_select ON "NotificationPreference" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY notification_preference_tenant_insert ON "NotificationPreference" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY notification_preference_tenant_update ON "NotificationPreference" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY notification_preference_tenant_delete ON "NotificationPreference" FOR DELETE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- The owner's DEFAULT PRIVILEGES hand new tables to the runtime wholesale: start from nothing, then grant exactly
-- read / add / change / remove (remove = "restore defaults").
REVOKE ALL ON "NotificationSettings" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "NotificationSettings_id_seq" FROM PUBLIC;
REVOKE ALL ON "NotificationPreference" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "NotificationPreference_id_seq" FROM PUBLIC;
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    REVOKE ALL ON "NotificationSettings" FROM app_runtime;
    REVOKE ALL ON SEQUENCE "NotificationSettings_id_seq" FROM app_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "NotificationSettings" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "NotificationSettings_id_seq" TO app_runtime;
    REVOKE ALL ON "NotificationPreference" FROM app_runtime;
    REVOKE ALL ON SEQUENCE "NotificationPreference_id_seq" FROM app_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "NotificationPreference" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "NotificationPreference_id_seq" TO app_runtime;
  END IF;
END
$do$;

-- ── 5. Definer functions for the worker: identifiers only ────────────────────────────────────────────────────

-- Owed pushes that may be attempted now (due, not leased) in live businesses. Identifiers only: the worker then
-- reads, claims and sends each one inside its own business's tenant transaction.
CREATE OR REPLACE FUNCTION public.notification_push_due(p_now timestamp(3), p_limit integer)
RETURNS TABLE ("businessId" integer, "deliveryId" integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT d."businessId", d."id"
    FROM "NotificationDelivery" d
    JOIN "Business" b ON b."id" = d."businessId"
   WHERE d."status" = 'PENDING'
     AND d."channel" = 'PUSH'
     AND (d."nextAttemptAt" IS NULL OR d."nextAttemptAt" <= p_now)
     AND (d."leaseUntil" IS NULL OR d."leaseUntil" < p_now)
     AND b."deletionRequestedAt" IS NULL
     AND b."deletedAt" IS NULL
   ORDER BY d."nextAttemptAt" NULLS FIRST, d."id"
   LIMIT LEAST(GREATEST(coalesce(p_limit, 100), 1), 500)
$fn$;

-- Live businesses after a keyset cursor (the daily digest walks them in pages). Identifiers only.
CREATE OR REPLACE FUNCTION public.notification_live_businesses(p_after integer, p_limit integer)
RETURNS TABLE ("businessId" integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT b."id"
    FROM "Business" b
   WHERE b."id" > coalesce(p_after, 0)
     AND b."deletionRequestedAt" IS NULL
     AND b."deletedAt" IS NULL
   ORDER BY b."id"
   LIMIT LEAST(GREATEST(coalesce(p_limit, 200), 1), 1000)
$fn$;

-- Of the given session ids, the ones still live: not revoked, inside idle and absolute expiry, issued at the user's
-- current token version (a "log out of every device" bumps it). Returns only ids the caller already holds.
CREATE OR REPLACE FUNCTION public.auth_sessions_live(p_ids uuid[], p_now timestamp(3))
RETURNS TABLE ("id" uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT s."id"
    FROM "AuthSession" s
    JOIN "User" u ON u."id" = s."userId"
   WHERE s."id" = ANY (coalesce(p_ids, ARRAY[]::uuid[]))
     AND s."revokedAt" IS NULL
     AND s."idleExpiresAt" > p_now
     AND s."absoluteExpiresAt" > p_now
     AND s."tokenVersionAtIssue" = u."tokenVersion"
   LIMIT 200
$fn$;

REVOKE ALL ON FUNCTION public.notification_push_due(timestamp(3), integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.notification_live_businesses(integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_sessions_live(uuid[], timestamp(3)) FROM PUBLIC;
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    REVOKE ALL ON FUNCTION public.notification_push_due(timestamp(3), integer) FROM app_runtime;
    GRANT EXECUTE ON FUNCTION public.notification_push_due(timestamp(3), integer) TO app_runtime;
    REVOKE ALL ON FUNCTION public.notification_live_businesses(integer, integer) FROM app_runtime;
    GRANT EXECUTE ON FUNCTION public.notification_live_businesses(integer, integer) TO app_runtime;
    REVOKE ALL ON FUNCTION public.auth_sessions_live(uuid[], timestamp(3)) FROM app_runtime;
    GRANT EXECUTE ON FUNCTION public.auth_sessions_live(uuid[], timestamp(3)) TO app_runtime;
  END IF;
END
$do$;
