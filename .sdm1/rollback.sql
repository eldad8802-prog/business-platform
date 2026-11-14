-- Rollback of 20261127090000_service_desk_tracks — only for a failed or abandoned rollout, run by the migration owner in
-- ONE transaction, BEFORE any product code writes the new tables / columns / values (the code PR merges only after the
-- migration). It REFUSES when anything this migration added already holds data (a row in a new table, a non-NULL new
-- column, a non-default subjectKind, a case / event / settings event using a new value): then data would be lost, and
-- the owner decides instead.
-- Enum values added to existing types (ServiceCaseKind.REMOTE, ServiceCaseStatus.WORK_DONE, ServiceOutcome.COMPLETED,
-- ServiceCaseAction RESCHEDULE / COMPLETE / CHANGE_DETAILS, ServiceEventType case.rescheduled / case.completed /
-- case.details_changed) cannot be removed in PostgreSQL; they stay unused and a re-application skips them
-- (ADD VALUE IF NOT EXISTS). service_case_guard is restored to its 20261112090000 text (below, verbatim), the two
-- replaced CHECKs to their original definitions. The ledger row is removed in the same transaction, so a later
-- `prisma migrate deploy` applies the migration again (`migrate resolve` only handles a FAILED migration).
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM "ServiceCompletion") OR EXISTS (SELECT 1 FROM "ServiceCaseDetailChange") THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: completion or detail-change rows exist; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM "ServiceCase" WHERE "workType" IS NOT NULL OR "serviceLocation" IS NOT NULL OR "appointmentId" IS NOT NULL
               OR "siteAddress" IS NOT NULL OR "siteNotes" IS NOT NULL OR "completionType" IS NOT NULL OR "completedAt" IS NOT NULL
               OR "profileKey" IS NOT NULL OR "profileSnapshot" IS NOT NULL OR "returnReason" IS NOT NULL
               OR "afterSaleResolution" IS NOT NULL OR "originalSaleRef" IS NOT NULL
               OR "kind"::text = 'REMOTE' OR "status"::text = 'WORK_DONE' OR "outcome"::text = 'COMPLETED') THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: a service case uses a column or value of this migration; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM "ServiceDevice" WHERE "subjectKind" <> 'ITEM' OR "displayName" IS NOT NULL OR "attributes" IS NOT NULL) THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: a service subject uses a column of this migration; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM "ServiceSettings" WHERE "serviceProfileKey" IS NOT NULL OR "profileOverrides" IS NOT NULL) THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: service settings hold a profile choice or overrides; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM "ServiceCaseEvent" WHERE "action"::text IN ('RESCHEDULE', 'COMPLETE', 'CHANGE_DETAILS'))
     OR EXISTS (SELECT 1 FROM "ServiceSettingsEvent" WHERE "changedFields" && ARRAY['serviceProfileKey', 'profileOverrides']::text[]) THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: the journals already hold records of this migration; nothing was changed';
  END IF;
END
$do$;

-- journal + settings journal: the original CHECK back first (every row satisfies it: checked above)
ALTER TABLE "ServiceCaseEvent" DROP CONSTRAINT "ServiceCaseEvent_tracks_in_place";
ALTER TABLE "ServiceSettingsEvent" ADD CONSTRAINT "ServiceSettingsEvent_fields" CHECK (
        cardinality("changedFields") BETWEEN 1 AND 4
    AND "changedFields" <@ ARRAY['defaultStaffMemberId', 'warrantyTemplate', 'activeTermsVersionId', 'activeStatutoryNoticeVersionId']::text[]);
ALTER TABLE "ServiceSettingsEvent" DROP CONSTRAINT "ServiceSettingsEvent_fields_v2";

-- ServiceCase: triggers, guard (verbatim 20261112090000 text), CHECKs, key, columns
DROP TRIGGER "ServiceCase_details_journaled" ON "ServiceCase";
DROP TRIGGER "ServiceCase_completion_recorded" ON "ServiceCase";
CREATE OR REPLACE FUNCTION public.service_case_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  in_erasure boolean :=
        current_setting('dubiz.service_erasure', true) = 'on'
    AND current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID);
