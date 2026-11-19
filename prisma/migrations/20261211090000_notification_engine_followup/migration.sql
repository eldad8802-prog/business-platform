-- ============================================================================================================
-- Notification engine follow-up (notifications track, PR 2b — migration only; owner decisions 2026-11-13).
--
-- DEPENDS ON 20261210090000_notification_engine_foundation (PR #1143): it indexes that migration's columns
-- ("NotificationDelivery"."nextAttemptAt" / "subscriptionId", "Notification"."userId"). Its timestamp sorts after
-- it, so `prisma migrate deploy` applies the two in order; it must never be applied without it.
--
-- Expand-only. Nothing is dropped, renamed or narrowed; no existing row changes; every statement the current
-- application issues keeps working. The application that uses these objects comes in later PRs (migration-first).
--
--   1. task_reminders_due_excluding(now, limit, exclude[]): task_reminders_due() with some businesses left out —
--      the global reminder pass re-asks without the businesses whose `daily_tasks` is OFF, so their reminders
--      (due forever, never claimed — correct) can no longer fill the batch and delay other businesses.
--      Identifiers only, SECURITY DEFINER, search_path pinned, EXECUTE for app_runtime alone, LIMIT clamped.
--   2. The owed-push index in notification_push_due()'s exact order ("nextAttemptAt" NULLS FIRST, "id"). The
--      foundation's "NotificationDelivery_push_owed_idx" (NULLS LAST) is KEPT: dropping an index is not
--      expand-only here, and that migration's own proof asserts it exists. It can go in a later contract step.
--   3. Indexes behind the ON DELETE CASCADE / SET NULL references the foundation added (a device or a user
--      deleted no longer scans the table): NotificationDelivery("subscriptionId"), NotificationDelivery("userId"),
--      Notification("userId") — partial, NOT NULL rows only.
--   4. The feature definition + global policy rows of `notifications_engine` (OFF: defaultEnabled false,
--      globalEnabled false), so the owner can enable it per business. Nothing turns on by this migration.
-- ============================================================================================================

-- ── 1. Due reminders excluding some businesses (identifiers only) ────────────────────────────────────────────

-- Same conditions and order as task_reminders_due() (20261022090000), plus "not one of these businesses".
CREATE OR REPLACE FUNCTION public.task_reminders_due_excluding(p_now timestamp(3), p_limit integer, p_exclude integer[])
RETURNS TABLE ("businessId" integer, "taskId" integer, "remindAt" timestamp(3))
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
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
     AND NOT (t."businessId" = ANY (coalesce(p_exclude, ARRAY[]::integer[])))
   ORDER BY t."remindAt", t."id"
   LIMIT LEAST(GREATEST(coalesce(p_limit, 100), 1), 500)
$fn$;
REVOKE ALL ON FUNCTION public.task_reminders_due_excluding(timestamp(3), integer, integer[]) FROM PUBLIC;
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    REVOKE ALL ON FUNCTION public.task_reminders_due_excluding(timestamp(3), integer, integer[]) FROM app_runtime;
    GRANT EXECUTE ON FUNCTION public.task_reminders_due_excluding(timestamp(3), integer, integer[]) TO app_runtime;
  END IF;
END
$do$;

-- ── 2. The owed-push index in the worker's order ─────────────────────────────────────────────────────────────

CREATE INDEX "NotificationDelivery_push_owed_due_idx" ON "NotificationDelivery"("nextAttemptAt" ASC NULLS FIRST, "id")
  WHERE "status" = 'PENDING' AND "channel" = 'PUSH';

-- ── 3. Indexes behind the cascading references ───────────────────────────────────────────────────────────────

CREATE INDEX "NotificationDelivery_subscriptionId_idx" ON "NotificationDelivery"("subscriptionId")
  WHERE "subscriptionId" IS NOT NULL;
CREATE INDEX "NotificationDelivery_userId_idx" ON "NotificationDelivery"("userId")
  WHERE "userId" IS NOT NULL;
CREATE INDEX "Notification_userId_idx" ON "Notification"("userId")
  WHERE "userId" IS NOT NULL;

-- ── 4. The feature `notifications_engine` (OFF) ──────────────────────────────────────────────────────────────

INSERT INTO "PlatformFeatureDefinition" ("key", "displayName", "category", "description", "defaultEnabled", "mutable", "createdAt")
VALUES ('notifications_engine', 'מנוע התראות', 'integrations',
        'שליחת התראות לטלפון ולדפדפן (דחיפה), סיכום יומי ורישום מכשירים — כבוי כברירת מחדל', false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "PlatformFeaturePolicy" ("featureKey", "globalEnabled", "emergencyDisabled", "updatedAt")
VALUES ('notifications_engine', false, false, CURRENT_TIMESTAMP)
ON CONFLICT ("featureKey") DO NOTHING;
