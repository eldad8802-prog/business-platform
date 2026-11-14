-- ============================================================================================================
-- Notifications: stuck document detection + personal appointment lead time (notifications track, PR 2d —
-- migration only; owner approval 2026-11-13).
--
-- DEPENDS ON 20261212090000_notification_engine_activation (PR 2c) → 20261211090000_notification_engine_followup
-- (PR 2b) → 20261210090000_notification_engine_foundation (PR #1143): "NotificationSettings" is the foundation's.
-- Its timestamp sorts after all three, so `prisma migrate deploy` applies them in order; it must never be applied
-- without them. The application that reads the two new columns comes in the code PR (notify/9-docs-appointments;
-- migration-first).
--
-- 1. "Document"."statusChangedAt" — WHEN the document entered its current status (UTC wall clock, like every
--    timestamp(3) column the application writes). The notification sweep needs it to tell a document that is really
--    stuck in "processing" from one whose attempt is still running; no application or pipeline code changes: the
--    column belongs to a BEFORE trigger.
--      * INSERT                                   → the statement's time (whatever the statement passed).
--      * UPDATE that changes "status"             → the statement's time.
--      * UPDATE that writes "status" = 'processing' again (processing → processing) → the statement's time: that
--        write is the "retry" action (app/api/documents/[id]/process) starting a NEW attempt of a document stuck in
--        processing; its window starts now, so it is not flagged while it runs. No other path writes 'processing' to
--        an existing row (upload / ingestion INSERT it).
--      * any other UPDATE that names "status" or "statusChangedAt" (same value, e.g. failed → failed) → unchanged:
--        the column cannot be moved by hand.
--    Historical rows stay NULL (no backfill, no table rewrite): a NULL is never "stuck", so nothing that predates the
--    release is ever flagged — no false alarm on history. The pipeline's real windows (the threshold is the code
--    PR's, documented there): an attempt runs inside the invocation that started it — after() of the upload / retry
--    route (maxDuration 60 s) or of the bulk documents import (maxDuration 300 s); the pipeline never retries by
--    itself and never throws (it ends in needs_review or failed); an invocation killed at maxDuration leaves the row
--    in processing for good, which is exactly the case to surface.
--    RLS, policies (p7w4d_tenant, p7adm_read), grants and the admin's column grants on "Document" are untouched; the
--    runtime's table-level privileges cover the new column. Erasure: "Document" is retained bookkeeping evidence
--    (account-erasure-manifest Bucket A); a status timestamp says nothing about a person.
--
-- 2. "NotificationSettings"."appointmentReminderMinutes" — the user's own appointment reminder lead time:
--    30, 60, 120 or 1440 minutes (1440 = the same local time the day before); NULL = the product default (60), like
--    every other column of the table. A CHECK refuses anything else. RLS (the four tenant policies), the same-
--    business trigger, grants and erasure (the row goes with the user / business; "restore defaults" deletes it)
--    are untouched.
--
-- Expand-only: two nullable columns, one CHECK on the new column, one trigger function, one trigger. Nothing dropped,
-- renamed or narrowed; no existing row changes (both columns are added without a default: no rewrite, every
-- existing row reads NULL); every statement the current application issues keeps working (the trigger only fills
-- the new column and never fails).
--
-- RECOVERY PLAN (Production; the owner runs it, never automatic):
--   * The migration fails while applying: it runs in ONE transaction (`prisma migrate deploy`), so nothing of it
--     remains (proven by the lab's atomicity step); the ledger row is left unfinished — fix the cause, then
--     `prisma migrate resolve --rolled-back 20261213090000_notification_docs_stuck_appointment_lead` and deploy again.
--   * The trigger misbehaves after the release (e.g. a write path the lab did not cover fails): disable it, which
--     stops the stamping and changes nothing else —
--       ALTER TABLE "Document" DISABLE TRIGGER "Document_status_changed_at";
--     A NULL / stale "statusChangedAt" only makes the stuck check silent (never a false alarm, never a block).
--   * Full rollback (only if the code PR is not deployed, or is reverted first — it reads both columns):
--       DROP TRIGGER "Document_status_changed_at" ON "Document";
--       DROP FUNCTION public.document_status_changed_at();
--       ALTER TABLE "Document" DROP COLUMN "statusChangedAt";
--       ALTER TABLE "NotificationSettings" DROP COLUMN "appointmentReminderMinutes";
--       DELETE FROM "_prisma_migrations" WHERE migration_name = '20261213090000_notification_docs_stuck_appointment_lead';
--     Data lost by that rollback: only the stamps and the users' lead-time choices (they fall back to 60 minutes).
-- ============================================================================================================

-- ── 1. "Document"."statusChangedAt" + its trigger ───────────────────────────────────────────────────────────

ALTER TABLE "Document" ADD COLUMN "statusChangedAt" TIMESTAMP(3);

CREATE FUNCTION public.document_status_changed_at() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW."status" IS DISTINCT FROM OLD."status"
     OR NEW."status" = 'processing' THEN
    NEW."statusChangedAt" := (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3);
  ELSE
    NEW."statusChangedAt" := OLD."statusChangedAt";
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.document_status_changed_at() FROM PUBLIC;

CREATE TRIGGER "Document_status_changed_at"
  BEFORE INSERT OR UPDATE OF "status", "statusChangedAt" ON "Document"
  FOR EACH ROW EXECUTE FUNCTION public.document_status_changed_at();

-- ── 2. "NotificationSettings"."appointmentReminderMinutes" ──────────────────────────────────────────────────

ALTER TABLE "NotificationSettings" ADD COLUMN "appointmentReminderMinutes" SMALLINT;
ALTER TABLE "NotificationSettings" ADD CONSTRAINT "NotificationSettings_appointment_reminder"
  CHECK ("appointmentReminderMinutes" IS NULL OR "appointmentReminderMinutes" IN (30, 60, 120, 1440));
