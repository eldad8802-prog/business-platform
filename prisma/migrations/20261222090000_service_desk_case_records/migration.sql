-- ============================================================================================================
-- 20261222090000_service_desk_case_records — Service Desk: the case history records the light case work
--
-- Owner approval 2026-11-22 (pilot review, business 9): the case history documents, with who acted,
--   - the item location and the estimated ready date changed   (case.work_details_recorded / RECORD_WORK_DETAILS)
--   - a replacement item lent / returned                       (loan.lent / LEND_ITEM, loan.returned / RETURN_ITEM)
--   - a task linked to / unlinked from the case                (task.linked / LINK_TASK, task.unlinked / UNLINK_TASK)
-- DRAFT — NOT APPLIED. Applying it is a separate owner approval (release-migrate).
--
-- Five STATUS-PRESERVING journal records, the same shape as P4 (20261122090000) and the case charge (20261126090000):
-- each bumps the case version and leaves status / hold / cancel request untouched, by the owner (actor OWNER_USER with
-- actorUserId = who acted). The payload stays closed (ServiceCaseEvent_payload_closed: numbers, booleans, nulls, short
-- tokens): ids into the business's own rows, flags, a YYYY-MM-DD date — never the location text, an item name or a note.
--
-- Additive only: two enums gain values, one CHECK is added. No table, column, function, trigger, grant or RLS policy
-- changes; no existing row is touched (no backfill — the history before this migration is not invented). Until it is
-- applied, the application detects its absence (the CHECK below) and writes exactly what it writes today.
-- Depends on: 20261122090000 (P4 journal) and 20261214090000 (A7: the loan table, Task."serviceCaseId", the case fields).
-- ============================================================================================================

DO $do$
BEGIN
  IF to_regclass('public."ServiceCaseEvent"') IS NULL OR to_regclass('public."ServiceCaseLoaner"') IS NULL THEN
    RAISE EXCEPTION 'SERVICE_DESK_CASE_RECORDS: the Service Desk journal or the A7 loan table is missing; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ServiceCaseEvent_record_in_place') THEN
    RAISE EXCEPTION 'SERVICE_DESK_CASE_RECORDS: the P4 audit journal (20261122090000) is not applied; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ServiceCase' AND column_name = 'itemLocationNote')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Task' AND column_name = 'serviceCaseId') THEN
    RAISE EXCEPTION 'SERVICE_DESK_CASE_RECORDS: A7 (20261214090000) is not applied; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ServiceCaseEvent_case_records_in_place') THEN
    RAISE EXCEPTION 'SERVICE_DESK_CASE_RECORDS: already applied; nothing was changed';
  END IF;
END
$do$;

SET lock_timeout = '5s';

ALTER TYPE "ServiceEventType" ADD VALUE IF NOT EXISTS 'case.work_details_recorded';
ALTER TYPE "ServiceEventType" ADD VALUE IF NOT EXISTS 'loan.lent';
ALTER TYPE "ServiceEventType" ADD VALUE IF NOT EXISTS 'loan.returned';
ALTER TYPE "ServiceEventType" ADD VALUE IF NOT EXISTS 'task.linked';
ALTER TYPE "ServiceEventType" ADD VALUE IF NOT EXISTS 'task.unlinked';
ALTER TYPE "ServiceCaseAction" ADD VALUE IF NOT EXISTS 'RECORD_WORK_DETAILS';
ALTER TYPE "ServiceCaseAction" ADD VALUE IF NOT EXISTS 'LEND_ITEM';
ALTER TYPE "ServiceCaseAction" ADD VALUE IF NOT EXISTS 'RETURN_ITEM';
ALTER TYPE "ServiceCaseAction" ADD VALUE IF NOT EXISTS 'LINK_TASK';
ALTER TYPE "ServiceCaseAction" ADD VALUE IF NOT EXISTS 'UNLINK_TASK';

-- Each action only with its own event type; none moves the case; always the owner. Compared as text: the new enum values
-- are not used before this transaction ends. NOT VALID + VALIDATE: no existing row can carry the new values.
ALTER TABLE "ServiceCaseEvent" ADD CONSTRAINT "ServiceCaseEvent_case_records_in_place" CHECK (
      ("action"::text IN ('RECORD_WORK_DETAILS', 'LEND_ITEM', 'RETURN_ITEM', 'LINK_TASK', 'UNLINK_TASK'))
    = ("eventType"::text IN ('case.work_details_recorded', 'loan.lent', 'loan.returned', 'task.linked', 'task.unlinked'))
  AND ("action"::text <> 'RECORD_WORK_DETAILS' OR "eventType"::text = 'case.work_details_recorded')
  AND ("action"::text <> 'LEND_ITEM' OR "eventType"::text = 'loan.lent')
  AND ("action"::text <> 'RETURN_ITEM' OR "eventType"::text = 'loan.returned')
  AND ("action"::text <> 'LINK_TASK' OR "eventType"::text = 'task.linked')
  AND ("action"::text <> 'UNLINK_TASK' OR "eventType"::text = 'task.unlinked')
  AND ("action"::text NOT IN ('RECORD_WORK_DETAILS', 'LEND_ITEM', 'RETURN_ITEM', 'LINK_TASK', 'UNLINK_TASK') OR (
            "fromStatus" = "toStatus"
        AND "holdReasonBefore" IS NOT DISTINCT FROM "holdReasonAfter"
        AND "cancellationRequestedBefore" = "cancellationRequestedAfter"
        AND "actor" = 'OWNER_USER'
        AND "actorUserId" IS NOT NULL))) NOT VALID;
ALTER TABLE "ServiceCaseEvent" VALIDATE CONSTRAINT "ServiceCaseEvent_case_records_in_place";
