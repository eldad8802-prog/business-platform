-- ============================================================================================================
-- 20261120090000_service_desk_ui_foundation — Service Desk 1.3-0 / PR-1: the data + storage foundation the service
-- screens need (settings, versioned terms texts, warranty offers, intake photos, share journal, phone reminders,
-- the durable storage-erasure job). Owner-approved plan v4 (2026-11-08), decisions ו1–ו6.
--
-- PR-1 of the migration-first rule: this migration and its lab only. No schema.prisma, no runtime code, the flag
-- seeded OFF. Expand-only: EIGHT new tables, TEN new enum types, their own functions. No existing table, column,
-- constraint, policy, grant, row or function is altered — 1.2a / 1.2b / M2 tables are only REFERENCED (foreign keys,
-- reads inside new triggers). Billing, inventory and WhatsApp are not touched.
--
--   "ServiceTextVersion"          versioned texts of a business: service terms (TERMS) and the fixed sentence about
--                                 rights under law (STATUTORY_NOTICE). A version is written once; its body never
--                                 changes; legal status DRAFT → LEGALLY_APPROVED once (ו4: a draft is never shown to
--                                 a real customer as approved terms).
--   "ServiceSettings"             one row per business: default technician (מ2), warranty template (מ3, optional),
--                                 active terms / statutory-notice versions.
--   "ServiceIntakeTermsSnapshot"  the exact approved texts a customer was shown at intake (version + sha256), once
--                                 per case, before the intake is signed (מ7: immutable record; later versions never
--                                 change it).
--   "ServiceWarrantyOffer"        commercial warranty offered for a case: DRAFT → PRESENTED → LOCKED (at handover)
--                                 → SUPERSEDED. Content is fixed once presented; a change after presentation is a
--                                 NEW offer with a reason; a customer-adverse change needs the customer's renewed
--                                 agreement (ו2); after handover only an extension (same scope, same start, later end).
--   "ServiceIntakePhoto"          intake photos in the private storage domain `service` (key bound to business, case
--                                 and content hash), at most 10 per case, frozen once the intake is signed.
--   "ServiceShareEvent"           append-only: a stored file (sent quote PDF / intake slip) was handed to a share
--                                 channel — the bytes' sha256 equals the stored copy's. Never "the customer received".
--   "ServicePhoneReminder"        append-only: a documented pickup call (date+time, who, outcome) — ו3.
--   "ServiceStorageErasure"       one row per business being deleted: the durable job that deletes `service` objects
--                                 only AFTER the purge transaction committed, resumable, DONE only when the listing
--                                 is empty and the quarantine is older than one hour (ו1).
--
-- Upload / write refusal while a business is being deleted: every insert / update of the new tables is refused once
-- Business.deletionRequestedAt / deletedAt is set or an erasure job exists (the erasure scrub excepted).
-- SECURITY DEFINER: three new functions — service_desk_ui_erase_business(), service_storage_erasure_due(),
-- service_storage_erasure_record_pass() — search_path … pg_temp last, EXECUTE only for app_runtime.
-- No DELETE for the runtime anywhere; journals are append-only. Every change of a case-scoped row locks the case
-- row FOR UPDATE first (1.2b / M2 convention).
-- ============================================================================================================

-- ── 0. Premises ─────────────────────────────────────────────────────────────────────────────────────────────
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    RAISE EXCEPTION 'SERVICE_DESK_UI: role app_runtime is missing; nothing was changed';
  END IF;
  IF to_regclass('public."ServiceCase"') IS NULL OR to_regclass('public."ServiceCaseIntake"') IS NULL
     OR to_regclass('public."ServiceQuote"') IS NULL OR to_regclass('public."ServiceHandover"') IS NULL THEN
    RAISE EXCEPTION 'SERVICE_DESK_UI: the Service Desk foundation (20261112090000) is missing; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ServiceCase_businessId_id_key')
     OR NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ServiceQuote_businessId_caseId_version_key')
     OR NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'StaffMember_businessId_id_key') THEN
    RAISE EXCEPTION 'SERVICE_DESK_UI: a composite key this migration references is missing; nothing was changed';
  END IF;
  IF to_regprocedure('public.service_user_same_business()') IS NULL OR to_regprocedure('public.service_journal_truncate_guard()') IS NULL THEN
    RAISE EXCEPTION 'SERVICE_DESK_UI: the foundation trigger functions are missing; nothing was changed';
  END IF;
END
$do$;
SET lock_timeout = '5s';

-- ── 1. Types ────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TYPE "ServiceTextKind" AS ENUM ('TERMS', 'STATUTORY_NOTICE');
CREATE TYPE "ServiceTextLegalStatus" AS ENUM ('DRAFT', 'LEGALLY_APPROVED');
CREATE TYPE "ServiceDurationUnit" AS ENUM ('DAYS', 'MONTHS');
CREATE TYPE "ServiceWarrantyOfferState" AS ENUM ('DRAFT', 'PRESENTED', 'LOCKED', 'SUPERSEDED');
CREATE TYPE "ServiceWarrantyOfferSource" AS ENUM ('INTAKE', 'QUOTE', 'HANDOVER');
CREATE TYPE "ServiceReaffirmMethod" AS ENUM ('PHONE', 'IN_PERSON');
CREATE TYPE "ServiceShareObjectKind" AS ENUM ('QUOTE_PDF', 'INTAKE_SLIP');
CREATE TYPE "ServiceShareChannel" AS ENUM ('DOWNLOAD', 'SHARE_SHEET', 'WHATSAPP_MANUAL');
CREATE TYPE "ServicePhoneReminderOutcome" AS ENUM ('REACHED', 'LEFT_MESSAGE', 'NO_ANSWER');
CREATE TYPE "ServiceStorageErasureState" AS ENUM ('PENDING_OBJECTS', 'DONE');

