-- Rollback of 20261129090000_service_desk_qa_lists — only for a failed or abandoned rollout, run by the migration owner in
-- ONE transaction, BEFORE any product code writes the new tables / columns / values (the code PR merges only after the
-- migration). It REFUSES when anything this migration added already holds data (a row in a new table, a case naming a
-- list, a journal event of the new action): then data would be lost, and the owner decides instead.
-- row_security = off: the new tables FORCE row-level security, so a check that could not see every business's rows must
-- fail (PostgreSQL raises instead of filtering), never pass blind.
-- The enum values added to existing types (ServiceCaseAction CHOOSE_QA_LIST, ServiceEventType qa.list_chosen) cannot be
-- removed in PostgreSQL; they stay unused and a re-application skips them (ADD VALUE IF NOT EXISTS). No existing function,
-- CHECK or policy was replaced, so nothing is restored. The ledger row is removed in the same transaction, so a later
-- `prisma migrate deploy` applies the migration again (`migrate resolve` only handles a FAILED migration).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL row_security = off;
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM "ServiceQaList") OR EXISTS (SELECT 1 FROM "ServiceQaListVersion") OR EXISTS (SELECT 1 FROM "ServiceQaListItem")
     OR EXISTS (SELECT 1 FROM "ServiceQaListEvent") OR EXISTS (SELECT 1 FROM "ServiceCaseQaRecord") OR EXISTS (SELECT 1 FROM "ServiceCaseQaItemResult") THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: QA list or QA result rows exist; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM "ServiceCase" WHERE "qaListId" IS NOT NULL OR "qaListVersion" IS NOT NULL) THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: a service case names a QA list; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM "ServiceCaseEvent" WHERE "action"::text = 'CHOOSE_QA_LIST' OR "eventType"::text = 'qa.list_chosen') THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: the case journal already holds a QA list choice; nothing was changed';
  END IF;
END
$do$;

ALTER TABLE "ServiceCaseEvent" DROP CONSTRAINT "ServiceCaseEvent_qa_list_in_place";
DROP TRIGGER "ServiceCase_qa_completion_matches" ON "ServiceCase";
DROP TRIGGER "ServiceCase_qa_list_journaled" ON "ServiceCase";
DROP TRIGGER "ServiceCase_qa_list_guard" ON "ServiceCase";
ALTER TABLE "ServiceCase" DROP CONSTRAINT "ServiceCase_qa_list_version_fkey";
ALTER TABLE "ServiceCase" DROP CONSTRAINT "ServiceCase_qa_list_pair";
DROP INDEX "ServiceCase_businessId_qaListId_idx";
ALTER TABLE "ServiceCase" DROP COLUMN "qaListId", DROP COLUMN "qaListVersion";

-- dependents first
DROP TABLE "ServiceCaseQaItemResult";
DROP TABLE "ServiceCaseQaRecord";
DROP TABLE "ServiceQaListEvent";
ALTER TABLE "ServiceQaList" DROP CONSTRAINT "ServiceQaList_current_version_fkey";
DROP TABLE "ServiceQaListItem";
DROP TABLE "ServiceQaListVersion";
DROP TABLE "ServiceQaList";
DROP FUNCTION public.service_qa_lists_erase_business();
DROP FUNCTION public.service_case_qa_result_guard();
DROP FUNCTION public.service_case_qa_record_matches();
DROP FUNCTION public.service_case_qa_record_guard();
DROP FUNCTION public.service_case_qa_completion_matches();
DROP FUNCTION public.service_case_qa_list_journaled();
DROP FUNCTION public.service_case_qa_list_guard();
DROP FUNCTION public.service_qa_list_event_guard();
DROP FUNCTION public.service_qa_list_item_guard();
DROP FUNCTION public.service_qa_list_version_complete();
DROP FUNCTION public.service_qa_list_version_guard();
DROP FUNCTION public.service_qa_list_journaled();
DROP FUNCTION public.service_qa_list_guard();
DROP FUNCTION public.service_qa_in_erasure(oid);
DROP TYPE "ServiceQaListAction";
DROP TYPE "ServiceQaResult";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261129090000_service_desk_qa_lists';
COMMIT;
