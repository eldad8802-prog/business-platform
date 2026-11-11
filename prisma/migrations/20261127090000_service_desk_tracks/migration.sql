-- ============================================================================================================
-- 20261127090000_service_desk_tracks — Service Desk M1: the universal service model (work type, place, subject),
-- the WORK_DONE → CLOSED completion without a customer signature, details changes before work starts (D3 / D11),
-- the profile snapshot (D14) and the after-sale track T7. DRAFT — never applied without the owner's separate approval.
-- Order: after 20261126090000 (#1104), which is after 20261125090000 (#1096) and 20261123090000 (#1061).
--
-- Source: planning doc "שירות ואחריות", sections א (values), ב (state machine), ד (schema map), ט (CHANGE_DETAILS / D3,
-- D11, D12, D13), יא (D14), כב / כח (T7). Owner decision 2026-11-11: NO customer signature anywhere — the owner (or an
-- authorized user) confirms; the journal records who, when and what changed.
--
--   types        ServiceWorkType, ServiceLocationKind, ServiceSubjectKind, ServiceCompletionType, ServiceReturnReason,
--                ServiceAfterSaleResolution (the last two = RETURN_REASONS / AFTER_SALE_RESOLUTIONS of
--                lib/services/service-desk/service-profiles.ts, verbatim)
--   enum values  ServiceCaseKind.REMOTE, ServiceCaseStatus.WORK_DONE, ServiceOutcome.COMPLETED, ServiceCaseAction
--                RESCHEDULE / COMPLETE / CHANGE_DETAILS, ServiceEventType case.rescheduled / case.completed /
--                case.details_changed — ADD VALUE only; never used before this transaction ends (compared as text)
--   ServiceCase  new NULLABLE columns (NULL = derived from kind at read time, exactly today's behaviour) + CHECKs;
--                ServiceCase_outcome_by_status replaced by a wider CHECK that admits WORK_DONE (added NOT VALID,
--                validated, then the old one dropped); service_case_guard replaced (D3 / D14 / write-once completion);
--                two deferred constraint triggers (a details change is journaled; a completion has its record)
--   ServiceDevice  subjectKind (NOT NULL DEFAULT 'ITEM' — a constant default: no table rewrite on PG >= 11),
--                displayName, attributes
--   ServiceSettings  serviceProfileKey (one of SERVICE_PROFILE_KEYS), profileOverrides. service_settings_guard (as
--                replaced by #1061) whitelists no column, so it is NOT replaced; ServiceSettingsEvent_fields widened to
--                the two new field names (same replace-by-validated-CHECK procedure)
--   new tables   ServiceCompletion (one per case, immutable, no signature columns), ServiceCaseDetailChange (D11,
--                append-only, erased with the account)
--   journal      ServiceCaseEvent_tracks_in_place: RESCHEDULE in place (SCHEDULED), CHANGE_DETAILS in place or
--                SCHEDULED → OPEN (UNSCHEDULE, D13), COMPLETE = WORK_DONE → CLOSED (section ב rule 4)
--   erasure      service_tracks_erase_business() — SECURITY DEFINER, its own function; no existing erase function is
--                replaced (service_erase_business blanks the case by a fixed column list that cannot know the new
--                personal columns, so they are scrubbed here)
--
-- Unchanged: every existing row (all new columns are NULL / the constant default; every existing row satisfies every new
-- CHECK), table, policy and grant; every existing function except service_case_guard (body copied from
-- 20261112090000_service_desk_foundation — the only migration that defines it — and changed minimally, see 3.1).
-- ============================================================================================================

-- ── 0. Premises ─────────────────────────────────────────────────────────────────────────────────────────────
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    RAISE EXCEPTION 'SERVICE_DESK_TRACKS: role app_runtime is missing; nothing was changed';
  END IF;
  IF to_regclass('public."ServiceCase"') IS NULL OR to_regclass('public."ServiceDevice"') IS NULL
     OR to_regclass('public."ServiceSettings"') IS NULL OR to_regclass('public."ServiceSettingsEvent"') IS NULL
     OR to_regclass('public."ServicePart"') IS NULL OR to_regclass('public."ServiceExternalWork"') IS NULL
     OR to_regclass('public."ServiceWarrantyOffer"') IS NULL OR to_regclass('public."Appointment"') IS NULL THEN
    RAISE EXCEPTION 'SERVICE_DESK_TRACKS: a Service Desk table (or Appointment) this migration reads is missing; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ServiceCase_businessId_id_key')
     OR NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ServiceCaseEvent_businessId_caseId_seq_key')
     OR NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'Appointment_id_businessId_key') THEN
    RAISE EXCEPTION 'SERVICE_DESK_TRACKS: a composite key this migration references is missing; nothing was changed';
  END IF;
  IF to_regprocedure('public.service_case_guard()') IS NULL OR to_regprocedure('public.service_user_same_business()') IS NULL
     OR to_regprocedure('public.service_journal_truncate_guard()') IS NULL
     OR to_regprocedure('public.service_ui_business_writable(integer)') IS NULL THEN
    RAISE EXCEPTION 'SERVICE_DESK_TRACKS: the Service Desk trigger functions are missing; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ServiceCase_outcome_by_status' AND conrelid = 'public."ServiceCase"'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ServiceSettingsEvent_fields' AND conrelid = 'public."ServiceSettingsEvent"'::regclass) THEN
    RAISE EXCEPTION 'SERVICE_DESK_TRACKS: a CHECK this migration replaces is not in place; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ServiceCaseEvent_charge_in_place') THEN
    RAISE EXCEPTION 'SERVICE_DESK_TRACKS: the case charge migration (20261126090000) is not applied; nothing was changed';
  END IF;
END
$do$;

SET lock_timeout = '5s';

-- ── 1. Types ────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TYPE "ServiceWorkType" AS ENUM (
  'REPAIR', 'MAINTENANCE', 'INSTALLATION', 'INSPECTION', 'PROFESSIONAL', 'REMOTE_SUPPORT', 'AFTER_SALE');