-- ── 2. Tables ───────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "ServiceTextVersion" (
  "id"                      SERIAL NOT NULL,
  "businessId"              INTEGER NOT NULL,
  "kind"                    "ServiceTextKind" NOT NULL,
  "version"                 INTEGER NOT NULL,
  "body"                    TEXT NOT NULL,
  "bodySha256"              CHAR(64) NOT NULL,
  "legalStatus"             "ServiceTextLegalStatus" NOT NULL DEFAULT 'DRAFT',
  "legallyApprovedAt"       TIMESTAMP(3),
  "legallyApprovedByUserId" INTEGER,
  "createdByUserId"         INTEGER,
  "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "erasedAt"                TIMESTAMP(3),
  CONSTRAINT "ServiceTextVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ServiceTextVersion_version" CHECK ("version" >= 1),
  CONSTRAINT "ServiceTextVersion_body" CHECK (char_length("body") BETWEEN 1 AND 20000),
  CONSTRAINT "ServiceTextVersion_sha" CHECK ("bodySha256" = encode(sha256(convert_to("body", 'UTF8')), 'hex')),
  CONSTRAINT "ServiceTextVersion_approved" CHECK (("legalStatus" = 'LEGALLY_APPROVED') = ("legallyApprovedAt" IS NOT NULL))
);
CREATE UNIQUE INDEX "ServiceTextVersion_businessId_id_key" ON "ServiceTextVersion"("businessId", "id");
CREATE UNIQUE INDEX "ServiceTextVersion_businessId_kind_version_key" ON "ServiceTextVersion"("businessId", "kind", "version");
ALTER TABLE "ServiceTextVersion" ADD CONSTRAINT "ServiceTextVersion_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceTextVersion" ADD CONSTRAINT "ServiceTextVersion_legallyApprovedByUserId_fkey"
  FOREIGN KEY ("legallyApprovedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ServiceTextVersion" ADD CONSTRAINT "ServiceTextVersion_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ServiceSettings" (
  "businessId"                     INTEGER NOT NULL,
  "defaultStaffMemberId"           INTEGER,
  "warrantyTemplateValue"          INTEGER,
  "warrantyTemplateUnit"           "ServiceDurationUnit",
  "warrantyTemplateScope"          TEXT,
  "warrantyTemplateExclusions"     TEXT,
  "activeTermsVersionId"           INTEGER,
  "activeStatutoryNoticeVersionId" INTEGER,
  "version"                        INTEGER NOT NULL DEFAULT 1,
  "createdAt"                      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ServiceSettings_pkey" PRIMARY KEY ("businessId"),
  CONSTRAINT "ServiceSettings_version" CHECK ("version" >= 1),
  CONSTRAINT "ServiceSettings_template" CHECK (
    ("warrantyTemplateValue" IS NULL AND "warrantyTemplateUnit" IS NULL AND "warrantyTemplateScope" IS NULL AND "warrantyTemplateExclusions" IS NULL)
    OR ("warrantyTemplateValue" IS NOT NULL AND "warrantyTemplateUnit" IS NOT NULL AND "warrantyTemplateScope" IS NOT NULL
        AND (("warrantyTemplateUnit" = 'DAYS' AND "warrantyTemplateValue" BETWEEN 1 AND 3650)
          OR ("warrantyTemplateUnit" = 'MONTHS' AND "warrantyTemplateValue" BETWEEN 1 AND 120)))),
  CONSTRAINT "ServiceSettings_texts" CHECK (
    ("warrantyTemplateScope" IS NULL OR char_length("warrantyTemplateScope") BETWEEN 1 AND 2000)
    AND ("warrantyTemplateExclusions" IS NULL OR char_length("warrantyTemplateExclusions") BETWEEN 1 AND 2000))
);
ALTER TABLE "ServiceSettings" ADD CONSTRAINT "ServiceSettings_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceSettings" ADD CONSTRAINT "ServiceSettings_defaultStaffMember_fkey"
  FOREIGN KEY ("businessId", "defaultStaffMemberId") REFERENCES "StaffMember"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServiceSettings" ADD CONSTRAINT "ServiceSettings_activeTerms_fkey"
  FOREIGN KEY ("businessId", "activeTermsVersionId") REFERENCES "ServiceTextVersion"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServiceSettings" ADD CONSTRAINT "ServiceSettings_activeStatutory_fkey"
  FOREIGN KEY ("businessId", "activeStatutoryNoticeVersionId") REFERENCES "ServiceTextVersion"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE TABLE "ServiceIntakeTermsSnapshot" (
  "id"                       SERIAL NOT NULL,
  "businessId"               INTEGER NOT NULL,
  "caseId"                   INTEGER NOT NULL,
  "termsVersionId"           INTEGER NOT NULL,
  "termsSha256"              CHAR(64) NOT NULL,
  "statutoryNoticeVersionId" INTEGER NOT NULL,
  "statutorySha256"          CHAR(64) NOT NULL,
  "presentedAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "presentedByUserId"        INTEGER,
  "erasedAt"                 TIMESTAMP(3),
  CONSTRAINT "ServiceIntakeTermsSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ServiceIntakeTermsSnapshot_businessId_caseId_key" ON "ServiceIntakeTermsSnapshot"("businessId", "caseId");
ALTER TABLE "ServiceIntakeTermsSnapshot" ADD CONSTRAINT "ServiceIntakeTermsSnapshot_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceIntakeTermsSnapshot" ADD CONSTRAINT "ServiceIntakeTermsSnapshot_case_fkey"
  FOREIGN KEY ("businessId", "caseId") REFERENCES "ServiceCase"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServiceIntakeTermsSnapshot" ADD CONSTRAINT "ServiceIntakeTermsSnapshot_terms_fkey"
  FOREIGN KEY ("businessId", "termsVersionId") REFERENCES "ServiceTextVersion"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServiceIntakeTermsSnapshot" ADD CONSTRAINT "ServiceIntakeTermsSnapshot_statutory_fkey"
  FOREIGN KEY ("businessId", "statutoryNoticeVersionId") REFERENCES "ServiceTextVersion"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServiceIntakeTermsSnapshot" ADD CONSTRAINT "ServiceIntakeTermsSnapshot_presentedBy_fkey"
  FOREIGN KEY ("presentedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ServiceWarrantyOffer" (
  "id"                       SERIAL NOT NULL,
  "businessId"               INTEGER NOT NULL,
  "caseId"                   INTEGER NOT NULL,
  "seq"                      INTEGER NOT NULL,
  "state"                    "ServiceWarrantyOfferState" NOT NULL DEFAULT 'DRAFT',
  "source"                   "ServiceWarrantyOfferSource" NOT NULL,
  "quoteVersion"             INTEGER,
  "durationValue"            INTEGER NOT NULL,
  "durationUnit"             "ServiceDurationUnit" NOT NULL,
  "scopeText"                TEXT NOT NULL,
  "exclusionsText"           TEXT,
  "statutoryNoticeVersionId" INTEGER NOT NULL,
  "contentSha256"            CHAR(64) NOT NULL,
  "supersedesOfferId"        INTEGER,
  "changeReason"             TEXT,
  "customerAdverse"          BOOLEAN NOT NULL DEFAULT false,
  "customerReaffirmedAt"     TIMESTAMP(3),
  "customerReaffirmMethod"   "ServiceReaffirmMethod",
  "presentedAt"              TIMESTAMP(3),
  "presentedByUserId"        INTEGER,
  "lockedAt"                 TIMESTAMP(3),
  "startsOn"                 DATE,
  "endsOn"                   DATE,
  "createdByUserId"          INTEGER,
  "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                TIMESTAMP(3) NOT NULL,
  "erasedAt"                 TIMESTAMP(3),
  CONSTRAINT "ServiceWarrantyOffer_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ServiceWarrantyOffer_seq" CHECK ("seq" >= 1),
  CONSTRAINT "ServiceWarrantyOffer_duration" CHECK (
    ("durationUnit" = 'DAYS' AND "durationValue" BETWEEN 1 AND 3650) OR ("durationUnit" = 'MONTHS' AND "durationValue" BETWEEN 1 AND 120)),
  CONSTRAINT "ServiceWarrantyOffer_texts" CHECK (
    char_length("scopeText") BETWEEN 1 AND 2000
    AND ("exclusionsText" IS NULL OR char_length("exclusionsText") BETWEEN 1 AND 2000)
    AND ("changeReason" IS NULL OR char_length("changeReason") BETWEEN 1 AND 1000 OR "erasedAt" IS NOT NULL)),
  CONSTRAINT "ServiceWarrantyOffer_sha" CHECK ("contentSha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ServiceWarrantyOffer_quote" CHECK (("source" = 'QUOTE') = ("quoteVersion" IS NOT NULL)),
  CONSTRAINT "ServiceWarrantyOffer_presented" CHECK (
    ("state" = 'DRAFT' AND "presentedAt" IS NULL) OR ("state" IN ('PRESENTED', 'LOCKED') AND "presentedAt" IS NOT NULL) OR "state" = 'SUPERSEDED'),
  CONSTRAINT "ServiceWarrantyOffer_locked" CHECK (
    ("lockedAt" IS NULL AND "startsOn" IS NULL AND "endsOn" IS NULL AND "state" <> 'LOCKED')
    OR ("lockedAt" IS NOT NULL AND "startsOn" IS NOT NULL AND "endsOn" IS NOT NULL AND "endsOn" > "startsOn" AND "state" IN ('LOCKED', 'SUPERSEDED'))),
  CONSTRAINT "ServiceWarrantyOffer_reaffirm" CHECK (("customerReaffirmedAt" IS NULL) = ("customerReaffirmMethod" IS NULL))
);
CREATE UNIQUE INDEX "ServiceWarrantyOffer_businessId_id_key" ON "ServiceWarrantyOffer"("businessId", "id");
CREATE UNIQUE INDEX "ServiceWarrantyOffer_businessId_caseId_seq_key" ON "ServiceWarrantyOffer"("businessId", "caseId", "seq");
CREATE UNIQUE INDEX "ServiceWarrantyOffer_one_draft_per_case" ON "ServiceWarrantyOffer"("businessId", "caseId") WHERE "state" = 'DRAFT';
CREATE UNIQUE INDEX "ServiceWarrantyOffer_one_live_per_case" ON "ServiceWarrantyOffer"("businessId", "caseId") WHERE "state" IN ('PRESENTED', 'LOCKED');
CREATE UNIQUE INDEX "ServiceWarrantyOffer_one_successor" ON "ServiceWarrantyOffer"("businessId", "supersedesOfferId") WHERE "supersedesOfferId" IS NOT NULL;
ALTER TABLE "ServiceWarrantyOffer" ADD CONSTRAINT "ServiceWarrantyOffer_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceWarrantyOffer" ADD CONSTRAINT "ServiceWarrantyOffer_case_fkey"
  FOREIGN KEY ("businessId", "caseId") REFERENCES "ServiceCase"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServiceWarrantyOffer" ADD CONSTRAINT "ServiceWarrantyOffer_quote_fkey"
  FOREIGN KEY ("businessId", "caseId", "quoteVersion") REFERENCES "ServiceQuote"("businessId", "caseId", "version") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServiceWarrantyOffer" ADD CONSTRAINT "ServiceWarrantyOffer_statutory_fkey"
  FOREIGN KEY ("businessId", "statutoryNoticeVersionId") REFERENCES "ServiceTextVersion"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServiceWarrantyOffer" ADD CONSTRAINT "ServiceWarrantyOffer_supersedes_fkey"
  FOREIGN KEY ("businessId", "supersedesOfferId") REFERENCES "ServiceWarrantyOffer"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServiceWarrantyOffer" ADD CONSTRAINT "ServiceWarrantyOffer_presentedBy_fkey"
  FOREIGN KEY ("presentedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ServiceWarrantyOffer" ADD CONSTRAINT "ServiceWarrantyOffer_createdBy_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ServiceIntakePhoto" (
  "id"              SERIAL NOT NULL,
  "businessId"      INTEGER NOT NULL,
  "caseId"          INTEGER NOT NULL,
  "storageKey"      TEXT NOT NULL,
  "sha256"          CHAR(64) NOT NULL,
  "mimeType"        TEXT NOT NULL,
  "byteSize"        INTEGER NOT NULL,
  "createdByUserId" INTEGER,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "erasedAt"        TIMESTAMP(3),
  CONSTRAINT "ServiceIntakePhoto_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ServiceIntakePhoto_sha" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ServiceIntakePhoto_mime" CHECK ("mimeType" IN ('image/jpeg', 'image/png', 'image/webp')),
  CONSTRAINT "ServiceIntakePhoto_size" CHECK ("byteSize" BETWEEN 1 AND 10485760),
  CONSTRAINT "ServiceIntakePhoto_key" CHECK ("storageKey" = 'biz/' || "businessId" || '/service/cases/' || "caseId" || '/intake/photos/' || "sha256"
    || CASE "mimeType" WHEN 'image/jpeg' THEN '.jpg' WHEN 'image/png' THEN '.png' ELSE '.webp' END)
);
CREATE UNIQUE INDEX "ServiceIntakePhoto_businessId_storageKey_key" ON "ServiceIntakePhoto"("businessId", "storageKey");
CREATE INDEX "ServiceIntakePhoto_businessId_caseId_idx" ON "ServiceIntakePhoto"("businessId", "caseId");
ALTER TABLE "ServiceIntakePhoto" ADD CONSTRAINT "ServiceIntakePhoto_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceIntakePhoto" ADD CONSTRAINT "ServiceIntakePhoto_case_fkey"
  FOREIGN KEY ("businessId", "caseId") REFERENCES "ServiceCase"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServiceIntakePhoto" ADD CONSTRAINT "ServiceIntakePhoto_createdBy_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ServiceShareEvent" (
  "id"             SERIAL NOT NULL,
  "businessId"     INTEGER NOT NULL,
  "caseId"         INTEGER NOT NULL,
  "objectKind"     "ServiceShareObjectKind" NOT NULL,
  "quoteVersion"   INTEGER,
  "objectKey"      TEXT NOT NULL,
  "objectSha256"   CHAR(64) NOT NULL,
  "channel"        "ServiceShareChannel" NOT NULL,
  "actorUserId"    INTEGER,
  "occurredAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "idempotencyKey" TEXT NOT NULL,
  "erasedAt"       TIMESTAMP(3),
  CONSTRAINT "ServiceShareEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ServiceShareEvent_quote" CHECK (("objectKind" = 'QUOTE_PDF') = ("quoteVersion" IS NOT NULL)),
  CONSTRAINT "ServiceShareEvent_sha" CHECK ("objectSha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ServiceShareEvent_key" CHECK ("objectKey" LIKE ('biz/' || "businessId" || '/service/%') AND char_length("objectKey") <= 512),
  CONSTRAINT "ServiceShareEvent_idem" CHECK ("idempotencyKey" ~ '^[A-Za-z0-9._:-]{16,128}$')
);
CREATE UNIQUE INDEX "ServiceShareEvent_businessId_idempotencyKey_key" ON "ServiceShareEvent"("businessId", "idempotencyKey");
CREATE INDEX "ServiceShareEvent_businessId_caseId_idx" ON "ServiceShareEvent"("businessId", "caseId");
ALTER TABLE "ServiceShareEvent" ADD CONSTRAINT "ServiceShareEvent_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceShareEvent" ADD CONSTRAINT "ServiceShareEvent_case_fkey"
  FOREIGN KEY ("businessId", "caseId") REFERENCES "ServiceCase"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServiceShareEvent" ADD CONSTRAINT "ServiceShareEvent_actor_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ServicePhoneReminder" (
  "id"             SERIAL NOT NULL,
  "businessId"     INTEGER NOT NULL,
  "caseId"         INTEGER NOT NULL,
  "calledAt"       TIMESTAMP(3) NOT NULL,
  "actorUserId"    INTEGER,
  "outcome"        "ServicePhoneReminderOutcome" NOT NULL,
  "note"           TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "erasedAt"       TIMESTAMP(3),
  CONSTRAINT "ServicePhoneReminder_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ServicePhoneReminder_note" CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 1000),
  CONSTRAINT "ServicePhoneReminder_idem" CHECK ("idempotencyKey" ~ '^[A-Za-z0-9._:-]{16,128}$')
);
CREATE UNIQUE INDEX "ServicePhoneReminder_businessId_idempotencyKey_key" ON "ServicePhoneReminder"("businessId", "idempotencyKey");
CREATE INDEX "ServicePhoneReminder_businessId_caseId_idx" ON "ServicePhoneReminder"("businessId", "caseId");
ALTER TABLE "ServicePhoneReminder" ADD CONSTRAINT "ServicePhoneReminder_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServicePhoneReminder" ADD CONSTRAINT "ServicePhoneReminder_case_fkey"
  FOREIGN KEY ("businessId", "caseId") REFERENCES "ServiceCase"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServicePhoneReminder" ADD CONSTRAINT "ServicePhoneReminder_actor_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ServiceStorageErasure" (
  "businessId"        INTEGER NOT NULL,
  "state"             "ServiceStorageErasureState" NOT NULL DEFAULT 'PENDING_OBJECTS',
  "startedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attempts"          INTEGER NOT NULL DEFAULT 0,
  "objectsDeleted"    BIGINT NOT NULL DEFAULT 0,
  "lastPassAt"        TIMESTAMP(3),
  "lastPassRemaining" INTEGER,
  "lastError"         TEXT,
  "completedAt"       TIMESTAMP(3),
  CONSTRAINT "ServiceStorageErasure_pkey" PRIMARY KEY ("businessId"),
  CONSTRAINT "ServiceStorageErasure_counts" CHECK ("attempts" >= 0 AND "objectsDeleted" >= 0 AND ("lastPassRemaining" IS NULL OR "lastPassRemaining" >= 0)),
  CONSTRAINT "ServiceStorageErasure_done" CHECK (("state" = 'DONE') = ("completedAt" IS NOT NULL)),
  CONSTRAINT "ServiceStorageErasure_done_clean" CHECK ("state" <> 'DONE' OR ("lastPassRemaining" = 0 AND "lastError" IS NULL)),
  CONSTRAINT "ServiceStorageErasure_error" CHECK ("lastError" IS NULL OR char_length("lastError") BETWEEN 1 AND 500)
);
ALTER TABLE "ServiceStorageErasure" ADD CONSTRAINT "ServiceStorageErasure_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 3. Shared helpers ───────────────────────────────────────────────────────────────────────────────────────
-- A business being deleted (or with a storage-erasure job) takes no new Service Desk UI writes: no row, so no new
-- object key can be committed under biz/{id}/service/ after the purge started (ו1). INVOKER: Business is readable.
CREATE OR REPLACE FUNCTION public.service_ui_business_writable(p_business integer)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT EXISTS (SELECT 1 FROM public."Business" b WHERE b."id" = p_business
                   AND b."deletionRequestedAt" IS NULL AND b."deletedAt" IS NULL)
     AND NOT EXISTS (SELECT 1 FROM public."ServiceStorageErasure" e WHERE e."businessId" = p_business)
$fn$;
REVOKE ALL ON FUNCTION public.service_ui_business_writable(integer) FROM PUBLIC;

-- The erasure scrub of these tables runs only inside service_desk_ui_erase_business() (marker + table owner).
CREATE OR REPLACE FUNCTION public.service_ui_in_erasure(p_relid oid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT current_setting('dubiz.service_ui_erasure', true) = 'on'
     AND current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = p_relid)
$fn$;
REVOKE ALL ON FUNCTION public.service_ui_in_erasure(oid) FROM PUBLIC;

-- ── 4. Guards ───────────────────────────────────────────────────────────────────────────────────────────────
CREATE TRIGGER "ServiceTextVersion_user_same_business"
  BEFORE INSERT OR UPDATE OF "businessId", "createdByUserId", "legallyApprovedByUserId" ON "ServiceTextVersion"
  FOR EACH ROW EXECUTE FUNCTION public.service_user_same_business('createdByUserId', 'legallyApprovedByUserId');
CREATE TRIGGER "ServiceIntakeTermsSnapshot_user_same_business"
  BEFORE INSERT ON "ServiceIntakeTermsSnapshot"
  FOR EACH ROW EXECUTE FUNCTION public.service_user_same_business('presentedByUserId');
CREATE TRIGGER "ServiceWarrantyOffer_user_same_business"
  BEFORE INSERT OR UPDATE OF "businessId", "createdByUserId", "presentedByUserId" ON "ServiceWarrantyOffer"
  FOR EACH ROW EXECUTE FUNCTION public.service_user_same_business('createdByUserId', 'presentedByUserId');
CREATE TRIGGER "ServiceIntakePhoto_user_same_business"
  BEFORE INSERT ON "ServiceIntakePhoto"
  FOR EACH ROW EXECUTE FUNCTION public.service_user_same_business('createdByUserId');
CREATE TRIGGER "ServiceShareEvent_user_same_business"
  BEFORE INSERT ON "ServiceShareEvent"
  FOR EACH ROW EXECUTE FUNCTION public.service_user_same_business('actorUserId');
CREATE TRIGGER "ServicePhoneReminder_user_same_business"
  BEFORE INSERT ON "ServicePhoneReminder"
  FOR EACH ROW EXECUTE FUNCTION public.service_user_same_business('actorUserId');

-- 4.1 Text versions: written once, next version number, inserted as DRAFT; the only change is DRAFT →
-- LEGALLY_APPROVED (once, with time and approver); the erasure scrub nulls the user references.
CREATE OR REPLACE FUNCTION public.service_text_version_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_max integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
    RAISE EXCEPTION USING ERRCODE = 'DZU01', MESSAGE = 'SERVICE_TEXT_FIXED: a text version is never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT public.service_ui_business_writable(NEW."businessId") THEN
      RAISE EXCEPTION USING ERRCODE = 'DZU02', MESSAGE = 'SERVICE_UI_BUSINESS_DELETING: the business is being deleted; nothing was written';
    END IF;
    IF NEW."legalStatus" <> 'DRAFT' OR NEW."legallyApprovedAt" IS NOT NULL OR NEW."legallyApprovedByUserId" IS NOT NULL OR NEW."erasedAt" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'DZU01', MESSAGE = 'SERVICE_TEXT_INSERT_DRAFT: a text version is born DRAFT; approval is a separate step';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('service_text:' || NEW."businessId" || ':' || NEW."kind"::text, 0));
    SELECT COALESCE(max("version"), 0) INTO v_max FROM public."ServiceTextVersion"
     WHERE "businessId" = NEW."businessId" AND "kind" = NEW."kind";
    IF NEW."version" <> v_max + 1 THEN
      RAISE EXCEPTION USING ERRCODE = 'DZU01', MESSAGE = format('SERVICE_TEXT_VERSION_NOT_NEXT: expected version %s', v_max + 1);
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE
  IF public.service_ui_in_erasure(TG_RELID)
     AND (to_jsonb(NEW) - ARRAY['createdByUserId', 'legallyApprovedByUserId', 'erasedAt']) = (to_jsonb(OLD) - ARRAY['createdByUserId', 'legallyApprovedByUserId', 'erasedAt'])
     AND NEW."createdByUserId" IS NULL AND NEW."legallyApprovedByUserId" IS NULL AND NEW."erasedAt" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF pg_trigger_depth() > 1
     AND (to_jsonb(NEW) - ARRAY['createdByUserId', 'legallyApprovedByUserId']) = (to_jsonb(OLD) - ARRAY['createdByUserId', 'legallyApprovedByUserId'])
     AND (NEW."createdByUserId" IS NULL OR NEW."createdByUserId" = OLD."createdByUserId")
     AND (NEW."legallyApprovedByUserId" IS NULL OR NEW."legallyApprovedByUserId" = OLD."legallyApprovedByUserId") THEN
    RETURN NEW;  -- ON DELETE SET NULL of a user
  END IF;
  IF NOT public.service_ui_business_writable(NEW."businessId") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU02', MESSAGE = 'SERVICE_UI_BUSINESS_DELETING: the business is being deleted; nothing was written';
  END IF;
  IF OLD."legalStatus" = 'DRAFT' AND NEW."legalStatus" = 'LEGALLY_APPROVED'
     AND NEW."legallyApprovedAt" IS NOT NULL AND NEW."legallyApprovedByUserId" IS NOT NULL
     AND (to_jsonb(NEW) - ARRAY['legalStatus', 'legallyApprovedAt', 'legallyApprovedByUserId'])
       = (to_jsonb(OLD) - ARRAY['legalStatus', 'legallyApprovedAt', 'legallyApprovedByUserId']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'DZU01', MESSAGE = 'SERVICE_TEXT_FIXED: a text version never changes; only DRAFT → LEGALLY_APPROVED once, with time and approver';
END
$fn$;
REVOKE ALL ON FUNCTION public.service_text_version_guard() FROM PUBLIC;
CREATE TRIGGER "ServiceTextVersion_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ServiceTextVersion"
  FOR EACH ROW EXECUTE FUNCTION public.service_text_version_guard();
CREATE TRIGGER "ServiceTextVersion_no_truncate" BEFORE TRUNCATE ON "ServiceTextVersion"
  FOR EACH STATEMENT EXECUTE FUNCTION public.service_journal_truncate_guard();

-- 4.2 Settings: the active texts must be of their kind; version moves by exactly one; no write while deleting.
CREATE OR REPLACE FUNCTION public.service_settings_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
    RAISE EXCEPTION USING ERRCODE = 'DZU03', MESSAGE = 'SERVICE_SETTINGS_NO_DELETE: settings are never deleted';
  END IF;
  IF NOT public.service_ui_business_writable(NEW."businessId") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU02', MESSAGE = 'SERVICE_UI_BUSINESS_DELETING: the business is being deleted; nothing was written';
  END IF;
  IF TG_OP = 'INSERT' AND NEW."version" <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU03', MESSAGE = 'SERVICE_SETTINGS_VERSION: settings are born at version 1';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."businessId" <> OLD."businessId" OR NEW."version" <> OLD."version" + 1) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU03', MESSAGE = 'SERVICE_SETTINGS_VERSION: each change moves version by one (optimistic concurrency)';
  END IF;
  IF NEW."activeTermsVersionId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public."ServiceTextVersion" t
       WHERE t."businessId" = NEW."businessId" AND t."id" = NEW."activeTermsVersionId" AND t."kind" = 'TERMS') THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU03', MESSAGE = 'SERVICE_SETTINGS_TEXT_KIND: the active terms must be a TERMS version of this business';
  END IF;
  IF NEW."activeStatutoryNoticeVersionId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public."ServiceTextVersion" t
       WHERE t."businessId" = NEW."businessId" AND t."id" = NEW."activeStatutoryNoticeVersionId" AND t."kind" = 'STATUTORY_NOTICE') THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU03', MESSAGE = 'SERVICE_SETTINGS_TEXT_KIND: the active statutory notice must be a STATUTORY_NOTICE version of this business';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_settings_guard() FROM PUBLIC;