BEGIN
  IF NEW."id" <> OLD."id" OR NEW."businessId" <> OLD."businessId" OR NEW."caseNumber" <> OLD."caseNumber"
     OR NEW."kind" <> OLD."kind" OR NEW."customerId" <> OLD."customerId"
     OR NEW."parentCaseId" IS DISTINCT FROM OLD."parentCaseId"
     OR NEW."openedAt" <> OLD."openedAt" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS01', MESSAGE = 'SERVICE_CASE_IDENTITY_FIXED: id, business, number, kind, customer, parent and opening time never change';
  END IF;
  IF OLD."deviceId" IS NOT NULL AND NEW."deviceId" IS DISTINCT FROM OLD."deviceId" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS01', MESSAGE = 'SERVICE_CASE_DEVICE_FIXED: a case''s device, once set, never changes';
  END IF;
  IF NEW."version" < OLD."version" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS01', MESSAGE = 'SERVICE_CASE_VERSION_BACKWARDS: the version never decreases';
  END IF;
  IF OLD."erasedAt" IS NOT NULL AND NEW."erasedAt" IS DISTINCT FROM OLD."erasedAt" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS01', MESSAGE = 'SERVICE_CASE_ERASED_FIXED: the erasure stamp never changes';
  END IF;
  IF (OLD."cancelledAt" IS NOT NULL AND NEW."cancelledAt" IS DISTINCT FROM OLD."cancelledAt")
     OR (OLD."abandonedAt" IS NOT NULL AND NEW."abandonedAt" IS DISTINCT FROM OLD."abandonedAt") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS01', MESSAGE = 'SERVICE_CASE_STAMP_WRITE_ONCE: cancelledAt / abandonedAt are written once';
  END IF;
  -- Reasons: written once; only the erasure may blank them (to NULL, never to another text).
  IF (OLD."cancelReason" IS NOT NULL AND NEW."cancelReason" IS DISTINCT FROM OLD."cancelReason"
        AND NOT (in_erasure AND NEW."cancelReason" IS NULL))
     OR (OLD."abandonReason" IS NOT NULL AND NEW."abandonReason" IS DISTINCT FROM OLD."abandonReason"
        AND NOT (in_erasure AND NEW."abandonReason" IS NULL)) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS01', MESSAGE = 'SERVICE_CASE_REASON_WRITE_ONCE: a reason, once recorded, never changes';
  END IF;
  IF NOT in_erasure AND (
       (OLD."problemDescription" IS NOT NULL AND NEW."problemDescription" IS NULL)
    OR (NEW."erasedAt" IS NOT NULL AND OLD."erasedAt" IS NULL)) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS01', MESSAGE = 'SERVICE_CASE_ERASURE_ONLY: only the account erasure blanks a case';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_case_guard() FROM PUBLIC;
ALTER TABLE "ServiceCase" ADD CONSTRAINT "ServiceCase_outcome_by_status" CHECK (
    ("outcome" IS NOT NULL) = ("status" IN ('READY', 'DELIVERED', 'CLOSED', 'ABANDONED', 'CANCELLED')));
ALTER TABLE "ServiceCase" DROP CONSTRAINT "ServiceCase_outcome_by_status_v2";
ALTER TABLE "ServiceCase" DROP CONSTRAINT "ServiceCase_location_matches_kind";
ALTER TABLE "ServiceCase" DROP CONSTRAINT "ServiceCase_after_sale_fields";
ALTER TABLE "ServiceCase" DROP CONSTRAINT "ServiceCase_track_texts";
ALTER TABLE "ServiceCase" DROP CONSTRAINT "ServiceCase_profile_snapshot";
ALTER TABLE "ServiceCase" DROP CONSTRAINT "ServiceCase_completion_stamp";
ALTER TABLE "ServiceCase" DROP CONSTRAINT "ServiceCase_completion_place";
ALTER TABLE "ServiceCase" DROP CONSTRAINT "ServiceCase_completed_not_repair";
ALTER TABLE "ServiceCase" DROP CONSTRAINT "ServiceCase_appointment_tenant_fkey";
DROP INDEX "ServiceCase_businessId_appointmentId_key";
ALTER TABLE "ServiceCase"
  DROP COLUMN "workType", DROP COLUMN "serviceLocation", DROP COLUMN "appointmentId", DROP COLUMN "siteAddress",
  DROP COLUMN "siteNotes", DROP COLUMN "completionType", DROP COLUMN "completedAt", DROP COLUMN "profileKey",
  DROP COLUMN "profileSnapshot", DROP COLUMN "returnReason", DROP COLUMN "afterSaleResolution", DROP COLUMN "originalSaleRef";

ALTER TABLE "ServiceDevice" DROP CONSTRAINT "ServiceDevice_subject_fields";
ALTER TABLE "ServiceDevice" DROP COLUMN "subjectKind", DROP COLUMN "displayName", DROP COLUMN "attributes";
ALTER TABLE "ServiceSettings" DROP CONSTRAINT "ServiceSettings_profile";
ALTER TABLE "ServiceSettings" DROP COLUMN "serviceProfileKey", DROP COLUMN "profileOverrides";

DROP TABLE "ServiceCaseDetailChange";
DROP TABLE "ServiceCompletion";
DROP FUNCTION public.service_tracks_erase_business();
DROP FUNCTION public.service_detail_change_matches();
DROP FUNCTION public.service_detail_change_guard();
DROP FUNCTION public.service_completion_matches_case();
DROP FUNCTION public.service_completion_guard();
DROP FUNCTION public.service_case_completion_recorded();
DROP FUNCTION public.service_case_details_journaled();
DROP FUNCTION public.service_tracks_in_erasure(oid);
DROP TYPE "ServiceAfterSaleResolution";
DROP TYPE "ServiceReturnReason";
DROP TYPE "ServiceCompletionType";
DROP TYPE "ServiceSubjectKind";
DROP TYPE "ServiceLocationKind";
DROP TYPE "ServiceWorkType";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261127090000_service_desk_tracks';
COMMIT;