CREATE TYPE "ServiceLocationKind" AS ENUM ('AT_BUSINESS', 'AT_CUSTOMER', 'FIELD_SITE', 'REMOTE');
CREATE TYPE "ServiceSubjectKind" AS ENUM ('ITEM', 'VEHICLE', 'SYSTEM', 'NONE');
-- How a case WITHOUT a handover is proven done (COMPLETE, WORK_DONE → CLOSED). Always the owner's confirmation — never
-- a customer signature (owner decision 2026-11-11). The value names WHERE the owner confirmed, which must be where the
-- work was done (ServiceCase_completion_place): on site (AT_CUSTOMER / FIELD_SITE), remotely, or at the business
-- (work at the business that hands nothing back, e.g. professional service, or a T7 credit / exchange where the item
-- stays). A held item never completes here: it leaves through ServiceHandover (READY → DELIVERED), as today.
CREATE TYPE "ServiceCompletionType" AS ENUM ('OWNER_CONFIRMED_ON_SITE', 'OWNER_CONFIRMED_REMOTE', 'OWNER_CONFIRMED_AT_BUSINESS');
-- T7 (after-sale). Verbatim RETURN_REASONS / AFTER_SALE_RESOLUTIONS of lib/services/service-desk/service-profiles.ts.
CREATE TYPE "ServiceReturnReason" AS ENUM ('DEFECT', 'NOT_AS_DESCRIBED', 'WRONG_ITEM', 'CHANGE_OF_MIND', 'LEGAL_CANCELLATION', 'OTHER');
CREATE TYPE "ServiceAfterSaleResolution" AS ENUM ('REPAIR', 'EXCHANGE', 'CREDIT', 'RETURN_ORIGINAL');

ALTER TYPE "ServiceCaseKind" ADD VALUE IF NOT EXISTS 'REMOTE';
ALTER TYPE "ServiceCaseStatus" ADD VALUE IF NOT EXISTS 'WORK_DONE';
ALTER TYPE "ServiceOutcome" ADD VALUE IF NOT EXISTS 'COMPLETED';
ALTER TYPE "ServiceCaseAction" ADD VALUE IF NOT EXISTS 'RESCHEDULE';
ALTER TYPE "ServiceCaseAction" ADD VALUE IF NOT EXISTS 'COMPLETE';
ALTER TYPE "ServiceCaseAction" ADD VALUE IF NOT EXISTS 'CHANGE_DETAILS';
ALTER TYPE "ServiceEventType" ADD VALUE IF NOT EXISTS 'case.rescheduled';
ALTER TYPE "ServiceEventType" ADD VALUE IF NOT EXISTS 'case.completed';
ALTER TYPE "ServiceEventType" ADD VALUE IF NOT EXISTS 'case.details_changed';

-- ── 2. ServiceCase ──────────────────────────────────────────────────────────────────────────────────────────
-- NULL work type / place = derived from kind at read time (IN_SHOP → REPAIR / AT_BUSINESS; FIELD → REPAIR /
-- AT_CUSTOMER; MAINTENANCE → MAINTENANCE / AT_CUSTOMER; REMOTE → REMOTE). Every existing row stays NULL.
ALTER TABLE "ServiceCase"
  ADD COLUMN "workType"            "ServiceWorkType",
  ADD COLUMN "serviceLocation"     "ServiceLocationKind",
  ADD COLUMN "appointmentId"       INTEGER,
  ADD COLUMN "siteAddress"         TEXT,
  ADD COLUMN "siteNotes"           TEXT,
  ADD COLUMN "completionType"      "ServiceCompletionType",
  ADD COLUMN "completedAt"         TIMESTAMP(3),
  ADD COLUMN "profileKey"          TEXT,
  ADD COLUMN "profileSnapshot"     JSONB,
  ADD COLUMN "returnReason"        "ServiceReturnReason",
  ADD COLUMN "afterSaleResolution" "ServiceAfterSaleResolution",
  ADD COLUMN "originalSaleRef"     TEXT;

-- Each new CHECK is added NOT VALID and validated (SHARE UPDATE EXCLUSIVE: reads and writes continue meanwhile).
-- kind is compared as text (its value REMOTE is new in this transaction).
ALTER TABLE "ServiceCase" ADD CONSTRAINT "ServiceCase_location_matches_kind" CHECK (
  "serviceLocation" IS NULL OR (
        ("serviceLocation" = 'AT_BUSINESS') = ("kind"::text = 'IN_SHOP')
    AND ("serviceLocation" = 'REMOTE') = ("kind"::text = 'REMOTE'))) NOT VALID;
ALTER TABLE "ServiceCase" ADD CONSTRAINT "ServiceCase_after_sale_fields" CHECK (
  "workType" IS NOT DISTINCT FROM 'AFTER_SALE' OR ("returnReason" IS NULL AND "afterSaleResolution" IS NULL AND "originalSaleRef" IS NULL)) NOT VALID;
ALTER TABLE "ServiceCase" ADD CONSTRAINT "ServiceCase_track_texts" CHECK (
        ("siteAddress" IS NULL OR (char_length("siteAddress") <= 500 AND btrim("siteAddress") <> ''))
    AND ("siteNotes" IS NULL OR (char_length("siteNotes") <= 2000 AND btrim("siteNotes") <> ''))
    AND ("originalSaleRef" IS NULL OR (char_length("originalSaleRef") <= 120 AND btrim("originalSaleRef") <> '' AND "originalSaleRef" = btrim("originalSaleRef")))) NOT VALID;