CREATE TRIGGER "ServiceSettings_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ServiceSettings"
  FOR EACH ROW EXECUTE FUNCTION public.service_settings_guard();

-- 4.3 Intake terms snapshot: once per case, before the intake is signed, only LEGALLY_APPROVED texts of the right
-- kind, and the stored hashes must be the versions' own. Append-only (erasure scrub / user SET NULL excepted).
CREATE OR REPLACE FUNCTION public.service_intake_terms_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
    RAISE EXCEPTION USING ERRCODE = 'DZU04', MESSAGE = 'SERVICE_INTAKE_TERMS_FIXED: the terms snapshot is never deleted';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF public.service_ui_in_erasure(TG_RELID)
       AND (to_jsonb(NEW) - ARRAY['presentedByUserId', 'erasedAt']) = (to_jsonb(OLD) - ARRAY['presentedByUserId', 'erasedAt'])
       AND NEW."presentedByUserId" IS NULL AND NEW."erasedAt" IS NOT NULL THEN
      RETURN NEW;
    END IF;
    IF pg_trigger_depth() > 1 AND NEW."presentedByUserId" IS NULL
       AND (to_jsonb(NEW) - 'presentedByUserId') = (to_jsonb(OLD) - 'presentedByUserId') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'DZU04', MESSAGE = 'SERVICE_INTAKE_TERMS_FIXED: the terms snapshot never changes';
  END IF;
  -- INSERT
  IF NOT public.service_ui_business_writable(NEW."businessId") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU02', MESSAGE = 'SERVICE_UI_BUSINESS_DELETING: the business is being deleted; nothing was written';
  END IF;
  PERFORM 1 FROM public."ServiceCase" c WHERE c."businessId" = NEW."businessId" AND c."id" = NEW."caseId" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public."ServiceCaseIntake" i WHERE i."businessId" = NEW."businessId" AND i."caseId" = NEW."caseId" AND i."signedAt" IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU04', MESSAGE = 'SERVICE_INTAKE_TERMS_AFTER_SIGNATURE: the terms must be captured before the intake is signed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."ServiceTextVersion" t WHERE t."businessId" = NEW."businessId" AND t."id" = NEW."termsVersionId"
                   AND t."kind" = 'TERMS' AND t."legalStatus" = 'LEGALLY_APPROVED' AND t."bodySha256" = NEW."termsSha256")
     OR NOT EXISTS (SELECT 1 FROM public."ServiceTextVersion" t WHERE t."businessId" = NEW."businessId" AND t."id" = NEW."statutoryNoticeVersionId"
                   AND t."kind" = 'STATUTORY_NOTICE' AND t."legalStatus" = 'LEGALLY_APPROVED' AND t."bodySha256" = NEW."statutorySha256") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU04', MESSAGE = 'SERVICE_INTAKE_TERMS_NOT_APPROVED: only legally approved texts of the right kind, with their own hash, are shown to a customer';
  END IF;
  IF NEW."erasedAt" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU04', MESSAGE = 'SERVICE_INTAKE_TERMS_FIXED: a new snapshot is not erased';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_intake_terms_guard() FROM PUBLIC;
