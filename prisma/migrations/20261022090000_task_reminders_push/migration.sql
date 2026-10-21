-- ============================================================================================================
-- 20261022090000_task_reminders_push — personal task reminders: time of day, reminder offset, the server-side
-- dispatch claim, and Web Push subscriptions. Owner-approved plan (2026-10-21).
--
-- 1. "Task" / "TaskSeries": dueMinute (time of day, minutes after midnight, Asia/Jerusalem) and
--    remindOffsetMinutes (how long before the due moment to remind; 0 = at the moment). "Task".remindAt (already
--    there since 20261018090000) stays the single computed truth of WHEN to remind; "Task".reminderSentAt is the
--    atomic claim that a reminder for the current remindAt was dispatched (a snooze resets it). Shape checks keep
--    a time without a day, or a reminder without a time, impossible. A partial index serves the dispatcher.
-- 2. "PushSubscription": one row per browser / installed web app that accepted push for a user of a business.
--    Tenant table: RLS ENABLED + FORCED, per-command tenant policies (no DELETE — revocation is revokedAt and
--    account erasure blanks the row in place), the user must belong to the same business (trigger), and only
--    SELECT / INSERT / UPDATE for the runtime.
-- 3. task_reminders_due(now, limit): SECURITY DEFINER, pinned search_path, owned by the migration role,
--    EXECUTE for app_runtime alone. The dispatcher runs without a session; this returns ONLY identifiers and the
--    due moment (businessId, taskId, remindAt) of due, unclaimed reminders of live businesses — never a title, a
--    note or a user. The dispatcher then reads and claims each task inside that business's tenant context.
--
-- Additive only: no existing row, column, policy or grant is changed or removed.
-- ============================================================================================================

-- ── 1. Time of day and reminder ────────────────────────────────────────────────────────────────────────────

ALTER TABLE "Task"
  ADD COLUMN "dueMinute" SMALLINT,
  ADD COLUMN "remindOffsetMinutes" SMALLINT,
  ADD COLUMN "reminderSentAt" TIMESTAMP(3);
ALTER TABLE "Task" ADD CONSTRAINT "Task_dueMinute_range"
  CHECK ("dueMinute" IS NULL OR "dueMinute" BETWEEN 0 AND 1439);
ALTER TABLE "Task" ADD CONSTRAINT "Task_remindOffset_range"
  CHECK ("remindOffsetMinutes" IS NULL OR "remindOffsetMinutes" BETWEEN 0 AND 10080);
-- A time needs a day; a reminder needs a time.
ALTER TABLE "Task" ADD CONSTRAINT "Task_schedule_shape"
  CHECK (("dueMinute" IS NULL OR "dueOn" IS NOT NULL)
     AND ("remindOffsetMinutes" IS NULL OR "dueMinute" IS NOT NULL));

ALTER TABLE "TaskSeries"
  ADD COLUMN "dueMinute" SMALLINT,
  ADD COLUMN "remindOffsetMinutes" SMALLINT;
ALTER TABLE "TaskSeries" ADD CONSTRAINT "TaskSeries_dueMinute_range"
  CHECK ("dueMinute" IS NULL OR "dueMinute" BETWEEN 0 AND 1439);
ALTER TABLE "TaskSeries" ADD CONSTRAINT "TaskSeries_remindOffset_range"
  CHECK ("remindOffsetMinutes" IS NULL OR "remindOffsetMinutes" BETWEEN 0 AND 10080);
ALTER TABLE "TaskSeries" ADD CONSTRAINT "TaskSeries_schedule_shape"
  CHECK ("remindOffsetMinutes" IS NULL OR "dueMinute" IS NOT NULL);

CREATE INDEX "Task_reminder_due_idx" ON "Task"("remindAt")
  WHERE "status" = 'OPEN' AND "remindAt" IS NOT NULL AND "reminderSentAt" IS NULL;

