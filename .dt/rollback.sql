-- Reversal of 20261018090000_daily_tasks_foundation. OWNER-RUN ONLY, never automatic.
--
-- Safe only while no code reads or writes the new objects (the application PR not deployed, or reverted
-- first). It REFUSES while "Task" or any new table holds a row, or while any business has the daily_tasks
-- flag overridden: discarding an owner's tasks or journal is a separate, explicit owner decision — never a
-- side effect of a rollback.
--
-- What comes back: "Task" as wave 1 left it (its 9 columns, FORCE RLS, the FOR ALL policy p7w1_tenant).
-- What deliberately does NOT come back: the privileges on "Task" / "Task_id_seq" that the gate run found
-- (G4). No migration granted them, no code used them, and the owner decided they go; a rollback leaves the
-- table ungranted — strictly narrower than before the migration.
-- It removes its own ledger row in the same transaction, so a later release re-applies the migration whole.

BEGIN;
DO $rb$
BEGIN
  IF EXISTS (SELECT 1 FROM "Task") OR EXISTS (SELECT 1 FROM "TaskSeries") OR EXISTS (SELECT 1 FROM "TaskEvent")
     OR EXISTS (SELECT 1 FROM "TaskSourceState") OR EXISTS (SELECT 1 FROM "TaskPreferences")
     OR EXISTS (SELECT 1 FROM "TaskRequestLedger")
     OR EXISTS (SELECT 1 FROM "BusinessFeatureAccess" WHERE "featureKey" = 'daily_tasks') THEN
    RAISE EXCEPTION 'daily tasks rollback refused: rows exist';
  END IF;
END
$rb$;

DELETE FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'daily_tasks';
DELETE FROM "PlatformFeatureDefinition" WHERE "key" = 'daily_tasks';

DROP FUNCTION public.task_retention_erase_business();
DROP FUNCTION public.task_retention_purge_source_state();
DROP FUNCTION public.task_retention_purge_learning_events();
DROP FUNCTION public.task_retention_clear_source_identifiers();
DROP FUNCTION public.task_retention_clear_event_digests();
DROP FUNCTION public.task_retention_purge_request_ledger();
DROP FUNCTION public.task_retention_days(text);
DROP TABLE "TaskRetentionPolicy";

DROP TABLE "TaskEvent";
DROP TABLE "TaskRequestLedger";
DROP TABLE "TaskPreferences";
DROP TABLE "TaskSourceState";

DROP TRIGGER "Task_user_same_business" ON "Task";
DROP POLICY task_tenant_select ON "Task";
DROP POLICY task_tenant_insert ON "Task";
DROP POLICY task_tenant_update ON "Task";
DROP INDEX "Task_one_open_per_series";
DROP INDEX "Task_seriesId_sequence_key";
DROP INDEX "Task_businessId_status_dueOn_idx";
ALTER TABLE "Task"
  DROP CONSTRAINT "Task_seriesId_tenant_fkey",
  DROP CONSTRAINT "Task_one_link",
  DROP CONSTRAINT "Task_series_sequence_pair",
  DROP CONSTRAINT "Task_version_positive",
  DROP CONSTRAINT "Task_text_length",
  DROP COLUMN "dueOn", DROP COLUMN "remindAt", DROP COLUMN "closeReason", DROP COLUMN "completedAt",
  DROP COLUMN "completedByUserId", DROP COLUMN "createdByUserId", DROP COLUMN "assigneeUserId",
  DROP COLUMN "seriesId", DROP COLUMN "sequence", DROP COLUMN "pinnedAt", DROP COLUMN "origin",
  DROP COLUMN "version", DROP COLUMN "customerId", DROP COLUMN "supplierId", DROP COLUMN "leadId",
  DROP COLUMN "documentId", DROP COLUMN "erasedAt";
DROP INDEX "Task_businessId_id_key";
-- G4 stays decided: the privileges this migration granted go, and none of the ones it took back return.
DO $rb$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    REVOKE ALL ON "Task" FROM app_runtime;
    REVOKE ALL ON SEQUENCE "Task_id_seq" FROM app_runtime;
  END IF;
END $rb$;
CREATE POLICY p7w1_tenant ON "Task"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

DROP TABLE "TaskSeries";
DROP FUNCTION public.task_user_same_business();
DROP FUNCTION public.task_event_append_only_guard();
DROP FUNCTION public.task_event_truncate_guard();
ALTER TABLE "Supplier" DROP CONSTRAINT "Supplier_businessId_id_key";

DROP TYPE "TaskEventType";
DROP TYPE "TaskEventActor";
DROP TYPE "TaskSeriesRuleKind";
DROP TYPE "TaskCloseReason";
DROP TYPE "TaskOrigin";

DELETE FROM "_prisma_migrations" WHERE migration_name = '20261018090000_daily_tasks_foundation';
COMMIT;

-- The NOLOGIN role task_maintenance owns nothing and holds nothing after the above; it is cluster-wide, so
-- it is removed outside the transaction, only if no other database references it:
DROP ROLE IF EXISTS task_maintenance;