CREATE TRIGGER "ServiceIntakeTermsSnapshot_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ServiceIntakeTermsSnapshot"
  FOR EACH ROW EXECUTE FUNCTION public.service_intake_terms_guard();
CREATE TRIGGER "ServiceIntakeTermsSnapshot_no_truncate" BEFORE TRUNCATE ON "ServiceIntakeTermsSnapshot"
  FOR EACH STATEMENT EXECUTE FUNCTION public.service_journal_truncate_guard();

-- 4.4 Warranty offers (ו2).
--   DRAFT       content editable; → PRESENTED (time + who; statutory notice approved; an adverse change needs the
--               customer's renewed agreement first) or → SUPERSEDED (discarded).
--   PRESENTED   content fixed; → LOCKED at handover (a handover exists; starts on the delivery day; ends exactly one
--               duration later) or → SUPERSEDED by a successor written in the same transaction.
--   LOCKED      fixed; → SUPERSEDED only by an EXTENSION (same scope / exclusions / start, later end), itself LOCKED.
--   SUPERSEDED  final.
-- A successor of a PRESENTED / LOCKED offer carries a reason; a shorter duration in the same unit is marked
-- customerAdverse; units differing → the service layer decides adverse explicitly (never inferred as favourable).
CREATE OR REPLACE FUNCTION public.service_warranty_end(p_start date, p_value integer, p_unit "ServiceDurationUnit")
RETURNS date
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT CASE p_unit WHEN 'DAYS' THEN p_start + p_value ELSE (p_start + make_interval(months => p_value))::date END
$fn$;
REVOKE ALL ON FUNCTION public.service_warranty_end(date, integer, "ServiceDurationUnit") FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.service_warranty_offer_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_prev public."ServiceWarrantyOffer"%ROWTYPE;
  v_prev_stage text;
  v_max integer;
  v_delivered timestamp(3);
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
    RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_NO_DELETE: a warranty offer is never deleted';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF public.service_ui_in_erasure(TG_RELID)
       AND (to_jsonb(NEW) - ARRAY['changeReason', 'presentedByUserId', 'createdByUserId', 'erasedAt', 'updatedAt'])
         = (to_jsonb(OLD) - ARRAY['changeReason', 'presentedByUserId', 'createdByUserId', 'erasedAt', 'updatedAt'])
       AND NEW."changeReason" IS NULL AND NEW."presentedByUserId" IS NULL AND NEW."createdByUserId" IS NULL AND NEW."erasedAt" IS NOT NULL THEN
      RETURN NEW;
    END IF;
    IF pg_trigger_depth() > 1
       AND (to_jsonb(NEW) - ARRAY['presentedByUserId', 'createdByUserId']) = (to_jsonb(OLD) - ARRAY['presentedByUserId', 'createdByUserId'])
       AND (NEW."presentedByUserId" IS NULL OR NEW."presentedByUserId" = OLD."presentedByUserId")
       AND (NEW."createdByUserId" IS NULL OR NEW."createdByUserId" = OLD."createdByUserId") THEN
      RETURN NEW;
    END IF;
  END IF;
  IF NOT public.service_ui_business_writable(NEW."businessId") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU02', MESSAGE = 'SERVICE_UI_BUSINESS_DELETING: the business is being deleted; nothing was written';
  END IF;
  -- every warranty change serialises on the case row (1.2b / M2 convention)
  PERFORM 1 FROM public."ServiceCase" c WHERE c."businessId" = NEW."businessId" AND c."id" = NEW."caseId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_CASE: the offer must name a case of the same business';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."erasedAt" IS NOT NULL OR NEW."lockedAt" IS NOT NULL AND NEW."supersedesOfferId" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_INSERT: a new offer is DRAFT or PRESENTED (LOCKED only as an extension)';
    END IF;
    SELECT COALESCE(max("seq"), 0) INTO v_max FROM public."ServiceWarrantyOffer" WHERE "businessId" = NEW."businessId" AND "caseId" = NEW."caseId";
    IF NEW."seq" <> v_max + 1 THEN
      RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = format('SERVICE_WARRANTY_SEQ: expected seq %s', v_max + 1);
    END IF;
    IF NEW."state" = 'SUPERSEDED' THEN
      RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_INSERT: a new offer is not SUPERSEDED';
    END IF;
    IF NEW."supersedesOfferId" IS NOT NULL THEN
      -- The predecessor may already be SUPERSEDED in this transaction (the one-live-offer index makes a LOCKED
      -- extension supersede first, then insert); its stage before that is read from lockedAt / presentedAt.
      SELECT * INTO v_prev FROM public."ServiceWarrantyOffer" WHERE "businessId" = NEW."businessId" AND "id" = NEW."supersedesOfferId";
      v_prev_stage := CASE WHEN v_prev."lockedAt" IS NOT NULL THEN 'LOCKED' WHEN v_prev."presentedAt" IS NOT NULL THEN 'PRESENTED' ELSE 'DRAFT' END;
      IF v_prev."caseId" IS DISTINCT FROM NEW."caseId" OR v_prev_stage = 'DRAFT' OR v_prev."erasedAt" IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_SUPERSEDE: only a PRESENTED or LOCKED offer of the same case is superseded (a draft is edited or discarded)';
      END IF;
      IF NEW."changeReason" IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_REASON_REQUIRED: a change after presentation needs a reason';
      END IF;
      IF v_prev_stage = 'PRESENTED' THEN
        IF NEW."state" NOT IN ('DRAFT', 'PRESENTED') THEN
          RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_SUPERSEDE: a presented offer is replaced by a DRAFT or PRESENTED offer';
        END IF;
        IF NEW."durationUnit" = v_prev."durationUnit" AND NEW."durationValue" < v_prev."durationValue" AND NOT NEW."customerAdverse" THEN
          RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_ADVERSE_UNMARKED: a shorter warranty than the one presented is customer-adverse';
        END IF;
      ELSE  -- LOCKED: extension only
        IF NEW."state" <> 'LOCKED' OR NEW."startsOn" IS DISTINCT FROM v_prev."startsOn" OR NEW."endsOn" IS NULL OR NEW."endsOn" <= v_prev."endsOn"
           OR NEW."scopeText" IS DISTINCT FROM v_prev."scopeText" OR NEW."exclusionsText" IS DISTINCT FROM v_prev."exclusionsText"
           OR NEW."customerAdverse" THEN
          RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_AFTER_HANDOVER: after handover only an extension (same scope and start, later end) is allowed';
        END IF;
        IF NEW."endsOn" <> public.service_warranty_end(NEW."startsOn", NEW."durationValue", NEW."durationUnit") OR NEW."presentedAt" IS NULL THEN
          RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_DATES: the end date must be exactly one duration after the start';
        END IF;
      END IF;
    ELSIF NEW."changeReason" IS NOT NULL OR NEW."customerAdverse" THEN
      RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_FIRST: a first offer has no change reason and is not adverse';
    END IF;
  ELSE
    -- UPDATE
    IF NEW."businessId" <> OLD."businessId" OR NEW."caseId" <> OLD."caseId" OR NEW."seq" <> OLD."seq" OR NEW."createdAt" <> OLD."createdAt"
       OR NEW."erasedAt" IS DISTINCT FROM OLD."erasedAt" THEN
      RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_IDENTITY: the offer identity never changes';
    END IF;
    IF OLD."state" = 'SUPERSEDED' THEN
      RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_FINAL: a superseded offer never changes';
    END IF;
    IF OLD."state" <> 'DRAFT' AND (to_jsonb(NEW) -> 'source', to_jsonb(NEW) -> 'quoteVersion', to_jsonb(NEW) -> 'durationValue', to_jsonb(NEW) -> 'durationUnit',
          to_jsonb(NEW) -> 'scopeText', to_jsonb(NEW) -> 'exclusionsText', to_jsonb(NEW) -> 'statutoryNoticeVersionId', to_jsonb(NEW) -> 'contentSha256',
          to_jsonb(NEW) -> 'supersedesOfferId', to_jsonb(NEW) -> 'changeReason', to_jsonb(NEW) -> 'customerAdverse',
          to_jsonb(NEW) -> 'customerReaffirmedAt', to_jsonb(NEW) -> 'customerReaffirmMethod', to_jsonb(NEW) -> 'presentedAt', to_jsonb(NEW) -> 'presentedByUserId')
       IS DISTINCT FROM (to_jsonb(OLD) -> 'source', to_jsonb(OLD) -> 'quoteVersion', to_jsonb(OLD) -> 'durationValue', to_jsonb(OLD) -> 'durationUnit',
          to_jsonb(OLD) -> 'scopeText', to_jsonb(OLD) -> 'exclusionsText', to_jsonb(OLD) -> 'statutoryNoticeVersionId', to_jsonb(OLD) -> 'contentSha256',
          to_jsonb(OLD) -> 'supersedesOfferId', to_jsonb(OLD) -> 'changeReason', to_jsonb(OLD) -> 'customerAdverse',
          to_jsonb(OLD) -> 'customerReaffirmedAt', to_jsonb(OLD) -> 'customerReaffirmMethod', to_jsonb(OLD) -> 'presentedAt', to_jsonb(OLD) -> 'presentedByUserId') THEN
      RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_CONTENT_FIXED: the content of a presented offer never changes; write a new offer with a reason';
    END IF;
    IF OLD."state" = 'DRAFT' AND NEW."state" NOT IN ('DRAFT', 'PRESENTED', 'SUPERSEDED') THEN
      RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_TRANSITION: a draft is presented or discarded';
    END IF;
    IF OLD."state" = 'PRESENTED' AND NEW."state" NOT IN ('PRESENTED', 'LOCKED', 'SUPERSEDED') THEN
      RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_TRANSITION: a presented offer is locked at handover or superseded';
    END IF;
    IF OLD."state" = 'LOCKED' AND NEW."state" NOT IN ('LOCKED', 'SUPERSEDED') THEN
      RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_TRANSITION: a locked offer is only superseded by an extension';
    END IF;
    IF OLD."state" IN ('LOCKED') AND (NEW."lockedAt" IS DISTINCT FROM OLD."lockedAt" OR NEW."startsOn" IS DISTINCT FROM OLD."startsOn" OR NEW."endsOn" IS DISTINCT FROM OLD."endsOn") THEN
      RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_CONTENT_FIXED: a locked offer''s dates never change';
    END IF;
    IF NEW."state" = 'LOCKED' AND OLD."state" = 'PRESENTED' THEN
      SELECT h."deliveredAt" INTO v_delivered FROM public."ServiceHandover" h WHERE h."businessId" = NEW."businessId" AND h."caseId" = NEW."caseId";
      IF v_delivered IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_LOCK_NO_HANDOVER: an offer locks only at handover';
      END IF;
      IF NEW."startsOn" <> v_delivered::date OR NEW."endsOn" <> public.service_warranty_end(NEW."startsOn", NEW."durationValue", NEW."durationUnit") THEN
        RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_DATES: starts on the delivery day and ends exactly one duration later';
      END IF;
    END IF;
  END IF;

  -- presenting (insert as PRESENTED or DRAFT → PRESENTED): approved statutory notice; who and when; adverse ⇒ reaffirmed
  IF NEW."state" = 'PRESENTED' AND (TG_OP = 'INSERT' OR OLD."state" = 'DRAFT') THEN
    IF NEW."presentedAt" IS NULL OR NEW."presentedByUserId" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_PRESENT: presenting records time and who';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public."ServiceTextVersion" t WHERE t."businessId" = NEW."businessId" AND t."id" = NEW."statutoryNoticeVersionId"
                     AND t."kind" = 'STATUTORY_NOTICE' AND t."legalStatus" = 'LEGALLY_APPROVED') THEN
      RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_NOTICE_NOT_APPROVED: an offer is presented only with a legally approved statutory notice';
    END IF;
    IF NEW."customerAdverse" AND NEW."customerReaffirmedAt" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_REAFFIRM_REQUIRED: a customer-adverse change needs the customer''s renewed agreement before it is presented';
    END IF;
  END IF;
  IF NEW."state" = 'DRAFT' AND (NEW."statutoryNoticeVersionId" IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM public."ServiceTextVersion" t
       WHERE t."businessId" = NEW."businessId" AND t."id" = NEW."statutoryNoticeVersionId" AND t."kind" = 'STATUTORY_NOTICE') THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU05', MESSAGE = 'SERVICE_WARRANTY_NOTICE_KIND: the notice must be a STATUTORY_NOTICE version';
  END IF;
  NEW."updatedAt" := CURRENT_TIMESTAMP;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_warranty_offer_guard() FROM PUBLIC;