-- D14: the profile key and its snapshot come together (a case opened before M1 has neither and keeps today's rules).
ALTER TABLE "ServiceCase" ADD CONSTRAINT "ServiceCase_profile_snapshot" CHECK (
        ("profileKey" IS NULL) = ("profileSnapshot" IS NULL)
    AND ("profileKey" IS NULL OR "profileKey" ~ '^[a-z][a-z0-9_]{0,63}$')
    AND ("profileSnapshot" IS NULL OR (jsonb_typeof("profileSnapshot") = 'object' AND octet_length("profileSnapshot"::text) <= 16384))) NOT VALID;
-- COMPLETE (WORK_DONE → CLOSED) stamps both; only a CLOSED case carries them; the place of the confirmation is the
-- place of the work (the effective place: serviceLocation, or derived from kind).
ALTER TABLE "ServiceCase" ADD CONSTRAINT "ServiceCase_completion_stamp" CHECK (
        ("completionType" IS NULL) = ("completedAt" IS NULL)
    AND ("completionType" IS NULL OR "status"::text = 'CLOSED')) NOT VALID;
ALTER TABLE "ServiceCase" ADD CONSTRAINT "ServiceCase_completion_place" CHECK (
  "completionType" IS NULL OR (
        ("completionType" = 'OWNER_CONFIRMED_REMOTE')
      = (COALESCE("serviceLocation"::text, CASE "kind"::text WHEN 'IN_SHOP' THEN 'AT_BUSINESS' WHEN 'REMOTE' THEN 'REMOTE' ELSE 'AT_CUSTOMER' END) = 'REMOTE')
    AND ("completionType" = 'OWNER_CONFIRMED_AT_BUSINESS')
      = (COALESCE("serviceLocation"::text, CASE "kind"::text WHEN 'IN_SHOP' THEN 'AT_BUSINESS' WHEN 'REMOTE' THEN 'REMOTE' ELSE 'AT_CUSTOMER' END) = 'AT_BUSINESS'))) NOT VALID;
-- COMPLETED (section א.6) is the outcome of work that is not a repair; a case with no explicit work type (opened before
-- M1) is judged by the application from its kind.
ALTER TABLE "ServiceCase" ADD CONSTRAINT "ServiceCase_completed_not_repair" CHECK (
  "outcome"::text IS DISTINCT FROM 'COMPLETED' OR "workType" IS DISTINCT FROM 'REPAIR') NOT VALID;
-- ⚠ the outcome rule, widened: WORK_DONE ("the work is finished, only closing is left") carries its outcome like READY.
-- Replaces ServiceCase_outcome_by_status of 20261112090000 (outcome ⇔ READY / DELIVERED / CLOSED / ABANDONED / CANCELLED).
ALTER TABLE "ServiceCase" ADD CONSTRAINT "ServiceCase_outcome_by_status_v2" CHECK (
  ("outcome" IS NOT NULL) = ("status"::text IN ('READY', 'WORK_DONE', 'DELIVERED', 'CLOSED', 'ABANDONED', 'CANCELLED'))) NOT VALID;

ALTER TABLE "ServiceCase" VALIDATE CONSTRAINT "ServiceCase_location_matches_kind";
ALTER TABLE "ServiceCase" VALIDATE CONSTRAINT "ServiceCase_after_sale_fields";
ALTER TABLE "ServiceCase" VALIDATE CONSTRAINT "ServiceCase_track_texts";
ALTER TABLE "ServiceCase" VALIDATE CONSTRAINT "ServiceCase_profile_snapshot";
ALTER TABLE "ServiceCase" VALIDATE CONSTRAINT "ServiceCase_completion_stamp";
ALTER TABLE "ServiceCase" VALIDATE CONSTRAINT "ServiceCase_completion_place";
ALTER TABLE "ServiceCase" VALIDATE CONSTRAINT "ServiceCase_completed_not_repair";
ALTER TABLE "ServiceCase" VALIDATE CONSTRAINT "ServiceCase_outcome_by_status_v2";
ALTER TABLE "ServiceCase" DROP CONSTRAINT "ServiceCase_outcome_by_status";

-- The appointment of a scheduled case: an appointment of the SAME business (composite key; Appointment is not changed —
-- only the referencing side's foundation key "Appointment_id_businessId_key" is used). One case per appointment.
CREATE UNIQUE INDEX "ServiceCase_businessId_appointmentId_key" ON "ServiceCase"("businessId", "appointmentId")
  WHERE "appointmentId" IS NOT NULL;
ALTER TABLE "ServiceCase" ADD CONSTRAINT "ServiceCase_appointment_tenant_fkey"
  FOREIGN KEY ("appointmentId", "businessId") REFERENCES "Appointment"("id", "businessId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ── 3. ServiceDevice — the general service subject (the name stays; the screens say "נושא השירות") ───────────
ALTER TABLE "ServiceDevice"
  ADD COLUMN "subjectKind" "ServiceSubjectKind" NOT NULL DEFAULT 'ITEM',
  ADD COLUMN "displayName" TEXT,
  ADD COLUMN "attributes"  JSONB;
ALTER TABLE "ServiceDevice" ADD CONSTRAINT "ServiceDevice_subject_fields" CHECK (
        ("displayName" IS NULL OR (char_length("displayName") <= 200 AND btrim("displayName") <> ''))
    AND ("attributes" IS NULL OR (jsonb_typeof("attributes") = 'object' AND octet_length("attributes"::text) <= 8192))) NOT VALID;
ALTER TABLE "ServiceDevice" VALIDATE CONSTRAINT "ServiceDevice_subject_fields";

-- ── 4. ServiceSettings — the business's profile choice and its bounded overrides ─────────────────────────────
-- NULL = the profile resolved from the business category (resolveProfileKey). service_settings_guard (latest body:
-- 20261123090000, #1061) checks version, deletion and the active texts but restricts no other column, so it needs no
-- replacement; the bounds of the overrides themselves are enforced by the application (checkOverrides).
ALTER TABLE "ServiceSettings"
  ADD COLUMN "serviceProfileKey" TEXT,
  ADD COLUMN "profileOverrides"  JSONB;
ALTER TABLE "ServiceSettings" ADD CONSTRAINT "ServiceSettings_profile" CHECK (
        ("serviceProfileKey" IS NULL OR "serviceProfileKey" IN
           ('general', 'device_lab', 'garage', 'home_technician', 'installer', 'remote_it', 'professional', 'jewelry'))
    AND ("profileOverrides" IS NULL OR (jsonb_typeof("profileOverrides") = 'object' AND octet_length("profileOverrides"::text) <= 16384))) NOT VALID;
ALTER TABLE "ServiceSettings" VALIDATE CONSTRAINT "ServiceSettings_profile";
-- The settings journal (P4) names changed fields from a closed set: the two new fields join it. Replaces
-- ServiceSettingsEvent_fields of 20261122090000 (four names, at most four).
ALTER TABLE "ServiceSettingsEvent" ADD CONSTRAINT "ServiceSettingsEvent_fields_v2" CHECK (
      cardinality("changedFields") BETWEEN 1 AND 6
  AND "changedFields" <@ ARRAY['defaultStaffMemberId', 'warrantyTemplate', 'activeTermsVersionId', 'activeStatutoryNoticeVersionId',
                               'serviceProfileKey', 'profileOverrides']::text[]) NOT VALID;
ALTER TABLE "ServiceSettingsEvent" VALIDATE CONSTRAINT "ServiceSettingsEvent_fields_v2";
ALTER TABLE "ServiceSettingsEvent" DROP CONSTRAINT "ServiceSettingsEvent_fields";

-- ── 5. New tables ───────────────────────────────────────────────────────────────────────────────────────────
-- 5.1 ServiceCompletion: the owner's confirmation that the work of a case without a handover is done. One per case,
-- immutable. NO signature, signature key or confirmation channel (owner decision 2026-11-11); the name of whoever
-- confirmed on the customer's side is optional.
CREATE TABLE "ServiceCompletion" (
  "id"              SERIAL NOT NULL,
  "businessId"      INTEGER NOT NULL,
  "caseId"          INTEGER NOT NULL,
  "completionType"  "ServiceCompletionType" NOT NULL,
  "confirmedByName" TEXT,
  "note"            TEXT,
  "actorUserId"     INTEGER,
  "completedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "erasedAt"        TIMESTAMP(3),
  CONSTRAINT "ServiceCompletion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ServiceCompletion_texts" CHECK (
        ("confirmedByName" IS NULL OR (char_length("confirmedByName") <= 200 AND btrim("confirmedByName") <> ''))
    AND ("note" IS NULL OR (char_length("note") <= 2000 AND btrim("note") <> '')))
);
CREATE UNIQUE INDEX "ServiceCompletion_businessId_id_key" ON "ServiceCompletion"("businessId", "id");
CREATE UNIQUE INDEX "ServiceCompletion_businessId_caseId_key" ON "ServiceCompletion"("businessId", "caseId");
ALTER TABLE "ServiceCompletion" ADD CONSTRAINT "ServiceCompletion_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceCompletion" ADD CONSTRAINT "ServiceCompletion_case_tenant_fkey"
  FOREIGN KEY ("businessId", "caseId") REFERENCES "ServiceCase"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServiceCompletion" ADD CONSTRAINT "ServiceCompletion_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 5.2 ServiceCaseDetailChange (D11): one row per CHANGE_DETAILS, at the journal event's seq (= the case version it
-- produced). The journal payload stays closed (tokens only); before / after values live here — the address too,
-- because this table is scrubbed with the account while the journal is kept. changedFields: names only, closed set.
CREATE TABLE "ServiceCaseDetailChange" (
  "id"                    SERIAL NOT NULL,
  "businessId"            INTEGER NOT NULL,
  "caseId"                INTEGER NOT NULL,
  "caseVersion"           INTEGER NOT NULL,
  "changedFields"         TEXT[] NOT NULL,
  "kindBefore"            "ServiceCaseKind" NOT NULL,
  "kindAfter"             "ServiceCaseKind" NOT NULL,
  "workTypeBefore"        "ServiceWorkType",
  "workTypeAfter"         "ServiceWorkType",
  "serviceLocationBefore" "ServiceLocationKind",
  "serviceLocationAfter"  "ServiceLocationKind",
  "returnReasonBefore"    "ServiceReturnReason",
  "returnReasonAfter"     "ServiceReturnReason",
  "siteAddressBefore"     TEXT,
  "siteAddressAfter"      TEXT,
  "reason"                TEXT,
  "actorUserId"           INTEGER,
  "occurredAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "erasedAt"              TIMESTAMP(3),
  CONSTRAINT "ServiceCaseDetailChange_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ServiceCaseDetailChange_version" CHECK ("caseVersion" >= 2),
  CONSTRAINT "ServiceCaseDetailChange_fields" CHECK (
        cardinality("changedFields") BETWEEN 1 AND 5
    AND "changedFields" <@ ARRAY['kind', 'workType', 'serviceLocation', 'siteAddress', 'returnReason']::text[]),
  -- a field is named exactly when its value changed (the address: until the account erasure blanks both values)
  CONSTRAINT "ServiceCaseDetailChange_fields_match" CHECK (
        ('kind' = ANY("changedFields")) = ("kindBefore"::text IS DISTINCT FROM "kindAfter"::text)
    AND ('workType' = ANY("changedFields")) = ("workTypeBefore" IS DISTINCT FROM "workTypeAfter")
    AND ('serviceLocation' = ANY("changedFields")) = ("serviceLocationBefore" IS DISTINCT FROM "serviceLocationAfter")
    AND ('returnReason' = ANY("changedFields")) = ("returnReasonBefore" IS DISTINCT FROM "returnReasonAfter")
    AND ("erasedAt" IS NOT NULL OR ('siteAddress' = ANY("changedFields")) = ("siteAddressBefore" IS DISTINCT FROM "siteAddressAfter"))),
  CONSTRAINT "ServiceCaseDetailChange_texts" CHECK (
        ("siteAddressBefore" IS NULL OR char_length("siteAddressBefore") <= 500)
    AND ("siteAddressAfter" IS NULL OR char_length("siteAddressAfter") <= 500)
    AND ("reason" IS NULL OR (char_length("reason") <= 1000 AND btrim("reason") <> '' AND "reason" = btrim("reason"))))
);
CREATE UNIQUE INDEX "ServiceCaseDetailChange_businessId_id_key" ON "ServiceCaseDetailChange"("businessId", "id");
CREATE UNIQUE INDEX "ServiceCaseDetailChange_businessId_caseId_caseVersion_key" ON "ServiceCaseDetailChange"("businessId", "caseId", "caseVersion");
ALTER TABLE "ServiceCaseDetailChange" ADD CONSTRAINT "ServiceCaseDetailChange_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceCaseDetailChange" ADD CONSTRAINT "ServiceCaseDetailChange_case_tenant_fkey"
  FOREIGN KEY ("businessId", "caseId") REFERENCES "ServiceCase"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
-- its journal event (same case, seq = caseVersion); deferred, so the event and this row may be written in either order
ALTER TABLE "ServiceCaseDetailChange" ADD CONSTRAINT "ServiceCaseDetailChange_event_fkey"
  FOREIGN KEY ("businessId", "caseId", "caseVersion") REFERENCES "ServiceCaseEvent"("businessId", "caseId", "seq")
  ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "ServiceCaseDetailChange" ADD CONSTRAINT "ServiceCaseDetailChange_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TRIGGER "ServiceCompletion_user_same_business"
  BEFORE INSERT OR UPDATE OF "businessId", "actorUserId" ON "ServiceCompletion"
  FOR EACH ROW EXECUTE FUNCTION public.service_user_same_business('actorUserId');
CREATE TRIGGER "ServiceCaseDetailChange_user_same_business"
  BEFORE INSERT OR UPDATE OF "businessId", "actorUserId" ON "ServiceCaseDetailChange"
  FOR EACH ROW EXECUTE FUNCTION public.service_user_same_business('actorUserId');

-- ── 6. Journal: the three new actions ───────────────────────────────────────────────────────────────────────
-- Each action only with its own event type; RESCHEDULE keeps the case SCHEDULED; CHANGE_DETAILS keeps OPEN / SCHEDULED
-- or unschedules (SCHEDULED → OPEN, D13 — the only way back in the machine); COMPLETE closes a WORK_DONE case. All by
-- the owner. Compared as text: the new enum values are not used before this transaction ends.
ALTER TABLE "ServiceCaseEvent" ADD CONSTRAINT "ServiceCaseEvent_tracks_in_place" CHECK (
      ("action"::text IN ('RESCHEDULE', 'COMPLETE', 'CHANGE_DETAILS'))
    = ("eventType"::text IN ('case.rescheduled', 'case.completed', 'case.details_changed'))
  AND ("action"::text <> 'RESCHEDULE' OR "eventType"::text = 'case.rescheduled')
  AND ("action"::text <> 'COMPLETE' OR "eventType"::text = 'case.completed')
  AND ("action"::text <> 'CHANGE_DETAILS' OR "eventType"::text = 'case.details_changed')
  AND ("action"::text NOT IN ('RESCHEDULE', 'COMPLETE', 'CHANGE_DETAILS') OR (
            "holdReasonBefore" IS NOT DISTINCT FROM "holdReasonAfter"
        AND "cancellationRequestedBefore" = "cancellationRequestedAfter"
        AND "actor" = 'OWNER_USER'))
  AND ("action"::text <> 'RESCHEDULE' OR ("fromStatus"::text = 'SCHEDULED' AND "toStatus"::text = 'SCHEDULED'))
  AND ("action"::text <> 'CHANGE_DETAILS' OR (
            "fromStatus"::text IN ('OPEN', 'SCHEDULED')
        AND ("toStatus" = "fromStatus" OR ("fromStatus"::text = 'SCHEDULED' AND "toStatus"::text = 'OPEN'))))
  AND ("action"::text <> 'COMPLETE' OR ("fromStatus"::text = 'WORK_DONE' AND "toStatus"::text = 'CLOSED'))) NOT VALID;
ALTER TABLE "ServiceCaseEvent" VALIDATE CONSTRAINT "ServiceCaseEvent_tracks_in_place";

-- ── 7. Guards ───────────────────────────────────────────────────────────────────────────────────────────────
-- The erasure scrub of this migration's columns runs only inside service_tracks_erase_business() (marker + table owner,
-- the foundation's convention: app_runtime can set the marker, never become the owner).
CREATE OR REPLACE FUNCTION public.service_tracks_in_erasure(p_relid oid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT current_setting('dubiz.service_tracks_erasure', true) = 'on'
     AND current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = p_relid)
$fn$;
REVOKE ALL ON FUNCTION public.service_tracks_in_erasure(oid) FROM PUBLIC;

-- 7.1 ⚠ service_case_guard — CREATE OR REPLACE. Body = 20261112090000_service_desk_foundation section 9.2 (the only
-- definition), with exactly these changes:
--   a. "kind" leaves the identity list; kind, workType, serviceLocation, siteAddress and returnReason (the D3 "details";
--      returnReason by section כב) change only under D3 (section ט, owner-approved):
--        - OLD.status is OPEN or SCHEDULED (blocker 1) and the new status is the same or OPEN (UNSCHEDULE, D13);
--        - no cancel request, not erased (blocker 10), no cover recorded (blocker 5);
--        - none of these rows exists for the case (blockers 2, 4, 6, 7, 8, 9): an intake-terms snapshot, a signed intake,
--          a SENT / APPROVED quote, a presented warranty offer, a part that is not CANCELLED, a supplier work, a
--          handover, a completion;
--        - leaving AT_BUSINESS (the effective place: serviceLocation, or derived from kind) is refused while an unsigned
--          intake or an intake photo exists (blocker 3, D12) — the work type may still change;
--        - blocker 11 (an appointment that already took place) is NOT read here: open point D16 (the Appointment module
--          is not touched); the server enforces it.
--      A case opened before M1 (NULL work type / place) gets explicit values under the same rule. A case past intake
--      stays fixed exactly as today. The blocker tables are read with the case row already locked by this UPDATE.
--   b. D14: profileKey / profileSnapshot never change after the insert (a case without a snapshot keeps today's rules).
--   c. completionType / completedAt are written once.
--   d. the tracks erasure (service_tracks_erase_business: marker + owner) may blank siteAddress (to NULL only).
-- Everything else is byte-for-byte the foundation body.
CREATE OR REPLACE FUNCTION public.service_case_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  in_erasure boolean :=
        current_setting('dubiz.service_erasure', true) = 'on'
    AND current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID);
  in_tracks_erasure boolean := public.service_tracks_in_erasure(TG_RELID);
  details_changed boolean;
  old_place text;
  new_place text;
BEGIN
  IF NEW."id" <> OLD."id" OR NEW."businessId" <> OLD."businessId" OR NEW."caseNumber" <> OLD."caseNumber"
     OR NEW."customerId" <> OLD."customerId"
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

  -- (b) D14: the profile snapshot of the opening is fixed.
  IF NEW."profileKey" IS DISTINCT FROM OLD."profileKey" OR NEW."profileSnapshot" IS DISTINCT FROM OLD."profileSnapshot" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS01', MESSAGE = 'SERVICE_CASE_PROFILE_FIXED: the profile snapshot is taken at the opening and never changes';
  END IF;
  -- (c) the completion stamp is written once.
  IF (OLD."completionType" IS NOT NULL AND NEW."completionType" IS DISTINCT FROM OLD."completionType")
     OR (OLD."completedAt" IS NOT NULL AND NEW."completedAt" IS DISTINCT FROM OLD."completedAt") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS01', MESSAGE = 'SERVICE_CASE_COMPLETION_WRITE_ONCE: completionType / completedAt are written once';
  END IF;

  -- (a) D3: the details change only before the work started, and never past a binding action.
  details_changed :=
       NEW."kind"::text IS DISTINCT FROM OLD."kind"::text
    OR NEW."workType" IS DISTINCT FROM OLD."workType"
    OR NEW."serviceLocation" IS DISTINCT FROM OLD."serviceLocation"
    OR NEW."returnReason" IS DISTINCT FROM OLD."returnReason"
    OR (NEW."siteAddress" IS DISTINCT FROM OLD."siteAddress" AND NOT (in_tracks_erasure AND NEW."siteAddress" IS NULL));
  IF details_changed THEN
    IF OLD."status"::text NOT IN ('OPEN', 'SCHEDULED') OR NEW."status"::text NOT IN (OLD."status"::text, 'OPEN') THEN
      RAISE EXCEPTION USING ERRCODE = 'DZS01', MESSAGE = format('SERVICE_CASE_DETAILS_FIXED: the case is %s; work type, place, address and kind change only while OPEN or SCHEDULED', OLD."status");
    END IF;
    IF OLD."cancellationRequested" OR OLD."erasedAt" IS NOT NULL OR OLD."coverageSource" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'DZS01', MESSAGE = 'SERVICE_CASE_DETAILS_FIXED: a cancel request, an erasure or a recorded cover fixes the details';
    END IF;
    IF EXISTS (SELECT 1 FROM public."ServiceIntakeTermsSnapshot" s WHERE s."businessId" = OLD."businessId" AND s."caseId" = OLD."id")
       OR EXISTS (SELECT 1 FROM public."ServiceCaseIntake" i WHERE i."businessId" = OLD."businessId" AND i."caseId" = OLD."id" AND i."signedAt" IS NOT NULL)
       OR EXISTS (SELECT 1 FROM public."ServiceQuote" q WHERE q."businessId" = OLD."businessId" AND q."caseId" = OLD."id" AND q."state" IN ('SENT', 'APPROVED'))
       OR EXISTS (SELECT 1 FROM public."ServiceWarrantyOffer" w WHERE w."businessId" = OLD."businessId" AND w."caseId" = OLD."id" AND w."presentedAt" IS NOT NULL)
       OR EXISTS (SELECT 1 FROM public."ServicePart" p WHERE p."businessId" = OLD."businessId" AND p."caseId" = OLD."id" AND p."state" <> 'CANCELLED')
       OR EXISTS (SELECT 1 FROM public."ServiceExternalWork" x WHERE x."businessId" = OLD."businessId" AND x."caseId" = OLD."id")
       OR EXISTS (SELECT 1 FROM public."ServiceHandover" h WHERE h."businessId" = OLD."businessId" AND h."caseId" = OLD."id")
       OR EXISTS (SELECT 1 FROM public."ServiceCompletion" k WHERE k."businessId" = OLD."businessId" AND k."caseId" = OLD."id") THEN
      RAISE EXCEPTION USING ERRCODE = 'DZS01', MESSAGE = 'SERVICE_CASE_DETAILS_FIXED: a binding action exists (intake terms, signed intake, quote, warranty offer, part, supplier work, handover or completion)';
    END IF;
    old_place := COALESCE(OLD."serviceLocation"::text, CASE OLD."kind"::text WHEN 'IN_SHOP' THEN 'AT_BUSINESS' WHEN 'REMOTE' THEN 'REMOTE' ELSE 'AT_CUSTOMER' END);
    new_place := COALESCE(NEW."serviceLocation"::text, CASE NEW."kind"::text WHEN 'IN_SHOP' THEN 'AT_BUSINESS' WHEN 'REMOTE' THEN 'REMOTE' ELSE 'AT_CUSTOMER' END);
    IF old_place = 'AT_BUSINESS' AND new_place <> 'AT_BUSINESS' AND (
         EXISTS (SELECT 1 FROM public."ServiceCaseIntake" i WHERE i."businessId" = OLD."businessId" AND i."caseId" = OLD."id")
      OR EXISTS (SELECT 1 FROM public."ServiceIntakePhoto" f WHERE f."businessId" = OLD."businessId" AND f."caseId" = OLD."id")) THEN
      RAISE EXCEPTION USING ERRCODE = 'DZS01', MESSAGE = 'SERVICE_CASE_DETAILS_FIXED: an intake was started at the business; the case cannot leave AT_BUSINESS (D12)';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_case_guard() FROM PUBLIC;

-- 7.2 A details change, and an unscheduling (SCHEDULED → OPEN), is journaled (section ט "DB, mandatory journal"): at
-- COMMIT the case's new version has a CHANGE_DETAILS event and a ServiceCaseDetailChange row; the version moved. A
-- change without them is rolled back whole. The account erasure (business being deleted, only the address blanked) is
-- exempt. Fails closed: rows the transaction cannot see count as missing.
CREATE OR REPLACE FUNCTION public.service_case_details_journaled()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF NOT (NEW."kind"::text IS DISTINCT FROM OLD."kind"::text
       OR NEW."workType" IS DISTINCT FROM OLD."workType"
       OR NEW."serviceLocation" IS DISTINCT FROM OLD."serviceLocation"
       OR NEW."returnReason" IS DISTINCT FROM OLD."returnReason"
       OR NEW."siteAddress" IS DISTINCT FROM OLD."siteAddress"
       OR (OLD."status"::text = 'SCHEDULED' AND NEW."status"::text = 'OPEN')) THEN
    RETURN NULL;
  END IF;
  -- the erasure: only the address blanked, for a business being deleted
  IF NEW."siteAddress" IS NULL
     AND NOT (NEW."kind"::text IS DISTINCT FROM OLD."kind"::text OR NEW."workType" IS DISTINCT FROM OLD."workType"
              OR NEW."serviceLocation" IS DISTINCT FROM OLD."serviceLocation" OR NEW."returnReason" IS DISTINCT FROM OLD."returnReason"
              OR NEW."status" IS DISTINCT FROM OLD."status")
     AND EXISTS (SELECT 1 FROM public."Business" b WHERE b."id" = NEW."businessId"
                   AND (b."deletionRequestedAt" IS NOT NULL OR b."deletedAt" IS NOT NULL)) THEN
    RETURN NULL;
  END IF;
  IF NEW."version" <= OLD."version"
     OR NOT EXISTS (SELECT 1 FROM public."ServiceCaseEvent" e
                     WHERE e."businessId" = NEW."businessId" AND e."caseId" = NEW."id" AND e."seq" = NEW."version"
                       AND e."action"::text = 'CHANGE_DETAILS')
     OR NOT EXISTS (SELECT 1 FROM public."ServiceCaseDetailChange" d
                     WHERE d."businessId" = NEW."businessId" AND d."caseId" = NEW."id" AND d."caseVersion" = NEW."version") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS01',
      MESSAGE = format('SERVICE_CASE_DETAILS_NOT_JOURNALED: case %s changed its details without a case.details_changed event and its detail record at version %s', NEW."id", NEW."version");
  END IF;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_case_details_journaled() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER "ServiceCase_details_journaled"
  AFTER UPDATE OF "kind", "workType", "serviceLocation", "siteAddress", "returnReason", "status" ON "ServiceCase"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.service_case_details_journaled();

-- 7.3 A completion stamp on the case has its ServiceCompletion record, of the same type (checked at COMMIT).
CREATE OR REPLACE FUNCTION public.service_case_completion_recorded()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF NEW."completionType" IS NOT NULL AND OLD."completionType" IS NULL
     AND NOT EXISTS (SELECT 1 FROM public."ServiceCompletion" k
                      WHERE k."businessId" = NEW."businessId" AND k."caseId" = NEW."id" AND k."completionType" = NEW."completionType") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS07', MESSAGE = format('SERVICE_COMPLETION_MISSING: case %s was completed without its completion record', NEW."id");
  END IF;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_case_completion_recorded() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER "ServiceCase_completion_recorded" AFTER UPDATE OF "completionType" ON "ServiceCase"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.service_case_completion_recorded();

-- 7.4 ServiceCompletion: written once for a WORK_DONE case (in the COMPLETE transaction), by an owner user, then
-- immutable like ServiceHandover — UPDATE only by the tracks erasure (personal fields to NULL, erasedAt set) or the FK
-- action of a deleted user; DELETE only by the cascade of a deleted business; TRUNCATE never. At COMMIT the case is
-- CLOSED with the same completion type.
CREATE OR REPLACE FUNCTION public.service_completion_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  erasable constant text[] := ARRAY['confirmedByName', 'note', 'actorUserId', 'erasedAt'];
  v_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF public.service_tracks_in_erasure(TG_RELID)
       AND (to_jsonb(NEW) - erasable) = (to_jsonb(OLD) - erasable)
       AND NEW."confirmedByName" IS NULL AND NEW."note" IS NULL AND NEW."actorUserId" IS NULL AND NEW."erasedAt" IS NOT NULL THEN
      RETURN NEW;
    END IF;
    IF pg_trigger_depth() > 1 AND NEW."actorUserId" IS NULL
       AND (to_jsonb(NEW) - 'actorUserId') = (to_jsonb(OLD) - 'actorUserId') THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NOT public.service_ui_business_writable(NEW."businessId") THEN
      RAISE EXCEPTION USING ERRCODE = 'DZU02', MESSAGE = 'SERVICE_UI_BUSINESS_DELETING: the business is being deleted; nothing was written';
    END IF;
    IF NEW."erasedAt" IS NOT NULL OR NEW."actorUserId" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'DZS07', MESSAGE = 'SERVICE_COMPLETION_NEW: a completion is confirmed by an owner user and never born erased';
    END IF;
    SELECT c."status"::text INTO v_status FROM public."ServiceCase" c
     WHERE c."businessId" = NEW."businessId" AND c."id" = NEW."caseId" FOR UPDATE;
    IF v_status IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'DZS07', MESSAGE = 'SERVICE_COMPLETION_CASE: no such case in this business';
    END IF;
    IF v_status NOT IN ('WORK_DONE', 'CLOSED') THEN
      RAISE EXCEPTION USING ERRCODE = 'DZS07', MESSAGE = format('SERVICE_COMPLETION_NOT_WORK_DONE: the case is %s; only a WORK_DONE case is completed', v_status);
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'DZS07',
    MESSAGE = format('SERVICE_COMPLETION_FIXED: %s on %I is refused; a completion is a permanent record', TG_OP, TG_TABLE_NAME);
END
$fn$;
REVOKE ALL ON FUNCTION public.service_completion_guard() FROM PUBLIC;
CREATE TRIGGER "ServiceCompletion_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ServiceCompletion"
  FOR EACH ROW EXECUTE FUNCTION public.service_completion_guard();
CREATE TRIGGER "ServiceCompletion_no_truncate" BEFORE TRUNCATE ON "ServiceCompletion"
  FOR EACH STATEMENT EXECUTE FUNCTION public.service_journal_truncate_guard();

CREATE OR REPLACE FUNCTION public.service_completion_matches_case()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."ServiceCase" c
                  WHERE c."businessId" = NEW."businessId" AND c."id" = NEW."caseId"
                    AND c."status"::text = 'CLOSED' AND c."completionType" = NEW."completionType") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS07',
      MESSAGE = format('SERVICE_COMPLETION_CASE_NOT_CLOSED: completion %s needs its case CLOSED with the same completion type', NEW."id");
  END IF;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_completion_matches_case() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER "ServiceCompletion_matches_case" AFTER INSERT ON "ServiceCompletion"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.service_completion_matches_case();

-- 7.5 ServiceCaseDetailChange: append-only. INSERT by an owner user while the business is writable; at COMMIT its
-- journal event (deferred FK) is a CHANGE_DETAILS by that user and, while the case is still at that version, the
-- after-values are the case's. UPDATE only by the tracks erasure or the FK action of a deleted user; DELETE only by a
-- cascade; TRUNCATE never.
CREATE OR REPLACE FUNCTION public.service_detail_change_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  erasable constant text[] := ARRAY['reason', 'actorUserId', 'siteAddressBefore', 'siteAddressAfter', 'erasedAt'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF public.service_tracks_in_erasure(TG_RELID)
       AND (to_jsonb(NEW) - erasable) = (to_jsonb(OLD) - erasable)
       AND NEW."reason" IS NULL AND NEW."actorUserId" IS NULL AND NEW."siteAddressBefore" IS NULL AND NEW."siteAddressAfter" IS NULL
       AND NEW."erasedAt" IS NOT NULL THEN
      RETURN NEW;
    END IF;
    IF pg_trigger_depth() > 1 AND NEW."actorUserId" IS NULL
       AND (to_jsonb(NEW) - 'actorUserId') = (to_jsonb(OLD) - 'actorUserId') THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NOT public.service_ui_business_writable(NEW."businessId") THEN
      RAISE EXCEPTION USING ERRCODE = 'DZU02', MESSAGE = 'SERVICE_UI_BUSINESS_DELETING: the business is being deleted; nothing was written';
    END IF;
    IF NEW."erasedAt" IS NOT NULL OR NEW."actorUserId" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'DZS06', MESSAGE = 'SERVICE_DETAIL_CHANGE_NEW: a details change records its owner user and is never born erased';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'DZS06',
    MESSAGE = format('SERVICE_DETAIL_CHANGE_APPEND_ONLY: %s on %I is refused; the details history is append-only', TG_OP, TG_TABLE_NAME);
END
$fn$;
REVOKE ALL ON FUNCTION public.service_detail_change_guard() FROM PUBLIC;
CREATE TRIGGER "ServiceCaseDetailChange_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ServiceCaseDetailChange"
  FOR EACH ROW EXECUTE FUNCTION public.service_detail_change_guard();
CREATE TRIGGER "ServiceCaseDetailChange_no_truncate" BEFORE TRUNCATE ON "ServiceCaseDetailChange"
  FOR EACH STATEMENT EXECUTE FUNCTION public.service_journal_truncate_guard();

CREATE OR REPLACE FUNCTION public.service_detail_change_matches()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  c record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."ServiceCaseEvent" e
                  WHERE e."businessId" = NEW."businessId" AND e."caseId" = NEW."caseId" AND e."seq" = NEW."caseVersion"
                    AND e."action"::text = 'CHANGE_DETAILS' AND e."actorUserId" IS NOT DISTINCT FROM NEW."actorUserId") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS06',
      MESSAGE = format('SERVICE_DETAIL_CHANGE_EVENT: detail record %s needs a CHANGE_DETAILS event by the same user at seq %s', NEW."id", NEW."caseVersion");
  END IF;
  SELECT "version", "kind"::text AS kind, "workType", "serviceLocation", "returnReason", "siteAddress" INTO c
    FROM public."ServiceCase" WHERE "businessId" = NEW."businessId" AND "id" = NEW."caseId";
  IF FOUND AND c."version" = NEW."caseVersion" AND (
       c.kind IS DISTINCT FROM NEW."kindAfter"::text OR c."workType" IS DISTINCT FROM NEW."workTypeAfter"
    OR c."serviceLocation" IS DISTINCT FROM NEW."serviceLocationAfter" OR c."returnReason" IS DISTINCT FROM NEW."returnReasonAfter"
    OR c."siteAddress" IS DISTINCT FROM NEW."siteAddressAfter") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS06',
      MESSAGE = format('SERVICE_DETAIL_CHANGE_MISMATCH: detail record %s must hold the case''s values after the change', NEW."id");
  END IF;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_detail_change_matches() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER "ServiceCaseDetailChange_matches" AFTER INSERT ON "ServiceCaseDetailChange"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.service_detail_change_matches();

-- ── 8. Erasure (account deletion) ───────────────────────────────────────────────────────────────────────────
-- CONTRACT: no arguments; the business is the tenant context. Refuses (DZS08, nothing changed) without a context or
-- when that business is not being deleted. Otherwise blanks IN PLACE, for that business only, every personal / free
-- text this migration added:
--   ServiceCase              siteAddress, siteNotes, originalSaleRef (free text typed by the owner)
--   ServiceDevice            displayName, attributes (a subject's name, plate / VIN / free attributes can identify a
--                            person — blanked; subjectKind stays)
--   ServiceCompletion        confirmedByName, note, actorUserId; erasedAt stamped
--   ServiceCaseDetailChange  reason, actorUserId, siteAddressBefore / After; erasedAt stamped
-- Kept: work type, place, kind, return reason, resolution, completion type and times, the profile snapshot (the
-- business's rules — no personal data), field-name lists. ServiceSettings.profileOverrides goes with the settings row
-- (service_desk_ui_erase_business, #1061). Call it in the purge transaction with the other Service Desk erase functions
-- (order-independent). Re-run safe: returns the rows touched (0 the second time).
CREATE OR REPLACE FUNCTION public.service_tracks_erase_business()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_business integer := NULLIF(current_setting('app.current_business_id', true), '')::integer;
  v_n integer := 0;
  v_k integer;
BEGIN
  IF v_business IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS08', MESSAGE = 'SERVICE_TRACKS_ERASURE_NO_CONTEXT: no tenant context; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."Business" b WHERE b."id" = v_business
                   AND (b."deletionRequestedAt" IS NOT NULL OR b."deletedAt" IS NOT NULL)) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS08', MESSAGE = 'SERVICE_TRACKS_ERASURE_NOT_DELETING: the business is not being deleted; nothing was changed';
  END IF;
  PERFORM set_config('dubiz.service_tracks_erasure', 'on', true);

  UPDATE public."ServiceCase" SET "siteAddress" = NULL, "siteNotes" = NULL, "originalSaleRef" = NULL
   WHERE "businessId" = v_business AND ("siteAddress" IS NOT NULL OR "siteNotes" IS NOT NULL OR "originalSaleRef" IS NOT NULL);
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;
  UPDATE public."ServiceDevice" SET "displayName" = NULL, "attributes" = NULL
   WHERE "businessId" = v_business AND ("displayName" IS NOT NULL OR "attributes" IS NOT NULL);
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;
  UPDATE public."ServiceCompletion" SET "confirmedByName" = NULL, "note" = NULL, "actorUserId" = NULL, "erasedAt" = CURRENT_TIMESTAMP
   WHERE "businessId" = v_business AND "erasedAt" IS NULL;
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;
  UPDATE public."ServiceCaseDetailChange" SET "reason" = NULL, "actorUserId" = NULL, "siteAddressBefore" = NULL, "siteAddressAfter" = NULL,
         "erasedAt" = CURRENT_TIMESTAMP
   WHERE "businessId" = v_business AND "erasedAt" IS NULL;
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;

  PERFORM set_config('dubiz.service_tracks_erasure', 'off', true);
  RETURN v_n;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_tracks_erase_business() FROM PUBLIC;

-- ── 9. Row-level security — per operation, no DELETE / UPDATE policy (UPDATE only by the owner-run erasure) ──
ALTER TABLE "ServiceCompletion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ServiceCompletion" FORCE ROW LEVEL SECURITY;
CREATE POLICY service_completion_tenant_select ON "ServiceCompletion" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_completion_tenant_insert ON "ServiceCompletion" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_completion_tenant_update ON "ServiceCompletion" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "ServiceCaseDetailChange" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ServiceCaseDetailChange" FORCE ROW LEVEL SECURITY;
CREATE POLICY service_detail_change_tenant_select ON "ServiceCaseDetailChange" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_detail_change_tenant_insert ON "ServiceCaseDetailChange" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_detail_change_tenant_update ON "ServiceCaseDetailChange" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── 10. Privileges — named explicitly ───────────────────────────────────────────────────────────────────────
REVOKE ALL ON "ServiceCompletion", "ServiceCaseDetailChange" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "ServiceCompletion_id_seq", "ServiceCaseDetailChange_id_seq" FROM PUBLIC;
DO $do$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT c.oid::regclass::text AS rel, pg_get_userbyid(x.grantee) AS grantee, c.relkind
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
     WHERE c.relname IN ('ServiceCompletion', 'ServiceCaseDetailChange', 'ServiceCompletion_id_seq', 'ServiceCaseDetailChange_id_seq')
       AND c.relnamespace = 'public'::regnamespace
       AND x.grantee <> c.relowner AND x.grantee <> 0
  LOOP
    IF r.relkind = 'S' THEN
      EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM %I', r.rel, r.grantee);
    ELSE
      EXECUTE format('REVOKE ALL ON TABLE %s FROM %I', r.rel, r.grantee);
    END IF;
  END LOOP;
END
$do$;
-- Permanent records: read and add, nothing else (the existing ServiceCase / ServiceDevice / ServiceSettings grants
-- cover their new columns).
GRANT SELECT, INSERT ON "ServiceCompletion", "ServiceCaseDetailChange" TO app_runtime;
GRANT USAGE, SELECT ON SEQUENCE "ServiceCompletion_id_seq", "ServiceCaseDetailChange_id_seq" TO app_runtime;
GRANT EXECUTE ON FUNCTION public.service_tracks_erase_business() TO app_runtime;
-- invoker helper the guards call
GRANT EXECUTE ON FUNCTION public.service_tracks_in_erasure(oid) TO app_runtime;