-- ── 2. Web Push subscriptions ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE "PushSubscription" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "userId" INTEGER NOT NULL,
  "endpoint" TEXT NOT NULL,
  "p256dh" TEXT NOT NULL,
  "auth" TEXT NOT NULL,
  "platform" TEXT NOT NULL,
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  "lastSuccessAt" TIMESTAMP(3),
  "lastFailureAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id"),
  -- A push service URL, or the in-place erasure marker. Keys are base64url; erasure blanks them.
  CONSTRAINT "PushSubscription_endpoint_shape" CHECK (
       ("endpoint" ~ '^https://[^[:space:]]+$' AND char_length("endpoint") <= 1024)
    OR "endpoint" ~ '^erased:[0-9]+$'),
  CONSTRAINT "PushSubscription_keys_shape" CHECK (
        "p256dh" ~ '^[A-Za-z0-9_-]{0,200}$'
    AND "auth" ~ '^[A-Za-z0-9_-]{0,64}$'),
  CONSTRAINT "PushSubscription_platform" CHECK ("platform" IN ('android', 'ios', 'desktop', 'other')),
  CONSTRAINT "PushSubscription_failures" CHECK ("failureCount" >= 0)
);
CREATE UNIQUE INDEX "PushSubscription_businessId_endpoint_key" ON "PushSubscription"("businessId", "endpoint");
CREATE INDEX "PushSubscription_businessId_userId_live_idx" ON "PushSubscription"("businessId", "userId")
  WHERE "revokedAt" IS NULL;
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The user must belong to the same business (the guard 20261018090000 built for task user references).
CREATE TRIGGER "PushSubscription_user_same_business"
  BEFORE INSERT OR UPDATE OF "businessId", "userId" ON "PushSubscription"
  FOR EACH ROW EXECUTE FUNCTION public.task_user_same_business('userId');

ALTER TABLE "PushSubscription" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PushSubscription" FORCE ROW LEVEL SECURITY;
CREATE POLICY push_subscription_tenant_select ON "PushSubscription" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY push_subscription_tenant_insert ON "PushSubscription" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY push_subscription_tenant_update ON "PushSubscription" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- The owner's DEFAULT PRIVILEGES hand new tables to the runtime wholesale (the G4 finding of 20261018090000):
-- start from nothing, then grant exactly read / add / change.
REVOKE ALL ON "PushSubscription" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "PushSubscription_id_seq" FROM PUBLIC;
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    REVOKE ALL ON "PushSubscription" FROM app_runtime;
    REVOKE ALL ON SEQUENCE "PushSubscription_id_seq" FROM app_runtime;
    GRANT SELECT, INSERT, UPDATE ON "PushSubscription" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "PushSubscription_id_seq" TO app_runtime;
  END IF;
END
$do$;

-- ── 3. Due reminders, identifiers only ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.task_reminders_due(p_now timestamp(3), p_limit integer)
RETURNS TABLE ("businessId" integer, "taskId" integer, "remindAt" timestamp(3))
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT t."businessId", t."id", t."remindAt"
    FROM "Task" t
    JOIN "Business" b ON b."id" = t."businessId"
   WHERE t."status" = 'OPEN'
     AND t."remindAt" IS NOT NULL
     AND t."remindAt" <= p_now
     AND t."reminderSentAt" IS NULL
     AND t."erasedAt" IS NULL
     AND b."deletionRequestedAt" IS NULL
     AND b."deletedAt" IS NULL
   ORDER BY t."remindAt", t."id"
   LIMIT LEAST(GREATEST(coalesce(p_limit, 100), 1), 500)
$fn$;
REVOKE ALL ON FUNCTION public.task_reminders_due(timestamp(3), integer) FROM PUBLIC;
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    REVOKE ALL ON FUNCTION public.task_reminders_due(timestamp(3), integer) FROM app_runtime;
    GRANT EXECUTE ON FUNCTION public.task_reminders_due(timestamp(3), integer) TO app_runtime;
  END IF;
END
$do$;