CREATE TRIGGER "ServiceWarrantyOffer_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ServiceWarrantyOffer"
  FOR EACH ROW EXECUTE FUNCTION public.service_warranty_offer_guard();
CREATE TRIGGER "ServiceWarrantyOffer_no_truncate" BEFORE TRUNCATE ON "ServiceWarrantyOffer"
  FOR EACH STATEMENT EXECUTE FUNCTION public.service_journal_truncate_guard();

-- 4.4b At COMMIT: a successor's predecessor is SUPERSEDED, and a presented / locked offer that became SUPERSEDED has
-- its successor (no offer silently withdrawn).
CREATE OR REPLACE FUNCTION public.service_warranty_chain_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  cur public."ServiceWarrantyOffer"%ROWTYPE;
BEGIN
  SELECT * INTO cur FROM public."ServiceWarrantyOffer" WHERE "id" = NEW."id";
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF cur."supersedesOfferId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public."ServiceWarrantyOffer" p
       WHERE p."businessId" = cur."businessId" AND p."id" = cur."supersedesOfferId" AND p."state" = 'SUPERSEDED') THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU06', MESSAGE = format('SERVICE_WARRANTY_CHAIN: offer %s supersedes an offer that is still live', cur."id");
  END IF;
  IF cur."state" = 'SUPERSEDED' AND cur."presentedAt" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public."ServiceWarrantyOffer" s
       WHERE s."businessId" = cur."businessId" AND s."supersedesOfferId" = cur."id") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU06', MESSAGE = format('SERVICE_WARRANTY_CHAIN: presented offer %s was withdrawn without a successor', cur."id");
  END IF;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_warranty_chain_check() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER "ServiceWarrantyOffer_chain" AFTER INSERT OR UPDATE ON "ServiceWarrantyOffer"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.service_warranty_chain_check();

-- 4.5 Intake photos: case locked first; only while the intake is unsigned; at most 10 per case; written once.
CREATE OR REPLACE FUNCTION public.service_intake_photo_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_n integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
    RAISE EXCEPTION USING ERRCODE = 'DZU07', MESSAGE = 'SERVICE_INTAKE_PHOTO_FIXED: an intake photo record is never deleted';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF public.service_ui_in_erasure(TG_RELID)
       AND (to_jsonb(NEW) - ARRAY['createdByUserId', 'erasedAt']) = (to_jsonb(OLD) - ARRAY['createdByUserId', 'erasedAt'])
       AND NEW."createdByUserId" IS NULL AND NEW."erasedAt" IS NOT NULL THEN
      RETURN NEW;
    END IF;
    IF pg_trigger_depth() > 1 AND NEW."createdByUserId" IS NULL
       AND (to_jsonb(NEW) - 'createdByUserId') = (to_jsonb(OLD) - 'createdByUserId') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'DZU07', MESSAGE = 'SERVICE_INTAKE_PHOTO_FIXED: an intake photo record never changes';
  END IF;
  IF NOT public.service_ui_business_writable(NEW."businessId") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU02', MESSAGE = 'SERVICE_UI_BUSINESS_DELETING: the business is being deleted; nothing was written';
  END IF;
  PERFORM 1 FROM public."ServiceCase" c WHERE c."businessId" = NEW."businessId" AND c."id" = NEW."caseId" AND c."erasedAt" IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU07', MESSAGE = 'SERVICE_INTAKE_PHOTO_CASE: the photo must name a live case of the same business';
  END IF;
  IF EXISTS (SELECT 1 FROM public."ServiceCaseIntake" i WHERE i."businessId" = NEW."businessId" AND i."caseId" = NEW."caseId" AND i."signedAt" IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU07', MESSAGE = 'SERVICE_INTAKE_PHOTO_AFTER_SIGNATURE: the intake is signed; its photos are frozen';
  END IF;
  SELECT count(*) INTO v_n FROM public."ServiceIntakePhoto" WHERE "businessId" = NEW."businessId" AND "caseId" = NEW."caseId";
  IF v_n >= 10 THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU07', MESSAGE = 'SERVICE_INTAKE_PHOTO_LIMIT: at most 10 intake photos per case';
  END IF;
  IF NEW."erasedAt" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU07', MESSAGE = 'SERVICE_INTAKE_PHOTO_FIXED: a new photo is not erased';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_intake_photo_guard() FROM PUBLIC;
CREATE TRIGGER "ServiceIntakePhoto_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ServiceIntakePhoto"
  FOR EACH ROW EXECUTE FUNCTION public.service_intake_photo_guard();
CREATE TRIGGER "ServiceIntakePhoto_no_truncate" BEFORE TRUNCATE ON "ServiceIntakePhoto"
  FOR EACH STATEMENT EXECUTE FUNCTION public.service_journal_truncate_guard();

-- 4.6 Share journal: the handed-over bytes are the stored copy (QUOTE_PDF: the sent quote's own key and sha256;
-- INTAKE_SLIP: the intake's slip key, which carries its sha256). Append-only.
CREATE OR REPLACE FUNCTION public.service_share_event_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
    RAISE EXCEPTION USING ERRCODE = 'DZU08', MESSAGE = 'SERVICE_SHARE_APPEND_ONLY: the share journal is append-only';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF public.service_ui_in_erasure(TG_RELID)
       AND (to_jsonb(NEW) - ARRAY['actorUserId', 'erasedAt']) = (to_jsonb(OLD) - ARRAY['actorUserId', 'erasedAt'])
       AND NEW."actorUserId" IS NULL AND NEW."erasedAt" IS NOT NULL THEN
      RETURN NEW;
    END IF;
    IF pg_trigger_depth() > 1 AND NEW."actorUserId" IS NULL AND (to_jsonb(NEW) - 'actorUserId') = (to_jsonb(OLD) - 'actorUserId') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'DZU08', MESSAGE = 'SERVICE_SHARE_APPEND_ONLY: the share journal is append-only';
  END IF;
  IF NOT public.service_ui_business_writable(NEW."businessId") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU02', MESSAGE = 'SERVICE_UI_BUSINESS_DELETING: the business is being deleted; nothing was written';
  END IF;
  IF NEW."actorUserId" IS NULL OR NEW."erasedAt" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU08', MESSAGE = 'SERVICE_SHARE_ACTOR: a share is recorded with who handed it over';
  END IF;
  IF NEW."objectKind" = 'QUOTE_PDF' AND NOT EXISTS (SELECT 1 FROM public."ServiceQuote" q
       WHERE q."businessId" = NEW."businessId" AND q."caseId" = NEW."caseId" AND q."version" = NEW."quoteVersion"
         AND q."sentPdfKey" = NEW."objectKey" AND q."sentPdfSha256" = NEW."objectSha256") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU08', MESSAGE = 'SERVICE_SHARE_NOT_STORED_COPY: the handed-over file is not the stored copy of that quote version';
  END IF;
  IF NEW."objectKind" = 'INTAKE_SLIP' AND NOT EXISTS (SELECT 1 FROM public."ServiceCaseIntake" i
       WHERE i."businessId" = NEW."businessId" AND i."caseId" = NEW."caseId" AND i."slipPdfKey" = NEW."objectKey"
         AND NEW."objectKey" LIKE ('%' || NEW."objectSha256" || '.pdf')) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU08', MESSAGE = 'SERVICE_SHARE_NOT_STORED_COPY: the handed-over file is not the stored intake slip';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_share_event_guard() FROM PUBLIC;
CREATE TRIGGER "ServiceShareEvent_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ServiceShareEvent"
  FOR EACH ROW EXECUTE FUNCTION public.service_share_event_guard();
CREATE TRIGGER "ServiceShareEvent_no_truncate" BEFORE TRUNCATE ON "ServiceShareEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION public.service_journal_truncate_guard();

-- 4.7 Phone reminders (ו3): only while the device waits for pickup (READY), not before it was ready, not in the
-- future, with who called. Append-only.
CREATE OR REPLACE FUNCTION public.service_phone_reminder_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_status text;
  v_ready timestamp(3);
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
    RAISE EXCEPTION USING ERRCODE = 'DZU09', MESSAGE = 'SERVICE_PHONE_REMINDER_APPEND_ONLY: phone reminders are append-only';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF public.service_ui_in_erasure(TG_RELID)
       AND (to_jsonb(NEW) - ARRAY['actorUserId', 'note', 'erasedAt']) = (to_jsonb(OLD) - ARRAY['actorUserId', 'note', 'erasedAt'])
       AND NEW."actorUserId" IS NULL AND NEW."note" IS NULL AND NEW."erasedAt" IS NOT NULL THEN
      RETURN NEW;
    END IF;
    IF pg_trigger_depth() > 1 AND NEW."actorUserId" IS NULL AND (to_jsonb(NEW) - 'actorUserId') = (to_jsonb(OLD) - 'actorUserId') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'DZU09', MESSAGE = 'SERVICE_PHONE_REMINDER_APPEND_ONLY: phone reminders are append-only';
  END IF;
  IF NOT public.service_ui_business_writable(NEW."businessId") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU02', MESSAGE = 'SERVICE_UI_BUSINESS_DELETING: the business is being deleted; nothing was written';
  END IF;
  IF NEW."actorUserId" IS NULL OR NEW."erasedAt" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU09', MESSAGE = 'SERVICE_PHONE_REMINDER_ACTOR: a phone reminder is recorded with who called';
  END IF;
  SELECT c."status"::text, c."readyAt" INTO v_status, v_ready FROM public."ServiceCase" c
   WHERE c."businessId" = NEW."businessId" AND c."id" = NEW."caseId" FOR UPDATE;
  IF v_status IS DISTINCT FROM 'READY' THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU09', MESSAGE = 'SERVICE_PHONE_REMINDER_NOT_READY: a pickup reminder is recorded only while the device is ready for pickup';
  END IF;
  IF NEW."calledAt" > CURRENT_TIMESTAMP + interval '5 minutes' OR (v_ready IS NOT NULL AND NEW."calledAt" < v_ready) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU09', MESSAGE = 'SERVICE_PHONE_REMINDER_TIME: the call time is after the device became ready and not in the future';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_phone_reminder_guard() FROM PUBLIC;
CREATE TRIGGER "ServicePhoneReminder_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ServicePhoneReminder"
  FOR EACH ROW EXECUTE FUNCTION public.service_phone_reminder_guard();
CREATE TRIGGER "ServicePhoneReminder_no_truncate" BEFORE TRUNCATE ON "ServicePhoneReminder"
  FOR EACH STATEMENT EXECUTE FUNCTION public.service_journal_truncate_guard();

-- 4.8 The storage-erasure job is written only by its SECURITY DEFINER functions; DONE is final; nothing deletes it
-- but the business cascade.
CREATE OR REPLACE FUNCTION public.service_storage_erasure_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
    RAISE EXCEPTION USING ERRCODE = 'DZU10', MESSAGE = 'SERVICE_STORAGE_ERASURE_FIXED: the erasure job is never deleted';
  END IF;
  IF current_setting('dubiz.service_storage_erasure', true) IS DISTINCT FROM 'on'
     OR current_user <> (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU10', MESSAGE = 'SERVICE_STORAGE_ERASURE_FIXED: the erasure job is written only by its functions';
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD."state" = 'DONE' OR NEW."businessId" <> OLD."businessId" OR NEW."startedAt" <> OLD."startedAt"
                           OR NEW."attempts" < OLD."attempts" OR NEW."objectsDeleted" < OLD."objectsDeleted") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU10', MESSAGE = 'SERVICE_STORAGE_ERASURE_FIXED: a finished job never changes; counters only grow';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_storage_erasure_guard() FROM PUBLIC;
CREATE TRIGGER "ServiceStorageErasure_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ServiceStorageErasure"
  FOR EACH ROW EXECUTE FUNCTION public.service_storage_erasure_guard();
CREATE TRIGGER "ServiceStorageErasure_no_truncate" BEFORE TRUNCATE ON "ServiceStorageErasure"
  FOR EACH STATEMENT EXECUTE FUNCTION public.service_journal_truncate_guard();

-- ── 5. Erasure (account deletion) ───────────────────────────────────────────────────────────────────────────
-- Called inside the purge transaction (PR-2 wires it, after service_erase_business()): scrubs the personal fields of
-- the new tables IN PLACE and opens the storage-erasure job. It deletes NO object — objects go only after COMMIT
-- (service_storage_erasure_record_pass), so a failed purge loses no file. Re-run safe.
CREATE OR REPLACE FUNCTION public.service_desk_ui_erase_business()
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
    RAISE EXCEPTION USING ERRCODE = 'DZU11', MESSAGE = 'SERVICE_UI_ERASURE_NO_CONTEXT: no tenant context; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."Business" b WHERE b."id" = v_business
                   AND (b."deletionRequestedAt" IS NOT NULL OR b."deletedAt" IS NOT NULL)) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU11', MESSAGE = 'SERVICE_UI_ERASURE_NOT_DELETING: the business is being deleted only after quarantine; nothing was changed';
  END IF;
  PERFORM set_config('dubiz.service_ui_erasure', 'on', true);

  UPDATE public."ServiceTextVersion" SET "createdByUserId" = NULL, "legallyApprovedByUserId" = NULL, "erasedAt" = CURRENT_TIMESTAMP
   WHERE "businessId" = v_business AND "erasedAt" IS NULL;
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;
  UPDATE public."ServiceIntakeTermsSnapshot" SET "presentedByUserId" = NULL, "erasedAt" = CURRENT_TIMESTAMP
   WHERE "businessId" = v_business AND "erasedAt" IS NULL;
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;
  UPDATE public."ServiceWarrantyOffer" SET "changeReason" = NULL, "presentedByUserId" = NULL, "createdByUserId" = NULL, "erasedAt" = CURRENT_TIMESTAMP
   WHERE "businessId" = v_business AND "erasedAt" IS NULL;
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;
  UPDATE public."ServiceIntakePhoto" SET "createdByUserId" = NULL, "erasedAt" = CURRENT_TIMESTAMP
   WHERE "businessId" = v_business AND "erasedAt" IS NULL;
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;
  UPDATE public."ServiceShareEvent" SET "actorUserId" = NULL, "erasedAt" = CURRENT_TIMESTAMP
   WHERE "businessId" = v_business AND "erasedAt" IS NULL;
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;
  UPDATE public."ServicePhoneReminder" SET "actorUserId" = NULL, "note" = NULL, "erasedAt" = CURRENT_TIMESTAMP
   WHERE "businessId" = v_business AND "erasedAt" IS NULL;
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;
  PERFORM set_config('dubiz.service_ui_erasure', 'off', true);

  PERFORM set_config('dubiz.service_storage_erasure', 'on', true);
  INSERT INTO public."ServiceStorageErasure" ("businessId") VALUES (v_business) ON CONFLICT ("businessId") DO NOTHING;
  PERFORM set_config('dubiz.service_storage_erasure', 'off', true);
  RETURN v_n;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_desk_ui_erase_business() FROM PUBLIC;

-- Pending storage-erasure jobs, oldest pass first (for the sweeper; business ids only, no other data).
CREATE OR REPLACE FUNCTION public.service_storage_erasure_due(p_limit integer)
RETURNS TABLE ("businessId" integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT e."businessId" FROM public."ServiceStorageErasure" e
   WHERE e."state" = 'PENDING_OBJECTS'
   ORDER BY e."lastPassAt" NULLS FIRST, e."businessId"
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 100)
$fn$;
REVOKE ALL ON FUNCTION public.service_storage_erasure_due(integer) FROM PUBLIC;

-- One pass of the object deletion for the tenant business: counts, the remaining objects listed after the pass and
-- the error (if any). The job becomes DONE only when the pass found nothing left, had no error, and the quarantine
-- is older than one hour (an upload that was in flight at quarantine is caught by a later pass). Returns the state.
CREATE OR REPLACE FUNCTION public.service_storage_erasure_record_pass(p_deleted integer, p_remaining integer, p_error text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_business integer := NULLIF(current_setting('app.current_business_id', true), '')::integer;
  v_job public."ServiceStorageErasure"%ROWTYPE;
  v_quarantined timestamp(3);
  v_done boolean;
BEGIN
  IF v_business IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU12', MESSAGE = 'SERVICE_STORAGE_ERASURE_NO_CONTEXT: no tenant context; nothing was changed';
  END IF;
  IF p_deleted IS NULL OR p_deleted < 0 OR p_remaining IS NULL OR p_remaining < 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU12', MESSAGE = 'SERVICE_STORAGE_ERASURE_INPUT: counts are non-negative';
  END IF;
  SELECT * INTO v_job FROM public."ServiceStorageErasure" WHERE "businessId" = v_business FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU12', MESSAGE = 'SERVICE_STORAGE_ERASURE_NO_JOB: no erasure job for this business (the purge did not commit)';
  END IF;
  IF v_job."state" = 'DONE' THEN
    RETURN 'DONE';
  END IF;
  SELECT COALESCE(b."deletionRequestedAt", b."deletedAt") INTO v_quarantined FROM public."Business" b WHERE b."id" = v_business;
  v_done := p_remaining = 0 AND p_error IS NULL AND v_quarantined IS NOT NULL AND v_quarantined <= CURRENT_TIMESTAMP - interval '1 hour';
  PERFORM set_config('dubiz.service_storage_erasure', 'on', true);
  UPDATE public."ServiceStorageErasure"
     SET "attempts" = "attempts" + 1, "objectsDeleted" = "objectsDeleted" + p_deleted, "lastPassAt" = CURRENT_TIMESTAMP,
         "lastPassRemaining" = p_remaining, "lastError" = CASE WHEN p_error IS NULL THEN NULL ELSE left(p_error, 500) END,
         "state" = CASE WHEN v_done THEN 'DONE'::"ServiceStorageErasureState" ELSE 'PENDING_OBJECTS'::"ServiceStorageErasureState" END,
         "completedAt" = CASE WHEN v_done THEN CURRENT_TIMESTAMP ELSE NULL END
   WHERE "businessId" = v_business;
  PERFORM set_config('dubiz.service_storage_erasure', 'off', true);
  RETURN CASE WHEN v_done THEN 'DONE' ELSE 'PENDING_OBJECTS' END;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_storage_erasure_record_pass(integer, integer, text) FROM PUBLIC;

-- ── 6. Row-level security — per operation, no DELETE policy ─────────────────────────────────────────────────
ALTER TABLE "ServiceTextVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ServiceTextVersion" FORCE ROW LEVEL SECURITY;
CREATE POLICY service_text_version_tenant_select ON "ServiceTextVersion" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_text_version_tenant_insert ON "ServiceTextVersion" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_text_version_tenant_update ON "ServiceTextVersion" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "ServiceSettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ServiceSettings" FORCE ROW LEVEL SECURITY;
CREATE POLICY service_settings_tenant_select ON "ServiceSettings" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_settings_tenant_insert ON "ServiceSettings" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_settings_tenant_update ON "ServiceSettings" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "ServiceIntakeTermsSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ServiceIntakeTermsSnapshot" FORCE ROW LEVEL SECURITY;
CREATE POLICY service_intake_terms_tenant_select ON "ServiceIntakeTermsSnapshot" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_intake_terms_tenant_insert ON "ServiceIntakeTermsSnapshot" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "ServiceWarrantyOffer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ServiceWarrantyOffer" FORCE ROW LEVEL SECURITY;
CREATE POLICY service_warranty_offer_tenant_select ON "ServiceWarrantyOffer" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_warranty_offer_tenant_insert ON "ServiceWarrantyOffer" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_warranty_offer_tenant_update ON "ServiceWarrantyOffer" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "ServiceIntakePhoto" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ServiceIntakePhoto" FORCE ROW LEVEL SECURITY;
CREATE POLICY service_intake_photo_tenant_select ON "ServiceIntakePhoto" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_intake_photo_tenant_insert ON "ServiceIntakePhoto" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "ServiceShareEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ServiceShareEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY service_share_event_tenant_select ON "ServiceShareEvent" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_share_event_tenant_insert ON "ServiceShareEvent" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "ServicePhoneReminder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ServicePhoneReminder" FORCE ROW LEVEL SECURITY;
CREATE POLICY service_phone_reminder_tenant_select ON "ServicePhoneReminder" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_phone_reminder_tenant_insert ON "ServicePhoneReminder" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "ServiceStorageErasure" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ServiceStorageErasure" FORCE ROW LEVEL SECURITY;
CREATE POLICY service_storage_erasure_tenant_select ON "ServiceStorageErasure" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── 7. Privileges — named explicitly ────────────────────────────────────────────────────────────────────────
REVOKE ALL ON "ServiceTextVersion", "ServiceSettings", "ServiceIntakeTermsSnapshot", "ServiceWarrantyOffer", "ServiceIntakePhoto",
              "ServiceShareEvent", "ServicePhoneReminder", "ServiceStorageErasure" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "ServiceTextVersion_id_seq", "ServiceIntakeTermsSnapshot_id_seq", "ServiceWarrantyOffer_id_seq",
                       "ServiceIntakePhoto_id_seq", "ServiceShareEvent_id_seq", "ServicePhoneReminder_id_seq" FROM PUBLIC;
DO $do$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT c.oid::regclass::text AS rel, pg_get_userbyid(x.grantee) AS grantee, c.relkind
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
     WHERE c.relname IN ('ServiceTextVersion', 'ServiceSettings', 'ServiceIntakeTermsSnapshot', 'ServiceWarrantyOffer', 'ServiceIntakePhoto',
                         'ServiceShareEvent', 'ServicePhoneReminder', 'ServiceStorageErasure',
                         'ServiceTextVersion_id_seq', 'ServiceIntakeTermsSnapshot_id_seq', 'ServiceWarrantyOffer_id_seq',
                         'ServiceIntakePhoto_id_seq', 'ServiceShareEvent_id_seq', 'ServicePhoneReminder_id_seq')
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
GRANT SELECT, INSERT, UPDATE ON "ServiceTextVersion", "ServiceSettings", "ServiceWarrantyOffer" TO app_runtime;
GRANT SELECT, INSERT ON "ServiceIntakeTermsSnapshot", "ServiceIntakePhoto", "ServiceShareEvent", "ServicePhoneReminder" TO app_runtime;
GRANT SELECT ON "ServiceStorageErasure" TO app_runtime;
GRANT USAGE, SELECT ON SEQUENCE "ServiceTextVersion_id_seq", "ServiceIntakeTermsSnapshot_id_seq", "ServiceWarrantyOffer_id_seq",
                                "ServiceIntakePhoto_id_seq", "ServiceShareEvent_id_seq", "ServicePhoneReminder_id_seq" TO app_runtime;
GRANT EXECUTE ON FUNCTION public.service_desk_ui_erase_business() TO app_runtime;
GRANT EXECUTE ON FUNCTION public.service_storage_erasure_due(integer) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.service_storage_erasure_record_pass(integer, integer, text) TO app_runtime;
-- Invoker helpers the guards call run as the caller: the runtime must be able to call them.
GRANT EXECUTE ON FUNCTION public.service_ui_business_writable(integer) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.service_ui_in_erasure(oid) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.service_warranty_end(date, integer, "ServiceDurationUnit") TO app_runtime;

-- ── 8. The feature flag — seeded OFF (no business sees the module until an explicit owner decision) ─────────
INSERT INTO "PlatformFeatureDefinition" ("key", "displayName", "category", "description", "defaultEnabled", "mutable", "createdAt")
VALUES ('service_desk', 'תיקונים ושירות', 'service', 'קריאות שירות ותיקונים: קבלת מכשיר, טיפול, ספק חיצוני, הצעת מחיר ומסירה — כבוי כברירת מחדל', false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
INSERT INTO "PlatformFeaturePolicy" ("featureKey", "globalEnabled", "emergencyDisabled", "updatedAt")
VALUES ('service_desk', false, false, CURRENT_TIMESTAMP)
ON CONFLICT ("featureKey") DO NOTHING;
