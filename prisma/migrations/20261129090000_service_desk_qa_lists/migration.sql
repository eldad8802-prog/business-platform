-- ============================================================================================================
-- 20261129090000_service_desk_qa_lists — Service Desk: per-business QA (quality-check) lists, chosen per case, with the
-- results of every check stored in the case. DRAFT — never applied without the owner's separate approval. Order: after
-- 20261127090000 (M1 tracks, #1118), which it requires (its CHECK ServiceCaseEvent_tracks_in_place is the premise).
--
-- Owner decision 2026-11-11 (development incl. the schema approved): every business that uses Service Desk defines its
-- own QA lists; nothing depends on its category. A list starts empty or from a built-in suggested template
-- (lib/services/service-desk/qa-templates.ts — copied, never linked); the business edits it (name, checks added /
-- removed / reordered, each check REQUIRED or optional); a case may name one list; the results of each check are stored
-- in the case; a change of a list never changes what an older case was checked against or recorded.
--
--   "ServiceQaList"            the list's head: which content version is current, archived or not, the template it was
--                              started from (a code token). No text of its own. Every change bumps "revision" and is
--                              journaled at that revision (deferred check).
--   "ServiceQaListVersion"     IMMUTABLE content versions 1, 2, … — the name and the number of checks. A version is
--                              written whole, in one transaction: its items are counted at COMMIT and no item can be
--                              added later (the count is fixed).
--   "ServiceQaListItem"        IMMUTABLE checks of one version: a stable key (token), the label, REQUIRED or not, the
--                              position.
--   "ServiceQaListEvent"       the lists' journal and idempotency ledger (like ServiceSettingsEvent): CREATE / REVISE /
--                              ARCHIVE / RESTORE, the revision and content version it produced, counts — never text.
--   "ServiceCaseQaRecord"      one per RECORD_QA journal event of a case (seq = case version): which checklist it was
--                              judged against (a list VERSION, or a built-in template id), the counts and whether QA
--                              is complete — the counts are re-derived from the rows at COMMIT, never trusted.
--   "ServiceCaseQaItemResult"  the result of each check in that record: PASS / FAIL, the check's REQUIRED flag as it was
--                              in that version, an optional note.
--   "ServiceCase"              + "qaListId", "qaListVersion" (NULL = no list chosen: the case is checked against its
--                              track's / kind's built-in template exactly as today). The choice names a VERSION, so a
--                              later edit of the list never reaches the case; choosing again takes the list's current
--                              version and resets the case's QA completion. Journaled (CHOOSE_QA_LIST, deferred check).
--   journal                    ServiceCaseAction CHOOSE_QA_LIST / ServiceEventType qa.list_chosen: status-preserving,
--                              by the owner (ServiceCaseEvent_qa_list_in_place).
--   erasure                    service_qa_lists_erase_business() — SECURITY DEFINER, its own function: list names, check
--                              labels, result notes and who acted are blanked in place; the structure stays.
--
-- The track rules are not changed: QA REQUIRED still needs a passing QA (with a list: every REQUIRED check of the chosen
-- version PASS — enforced at COMMIT: a case with a list counts as QA-complete only when its latest record against that
-- version is complete); OPTIONAL / OFF as today; no list is ever required to open a case.
--
-- Unchanged: every existing table, row, constraint, policy, grant and function. ServiceCase gets two NULLable columns
-- (every existing row stays NULL, no rewrite), three new triggers that act only when those columns change or a QA
-- completion is stamped on a case WITH a list (a case without a list behaves exactly as today).
-- ============================================================================================================

-- ── 0. Premises ─────────────────────────────────────────────────────────────────────────────────────────────
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    RAISE EXCEPTION 'SERVICE_DESK_QA_LISTS: role app_runtime is missing; nothing was changed';
  END IF;
  IF to_regclass('public."ServiceCase"') IS NULL OR to_regclass('public."ServiceCaseEvent"') IS NULL THEN
    RAISE EXCEPTION 'SERVICE_DESK_QA_LISTS: the Service Desk foundation is missing; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ServiceCase_businessId_id_key')
     OR NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ServiceCaseEvent_businessId_caseId_seq_key') THEN
    RAISE EXCEPTION 'SERVICE_DESK_QA_LISTS: a composite key this migration references is missing; nothing was changed';
  END IF;
  IF to_regprocedure('public.service_user_same_business()') IS NULL OR to_regprocedure('public.service_journal_truncate_guard()') IS NULL
     OR to_regprocedure('public.service_ui_business_writable(integer)') IS NULL THEN
    RAISE EXCEPTION 'SERVICE_DESK_QA_LISTS: the Service Desk trigger functions are missing; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ServiceCaseEvent_record_in_place')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ServiceCaseEvent_tracks_in_place') THEN
    RAISE EXCEPTION 'SERVICE_DESK_QA_LISTS: the P4 journal (20261122090000) or M1 tracks (20261127090000) is not applied; nothing was changed';
  END IF;
END
$do$;

SET lock_timeout = '5s';

-- ── 1. Types ────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TYPE "ServiceQaResult" AS ENUM ('PASS', 'FAIL');
CREATE TYPE "ServiceQaListAction" AS ENUM ('CREATE', 'REVISE', 'ARCHIVE', 'RESTORE');

ALTER TYPE "ServiceCaseAction" ADD VALUE IF NOT EXISTS 'CHOOSE_QA_LIST';
ALTER TYPE "ServiceEventType" ADD VALUE IF NOT EXISTS 'qa.list_chosen';

-- The choice of a list is a STATUS-PRESERVING case record, by the owner, with its own event type (compared as text: the
-- new enum values are not used before this transaction ends). The payload stays closed (ServiceCaseEvent_payload_closed).
ALTER TABLE "ServiceCaseEvent" ADD CONSTRAINT "ServiceCaseEvent_qa_list_in_place" CHECK (
      ("action"::text = 'CHOOSE_QA_LIST') = ("eventType"::text = 'qa.list_chosen')
  AND ("action"::text <> 'CHOOSE_QA_LIST' OR (
            "fromStatus" = "toStatus"
        AND "holdReasonBefore" IS NOT DISTINCT FROM "holdReasonAfter"
        AND "cancellationRequestedBefore" = "cancellationRequestedAfter"
        AND "actor" = 'OWNER_USER'))) NOT VALID;
ALTER TABLE "ServiceCaseEvent" VALIDATE CONSTRAINT "ServiceCaseEvent_qa_list_in_place";

-- ── 2. Tables ───────────────────────────────────────────────────────────────────────────────────────────────
-- 2.1 The list's head.
CREATE TABLE "ServiceQaList" (
  "id"               SERIAL NOT NULL,
  "businessId"       INTEGER NOT NULL,
  "currentVersion"   INTEGER NOT NULL,
  "revision"         INTEGER NOT NULL,
  -- the built-in template the list was started from (a code id such as VEHICLE.v1) — a token, never linked
  "sourceTemplateId" TEXT,
  "archivedAt"       TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ServiceQaList_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ServiceQaList_counters" CHECK ("currentVersion" >= 1 AND "revision" >= "currentVersion"),
  CONSTRAINT "ServiceQaList_source" CHECK ("sourceTemplateId" IS NULL OR "sourceTemplateId" ~ '^[A-Z][A-Z_]{0,39}\.v[0-9]{1,3}$')
);
CREATE UNIQUE INDEX "ServiceQaList_businessId_id_key" ON "ServiceQaList"("businessId", "id");
ALTER TABLE "ServiceQaList" ADD CONSTRAINT "ServiceQaList_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2.2 Immutable content versions.
CREATE TABLE "ServiceQaListVersion" (
  "id"              SERIAL NOT NULL,
  "businessId"      INTEGER NOT NULL,
  "listId"          INTEGER NOT NULL,
  "version"         INTEGER NOT NULL,
  "name"            TEXT,
  "itemCount"       INTEGER NOT NULL,
  "requiredCount"   INTEGER NOT NULL,
  "createdByUserId" INTEGER,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "erasedAt"        TIMESTAMP(3),
  CONSTRAINT "ServiceQaListVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ServiceQaListVersion_counts" CHECK ("version" >= 1 AND "itemCount" BETWEEN 1 AND 100 AND "requiredCount" BETWEEN 0 AND "itemCount"),
  -- the name: 1–120 characters, trimmed; NULL only after the account erasure
  CONSTRAINT "ServiceQaListVersion_name" CHECK (
    CASE WHEN "name" IS NULL THEN "erasedAt" IS NOT NULL
         ELSE char_length("name") BETWEEN 1 AND 120 AND "name" = btrim("name") AND "name" !~ '[[:cntrl:]]' END)
);
CREATE UNIQUE INDEX "ServiceQaListVersion_businessId_id_key" ON "ServiceQaListVersion"("businessId", "id");
CREATE UNIQUE INDEX "ServiceQaListVersion_businessId_listId_version_key" ON "ServiceQaListVersion"("businessId", "listId", "version");
ALTER TABLE "ServiceQaListVersion" ADD CONSTRAINT "ServiceQaListVersion_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceQaListVersion" ADD CONSTRAINT "ServiceQaListVersion_list_tenant_fkey"
  FOREIGN KEY ("businessId", "listId") REFERENCES "ServiceQaList"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServiceQaListVersion" ADD CONSTRAINT "ServiceQaListVersion_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- The head names a version that exists (deferred: the head and its first / next version are written in one transaction).
ALTER TABLE "ServiceQaList" ADD CONSTRAINT "ServiceQaList_current_version_fkey"
  FOREIGN KEY ("businessId", "id", "currentVersion") REFERENCES "ServiceQaListVersion"("businessId", "listId", "version")
  ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

-- 2.3 Immutable checks of a version.
CREATE TABLE "ServiceQaListItem" (
  "id"          SERIAL NOT NULL,
  "businessId"  INTEGER NOT NULL,
  "listId"      INTEGER NOT NULL,
  "listVersion" INTEGER NOT NULL,
  "position"    INTEGER NOT NULL,
  "itemKey"     TEXT NOT NULL,
  "label"       TEXT,
  "required"    BOOLEAN NOT NULL,
  "erasedAt"    TIMESTAMP(3),
  CONSTRAINT "ServiceQaListItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ServiceQaListItem_position" CHECK ("position" BETWEEN 1 AND 100),
  CONSTRAINT "ServiceQaListItem_key" CHECK ("itemKey" ~ '^[a-z][a-z0-9_]{0,39}$'),
  CONSTRAINT "ServiceQaListItem_label" CHECK (
    CASE WHEN "label" IS NULL THEN "erasedAt" IS NOT NULL
         ELSE char_length("label") BETWEEN 1 AND 200 AND "label" = btrim("label") AND "label" !~ '[[:cntrl:]]' END)
);
CREATE UNIQUE INDEX "ServiceQaListItem_businessId_id_key" ON "ServiceQaListItem"("businessId", "id");
CREATE UNIQUE INDEX "ServiceQaListItem_businessId_listId_listVersion_itemKey_key" ON "ServiceQaListItem"("businessId", "listId", "listVersion", "itemKey");
CREATE UNIQUE INDEX "ServiceQaListItem_businessId_listId_listVersion_position_key" ON "ServiceQaListItem"("businessId", "listId", "listVersion", "position");
ALTER TABLE "ServiceQaListItem" ADD CONSTRAINT "ServiceQaListItem_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceQaListItem" ADD CONSTRAINT "ServiceQaListItem_version_tenant_fkey"
  FOREIGN KEY ("businessId", "listId", "listVersion") REFERENCES "ServiceQaListVersion"("businessId", "listId", "version")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

-- 2.4 The lists' journal (also the idempotency ledger of the list commands). Counts and tokens only — never a text.
CREATE TABLE "ServiceQaListEvent" (
  "id"             SERIAL NOT NULL,
  "businessId"     INTEGER NOT NULL,
  "listId"         INTEGER NOT NULL,
  "revision"       INTEGER NOT NULL,
  "action"         "ServiceQaListAction" NOT NULL,
  "listVersion"    INTEGER NOT NULL,
  "itemCount"      INTEGER NOT NULL,
  "requiredCount"  INTEGER NOT NULL,
  "actor"          "ServiceActor" NOT NULL,
  "actorUserId"    INTEGER,
  "occurredAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "idempotencyKey" TEXT NOT NULL,
  "requestDigest"  TEXT,
  "digestKeyId"    TEXT,
  CONSTRAINT "ServiceQaListEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ServiceQaListEvent_counters" CHECK (
        "revision" >= 1 AND "listVersion" >= 1 AND "revision" >= "listVersion"
    AND "itemCount" BETWEEN 1 AND 100 AND "requiredCount" BETWEEN 0 AND "itemCount"
    AND (("action" = 'CREATE') = ("revision" = 1))
    AND ("action" <> 'CREATE' OR "listVersion" = 1)),
  CONSTRAINT "ServiceQaListEvent_by_owner" CHECK ("actor" = 'OWNER_USER'),
  CONSTRAINT "ServiceQaListEvent_tokens" CHECK (
        "idempotencyKey" ~ '^[A-Za-z0-9:_#-]{8,200}$'
    AND ("requestDigest" IS NULL OR "requestDigest" ~ '^[0-9a-f]{64}$')
    AND ("digestKeyId" IS NULL OR "digestKeyId" ~ '^[A-Za-z0-9_-]{1,32}$')
    AND (("requestDigest" IS NULL) = ("digestKeyId" IS NULL)))
);
CREATE UNIQUE INDEX "ServiceQaListEvent_businessId_idempotencyKey_key" ON "ServiceQaListEvent"("businessId", "idempotencyKey");
CREATE UNIQUE INDEX "ServiceQaListEvent_businessId_listId_revision_key" ON "ServiceQaListEvent"("businessId", "listId", "revision");
ALTER TABLE "ServiceQaListEvent" ADD CONSTRAINT "ServiceQaListEvent_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceQaListEvent" ADD CONSTRAINT "ServiceQaListEvent_list_tenant_fkey"
  FOREIGN KEY ("businessId", "listId") REFERENCES "ServiceQaList"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServiceQaListEvent" ADD CONSTRAINT "ServiceQaListEvent_version_tenant_fkey"
  FOREIGN KEY ("businessId", "listId", "listVersion") REFERENCES "ServiceQaListVersion"("businessId", "listId", "version")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServiceQaListEvent" ADD CONSTRAINT "ServiceQaListEvent_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 2.5 The case's choice: a list VERSION of the same business (NULL = no list: today's built-in template).
ALTER TABLE "ServiceCase"
  ADD COLUMN "qaListId"      INTEGER,
  ADD COLUMN "qaListVersion" INTEGER;
ALTER TABLE "ServiceCase" ADD CONSTRAINT "ServiceCase_qa_list_pair" CHECK (("qaListId" IS NULL) = ("qaListVersion" IS NULL)) NOT VALID;
ALTER TABLE "ServiceCase" VALIDATE CONSTRAINT "ServiceCase_qa_list_pair";
CREATE INDEX "ServiceCase_businessId_qaListId_idx" ON "ServiceCase"("businessId", "qaListId") WHERE "qaListId" IS NOT NULL;
ALTER TABLE "ServiceCase" ADD CONSTRAINT "ServiceCase_qa_list_version_fkey"
  FOREIGN KEY ("businessId", "qaListId", "qaListVersion") REFERENCES "ServiceQaListVersion"("businessId", "listId", "version")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

-- 2.6 One QA record per RECORD_QA event (seq = the case version it produced).
CREATE TABLE "ServiceCaseQaRecord" (
  "id"              SERIAL NOT NULL,
  "businessId"      INTEGER NOT NULL,
  "caseId"          INTEGER NOT NULL,
  "caseVersion"     INTEGER NOT NULL,
  "listId"          INTEGER,
  "listVersion"     INTEGER,
  -- a built-in template id (IN_SHOP.v1, VEHICLE.v1, …) when the case has no list — a code token
  "templateId"      TEXT,
  "itemCount"       INTEGER NOT NULL,
  "resultCount"     INTEGER NOT NULL,
  "passCount"       INTEGER NOT NULL,
  "failCount"       INTEGER NOT NULL,
  "requiredMissing" INTEGER NOT NULL,
  "requiredFailed"  INTEGER NOT NULL,
  "completed"       BOOLEAN NOT NULL,
  "actorUserId"     INTEGER,
  "recordedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "erasedAt"        TIMESTAMP(3),
  CONSTRAINT "ServiceCaseQaRecord_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ServiceCaseQaRecord_version" CHECK ("caseVersion" >= 2),
  -- exactly one checklist: a list version, or a built-in template
  CONSTRAINT "ServiceCaseQaRecord_checklist" CHECK (
        (("listId" IS NULL) = ("listVersion" IS NULL))
    AND (("listId" IS NULL) <> ("templateId" IS NULL))
    AND ("templateId" IS NULL OR "templateId" ~ '^[A-Z][A-Z_]{0,39}\.v[0-9]{1,3}$')),
  CONSTRAINT "ServiceCaseQaRecord_counts" CHECK (
        "itemCount" BETWEEN 1 AND 100
    AND "resultCount" BETWEEN 1 AND "itemCount"
    AND "passCount" >= 0 AND "failCount" >= 0 AND "passCount" + "failCount" = "resultCount"
    AND "requiredMissing" >= 0 AND "requiredFailed" >= 0 AND "requiredFailed" <= "failCount"
    AND "requiredMissing" <= "itemCount" - "resultCount"
    AND "completed" = ("requiredMissing" = 0 AND "requiredFailed" = 0))
);
CREATE UNIQUE INDEX "ServiceCaseQaRecord_businessId_id_key" ON "ServiceCaseQaRecord"("businessId", "id");
CREATE UNIQUE INDEX "ServiceCaseQaRecord_businessId_caseId_caseVersion_key" ON "ServiceCaseQaRecord"("businessId", "caseId", "caseVersion");
CREATE INDEX "ServiceCaseQaRecord_businessId_listId_listVersion_idx" ON "ServiceCaseQaRecord"("businessId", "listId", "listVersion") WHERE "listId" IS NOT NULL;
ALTER TABLE "ServiceCaseQaRecord" ADD CONSTRAINT "ServiceCaseQaRecord_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceCaseQaRecord" ADD CONSTRAINT "ServiceCaseQaRecord_case_tenant_fkey"
  FOREIGN KEY ("businessId", "caseId") REFERENCES "ServiceCase"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
-- its journal event (same case, seq = caseVersion); deferred, so the event and this record may be written in either order
ALTER TABLE "ServiceCaseQaRecord" ADD CONSTRAINT "ServiceCaseQaRecord_event_fkey"
  FOREIGN KEY ("businessId", "caseId", "caseVersion") REFERENCES "ServiceCaseEvent"("businessId", "caseId", "seq")
  ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "ServiceCaseQaRecord" ADD CONSTRAINT "ServiceCaseQaRecord_version_tenant_fkey"
  FOREIGN KEY ("businessId", "listId", "listVersion") REFERENCES "ServiceQaListVersion"("businessId", "listId", "version")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ServiceCaseQaRecord" ADD CONSTRAINT "ServiceCaseQaRecord_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 2.7 The result of each check of a record.
CREATE TABLE "ServiceCaseQaItemResult" (
  "id"          SERIAL NOT NULL,
  "businessId"  INTEGER NOT NULL,
  "recordId"    INTEGER NOT NULL,
  "listId"      INTEGER,
  "listVersion" INTEGER,
  "itemKey"     TEXT NOT NULL,
  "required"    BOOLEAN NOT NULL,
  "result"      "ServiceQaResult" NOT NULL,
  "note"        TEXT,
  "erasedAt"    TIMESTAMP(3),
  CONSTRAINT "ServiceCaseQaItemResult_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ServiceCaseQaItemResult_key" CHECK ("itemKey" ~ '^[a-z][a-z0-9_]{0,39}$'),
  CONSTRAINT "ServiceCaseQaItemResult_list_pair" CHECK (("listId" IS NULL) = ("listVersion" IS NULL)),
  CONSTRAINT "ServiceCaseQaItemResult_note" CHECK (
    "note" IS NULL OR (char_length("note") BETWEEN 1 AND 500 AND "note" = btrim("note")))
);
CREATE UNIQUE INDEX "ServiceCaseQaItemResult_businessId_id_key" ON "ServiceCaseQaItemResult"("businessId", "id");
CREATE UNIQUE INDEX "ServiceCaseQaItemResult_businessId_recordId_itemKey_key" ON "ServiceCaseQaItemResult"("businessId", "recordId", "itemKey");
ALTER TABLE "ServiceCaseQaItemResult" ADD CONSTRAINT "ServiceCaseQaItemResult_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceCaseQaItemResult" ADD CONSTRAINT "ServiceCaseQaItemResult_record_tenant_fkey"
  FOREIGN KEY ("businessId", "recordId") REFERENCES "ServiceCaseQaRecord"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
-- a check of a list version exists in THAT version (the record's — the guard compares them)
ALTER TABLE "ServiceCaseQaItemResult" ADD CONSTRAINT "ServiceCaseQaItemResult_item_tenant_fkey"
  FOREIGN KEY ("businessId", "listId", "listVersion", "itemKey") REFERENCES "ServiceQaListItem"("businessId", "listId", "listVersion", "itemKey")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

-- The acting user belongs to the business (the foundation's shared guard, reused unchanged).
CREATE TRIGGER "ServiceQaListVersion_user_same_business"
  BEFORE INSERT OR UPDATE OF "businessId", "createdByUserId" ON "ServiceQaListVersion"
  FOR EACH ROW EXECUTE FUNCTION public.service_user_same_business('createdByUserId');
CREATE TRIGGER "ServiceQaListEvent_user_same_business"
  BEFORE INSERT OR UPDATE OF "businessId", "actorUserId" ON "ServiceQaListEvent"
  FOR EACH ROW EXECUTE FUNCTION public.service_user_same_business('actorUserId');
CREATE TRIGGER "ServiceCaseQaRecord_user_same_business"
  BEFORE INSERT OR UPDATE OF "businessId", "actorUserId" ON "ServiceCaseQaRecord"
  FOR EACH ROW EXECUTE FUNCTION public.service_user_same_business('actorUserId');

-- ── 3. Guards ───────────────────────────────────────────────────────────────────────────────────────────────
-- The erasure scrub runs only inside service_qa_lists_erase_business() (marker + table owner, the foundation's
-- convention: app_runtime can set the marker, never become the owner).
CREATE OR REPLACE FUNCTION public.service_qa_in_erasure(p_relid oid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT current_setting('dubiz.service_qa_erasure', true) = 'on'
     AND current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = p_relid)
$fn$;
REVOKE ALL ON FUNCTION public.service_qa_in_erasure(oid) FROM PUBLIC;

-- 3.1 The head: born at revision 1 / version 1, not archived; then every change is exactly one revision — a new content
-- version (not archived) OR an archive / restore — never both, never backwards; identity, origin and creation fixed.
-- DELETE only by the cascade of a deleted business; TRUNCATE never. Writes only while the business is writable.
CREATE OR REPLACE FUNCTION public.service_qa_list_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  content_changed boolean;
  archive_changed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
    RAISE EXCEPTION USING ERRCODE = 'DZS09', MESSAGE = 'SERVICE_QA_LIST_FIXED: a QA list is archived, never deleted';
  END IF;
  IF NOT public.service_ui_business_writable(NEW."businessId") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU02', MESSAGE = 'SERVICE_UI_BUSINESS_DELETING: the business is being deleted; nothing was written';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."currentVersion" <> 1 OR NEW."revision" <> 1 OR NEW."archivedAt" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'DZS09', MESSAGE = 'SERVICE_QA_LIST_NEW: a list is born at revision 1, version 1, not archived';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."businessId" <> OLD."businessId" OR NEW."createdAt" <> OLD."createdAt"
     OR NEW."sourceTemplateId" IS DISTINCT FROM OLD."sourceTemplateId" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS09', MESSAGE = 'SERVICE_QA_LIST_IDENTITY_FIXED: id, business, origin and creation time never change';
  END IF;
  content_changed := NEW."currentVersion" <> OLD."currentVersion";
  archive_changed := (NEW."archivedAt" IS NULL) <> (OLD."archivedAt" IS NULL);
  IF NEW."revision" <> OLD."revision" + 1
     OR (content_changed AND NEW."currentVersion" <> OLD."currentVersion" + 1)
     OR content_changed = archive_changed
     OR (content_changed AND (OLD."archivedAt" IS NOT NULL OR NEW."archivedAt" IS NOT NULL))
     OR (NOT archive_changed AND NEW."archivedAt" IS DISTINCT FROM OLD."archivedAt") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS09',
      MESSAGE = 'SERVICE_QA_LIST_REVISION: a change is one revision — the next content version of an active list, or an archive / restore';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_qa_list_guard() FROM PUBLIC;
CREATE TRIGGER "ServiceQaList_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ServiceQaList"
  FOR EACH ROW EXECUTE FUNCTION public.service_qa_list_guard();
CREATE TRIGGER "ServiceQaList_no_truncate" BEFORE TRUNCATE ON "ServiceQaList"
  FOR EACH STATEMENT EXECUTE FUNCTION public.service_journal_truncate_guard();

-- 3.2 Every head row written is journaled at its revision (checked at COMMIT against the head as it then stands): the
-- event names the head's content version; CREATE at revision 1, REVISE when the content moved, ARCHIVE / RESTORE by the
-- archive stamp. Fails closed: an event the transaction cannot see counts as missing.
CREATE OR REPLACE FUNCTION public.service_qa_list_journaled()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  h record;
  e record;
BEGIN
  SELECT "revision", "currentVersion", "archivedAt" INTO h FROM public."ServiceQaList" WHERE "businessId" = NEW."businessId" AND "id" = NEW."id";
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT "action"::text AS action, "listVersion" INTO e FROM public."ServiceQaListEvent"
   WHERE "businessId" = NEW."businessId" AND "listId" = NEW."id" AND "revision" = h."revision";
  IF NOT FOUND OR e."listVersion" <> h."currentVersion"
     OR (e.action = 'ARCHIVE' AND h."archivedAt" IS NULL)
     OR (e.action IN ('RESTORE', 'REVISE', 'CREATE') AND h."archivedAt" IS NOT NULL)
     OR (e.action = 'REVISE' AND NOT EXISTS (SELECT 1 FROM public."ServiceQaListEvent" p
                                               WHERE p."businessId" = NEW."businessId" AND p."listId" = NEW."id"
                                                 AND p."revision" = h."revision" - 1 AND p."listVersion" = h."currentVersion" - 1))
     OR (e.action IN ('ARCHIVE', 'RESTORE') AND NOT EXISTS (SELECT 1 FROM public."ServiceQaListEvent" p
                                               WHERE p."businessId" = NEW."businessId" AND p."listId" = NEW."id"
                                                 AND p."revision" = h."revision" - 1 AND p."listVersion" = h."currentVersion")) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS09',
      MESSAGE = format('SERVICE_QA_LIST_NOT_JOURNALED: list %s changed without its journal event at revision %s', NEW."id", h."revision");
  END IF;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_qa_list_journaled() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER "ServiceQaList_journaled" AFTER INSERT OR UPDATE ON "ServiceQaList"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.service_qa_list_journaled();

-- 3.3 A content version: written once, as the head's current version (the head is updated first and locked here), by a
-- user, never born erased; then immutable — UPDATE only by the erasure (name and user to NULL, erasedAt set) or the FK
-- action of a deleted user; DELETE only by a cascade; TRUNCATE never.
CREATE OR REPLACE FUNCTION public.service_qa_list_version_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  erasable constant text[] := ARRAY['name', 'createdByUserId', 'erasedAt'];
  v_current integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF public.service_qa_in_erasure(TG_RELID)
       AND (to_jsonb(NEW) - erasable) = (to_jsonb(OLD) - erasable)
       AND NEW."name" IS NULL AND NEW."createdByUserId" IS NULL AND NEW."erasedAt" IS NOT NULL THEN
      RETURN NEW;
    END IF;
    IF pg_trigger_depth() > 1 AND NEW."createdByUserId" IS NULL
       AND (to_jsonb(NEW) - 'createdByUserId') = (to_jsonb(OLD) - 'createdByUserId') THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NOT public.service_ui_business_writable(NEW."businessId") THEN
      RAISE EXCEPTION USING ERRCODE = 'DZU02', MESSAGE = 'SERVICE_UI_BUSINESS_DELETING: the business is being deleted; nothing was written';
    END IF;
    IF NEW."erasedAt" IS NOT NULL OR NEW."createdByUserId" IS NULL OR NEW."name" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'DZS09', MESSAGE = 'SERVICE_QA_LIST_VERSION_NEW: a version is named, written by a user and never born erased';
    END IF;
    SELECT "currentVersion" INTO v_current FROM public."ServiceQaList"
     WHERE "businessId" = NEW."businessId" AND "id" = NEW."listId" FOR UPDATE;
    IF v_current IS NULL OR v_current <> NEW."version" THEN
      RAISE EXCEPTION USING ERRCODE = 'DZS09',
        MESSAGE = format('SERVICE_QA_LIST_VERSION_NOT_CURRENT: version %s is not the list''s current version', NEW."version");
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'DZS09',
    MESSAGE = format('SERVICE_QA_LIST_VERSION_FIXED: %s on %I is refused; a list version never changes', TG_OP, TG_TABLE_NAME);
END
$fn$;
REVOKE ALL ON FUNCTION public.service_qa_list_version_guard() FROM PUBLIC;
CREATE TRIGGER "ServiceQaListVersion_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ServiceQaListVersion"
  FOR EACH ROW EXECUTE FUNCTION public.service_qa_list_version_guard();
CREATE TRIGGER "ServiceQaListVersion_no_truncate" BEFORE TRUNCATE ON "ServiceQaListVersion"
  FOR EACH STATEMENT EXECUTE FUNCTION public.service_journal_truncate_guard();

-- 3.4 At COMMIT a version holds exactly its declared checks, positions 1..n, with its declared number of REQUIRED ones.
CREATE OR REPLACE FUNCTION public.service_qa_list_version_complete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  n integer;
  r integer;
  maxpos integer;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE i."required"), max(i."position") INTO n, r, maxpos FROM public."ServiceQaListItem" i
   WHERE i."businessId" = NEW."businessId" AND i."listId" = NEW."listId" AND i."listVersion" = NEW."version";
  IF n <> NEW."itemCount" OR r <> NEW."requiredCount" OR maxpos IS DISTINCT FROM NEW."itemCount" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS09',
      MESSAGE = format('SERVICE_QA_LIST_VERSION_INCOMPLETE: version %s of list %s declares %s checks (%s required), holds %s (%s required)',
                       NEW."version", NEW."listId", NEW."itemCount", NEW."requiredCount", n, r);
  END IF;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_qa_list_version_complete() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER "ServiceQaListVersion_complete" AFTER INSERT ON "ServiceQaListVersion"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.service_qa_list_version_complete();

-- 3.5 A check: added only while its version is being written (the version not yet full — the count is fixed, so a
-- committed version never gains a check), never born erased; then immutable — UPDATE only by the erasure (label to
-- NULL, erasedAt set); DELETE only by a cascade; TRUNCATE never.
CREATE OR REPLACE FUNCTION public.service_qa_list_item_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  erasable constant text[] := ARRAY['label', 'erasedAt'];
  v_count integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF public.service_qa_in_erasure(TG_RELID)
       AND (to_jsonb(NEW) - erasable) = (to_jsonb(OLD) - erasable)
       AND NEW."label" IS NULL AND NEW."erasedAt" IS NOT NULL THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NEW."erasedAt" IS NOT NULL OR NEW."label" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'DZS09', MESSAGE = 'SERVICE_QA_LIST_ITEM_NEW: a check has a label and is never born erased';
    END IF;
    SELECT v."itemCount" INTO v_count FROM public."ServiceQaListVersion" v
     WHERE v."businessId" = NEW."businessId" AND v."listId" = NEW."listId" AND v."version" = NEW."listVersion";
    IF v_count IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'DZS09', MESSAGE = 'SERVICE_QA_LIST_ITEM_VERSION: no such list version in this business';
    END IF;
    IF (SELECT count(*) FROM public."ServiceQaListItem" i
         WHERE i."businessId" = NEW."businessId" AND i."listId" = NEW."listId" AND i."listVersion" = NEW."listVersion") >= v_count THEN
      RAISE EXCEPTION USING ERRCODE = 'DZS09', MESSAGE = 'SERVICE_QA_LIST_VERSION_FIXED: the version holds all its checks; a change is a new version';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'DZS09',
    MESSAGE = format('SERVICE_QA_LIST_ITEM_FIXED: %s on %I is refused; a check of a version never changes', TG_OP, TG_TABLE_NAME);
END
$fn$;
REVOKE ALL ON FUNCTION public.service_qa_list_item_guard() FROM PUBLIC;
CREATE TRIGGER "ServiceQaListItem_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ServiceQaListItem"
  FOR EACH ROW EXECUTE FUNCTION public.service_qa_list_item_guard();
CREATE TRIGGER "ServiceQaListItem_no_truncate" BEFORE TRUNCATE ON "ServiceQaListItem"
  FOR EACH STATEMENT EXECUTE FUNCTION public.service_journal_truncate_guard();

-- 3.6 The lists' journal: an event names the head as it stands in this transaction (revision, content version) and its
-- counts are the version's; by an owner user. Append-only: UPDATE only by the erasure (user and digest to NULL) or the
-- FK action of a deleted user; DELETE only by a cascade; TRUNCATE never.
CREATE OR REPLACE FUNCTION public.service_qa_list_event_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  scrubbable constant text[] := ARRAY['actorUserId', 'requestDigest', 'digestKeyId'];
  h record;
  v record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF public.service_qa_in_erasure(TG_RELID)
       AND (to_jsonb(NEW) - scrubbable) = (to_jsonb(OLD) - scrubbable)
       AND NEW."actorUserId" IS NULL AND NEW."requestDigest" IS NULL AND NEW."digestKeyId" IS NULL THEN
      RETURN NEW;
    END IF;
    IF pg_trigger_depth() > 1 AND NEW."actorUserId" IS NULL
       AND (to_jsonb(NEW) - 'actorUserId') = (to_jsonb(OLD) - 'actorUserId') THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NEW."actorUserId" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'DZS09', MESSAGE = 'SERVICE_QA_LIST_EVENT_NEW: a list change is made by an owner user';
    END IF;
    SELECT "revision", "currentVersion", "archivedAt" INTO h FROM public."ServiceQaList"
     WHERE "businessId" = NEW."businessId" AND "id" = NEW."listId";
    SELECT "itemCount", "requiredCount" INTO v FROM public."ServiceQaListVersion"
     WHERE "businessId" = NEW."businessId" AND "listId" = NEW."listId" AND "version" = NEW."listVersion";
    IF h."revision" IS NULL OR h."revision" <> NEW."revision" OR h."currentVersion" <> NEW."listVersion"
       OR v."itemCount" IS NULL OR v."itemCount" <> NEW."itemCount" OR v."requiredCount" <> NEW."requiredCount"
       OR (NEW."action" = 'ARCHIVE') <> (h."archivedAt" IS NOT NULL) THEN
      RAISE EXCEPTION USING ERRCODE = 'DZS09',
        MESSAGE = 'SERVICE_QA_LIST_EVENT_MISMATCH: the event must name the revision, version and counts this transaction wrote';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'DZS09',
    MESSAGE = format('SERVICE_QA_LIST_EVENT_APPEND_ONLY: %s on %I is refused; the lists journal is append-only', TG_OP, TG_TABLE_NAME);
END
$fn$;
REVOKE ALL ON FUNCTION public.service_qa_list_event_guard() FROM PUBLIC;
CREATE TRIGGER "ServiceQaListEvent_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ServiceQaListEvent"
  FOR EACH ROW EXECUTE FUNCTION public.service_qa_list_event_guard();
CREATE TRIGGER "ServiceQaListEvent_no_truncate" BEFORE TRUNCATE ON "ServiceQaListEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION public.service_journal_truncate_guard();

-- 3.7 The case's choice. Born without one (the choice is a journaled command). It changes only: status-preserving, with
-- the version bumped, before QA is passed (never READY / WORK_DONE / DELIVERED / CLOSED / CANCELLED / ABANDONED), on a
-- case not erased; to the CURRENT version of an ACTIVE list of the business, or to none; and it resets the QA completion
-- (the new checklist has not been checked yet).
CREATE OR REPLACE FUNCTION public.service_case_qa_list_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  l record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."qaListId" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'DZS09', MESSAGE = 'SERVICE_CASE_QA_LIST_AT_OPENING: a case is opened without a QA list; the choice is its own journaled record';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."qaListId" IS NOT DISTINCT FROM OLD."qaListId" AND NEW."qaListVersion" IS NOT DISTINCT FROM OLD."qaListVersion" THEN
    RETURN NEW;
  END IF;
  IF OLD."status"::text IN ('READY', 'WORK_DONE', 'DELIVERED', 'CLOSED', 'CANCELLED', 'ABANDONED')
     OR NEW."status" <> OLD."status" OR OLD."erasedAt" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS09',
      MESSAGE = format('SERVICE_CASE_QA_LIST_FIXED: the case is %s; its QA list changes only before QA is passed, without a transition', OLD."status");
  END IF;
  IF NEW."version" <> OLD."version" + 1 OR NEW."qaCompletedAt" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS09', MESSAGE = 'SERVICE_CASE_QA_LIST_RECORD: a choice is one journaled version and resets the QA completion';
  END IF;
  IF NEW."qaListId" IS NOT NULL THEN
    SELECT "currentVersion", "archivedAt" INTO l FROM public."ServiceQaList"
     WHERE "businessId" = NEW."businessId" AND "id" = NEW."qaListId" FOR SHARE;
    IF NOT FOUND OR l."archivedAt" IS NOT NULL OR l."currentVersion" <> NEW."qaListVersion" THEN
      RAISE EXCEPTION USING ERRCODE = 'DZS09', MESSAGE = 'SERVICE_CASE_QA_LIST_NOT_CURRENT: a case takes the current version of an active list of its business';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_case_qa_list_guard() FROM PUBLIC;
CREATE TRIGGER "ServiceCase_qa_list_guard" BEFORE INSERT OR UPDATE OF "qaListId", "qaListVersion" ON "ServiceCase"
  FOR EACH ROW EXECUTE FUNCTION public.service_case_qa_list_guard();

-- 3.8 A choice is journaled: at COMMIT the case's version has a CHOOSE_QA_LIST event naming that list and version (or
-- none). Fails closed.
CREATE OR REPLACE FUNCTION public.service_case_qa_list_journaled()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF NEW."qaListId" IS NOT DISTINCT FROM OLD."qaListId" AND NEW."qaListVersion" IS NOT DISTINCT FROM OLD."qaListVersion" THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."ServiceCaseEvent" e
                  WHERE e."businessId" = NEW."businessId" AND e."caseId" = NEW."id" AND e."seq" = NEW."version"
                    AND e."action"::text = 'CHOOSE_QA_LIST'
                    AND (e."payload" ->> 'listId') IS NOT DISTINCT FROM NEW."qaListId"::text
                    AND (e."payload" ->> 'listVersion') IS NOT DISTINCT FROM NEW."qaListVersion"::text) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS09',
      MESSAGE = format('SERVICE_CASE_QA_LIST_NOT_JOURNALED: case %s changed its QA list without a qa.list_chosen event naming it at version %s', NEW."id", NEW."version");
  END IF;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_case_qa_list_journaled() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER "ServiceCase_qa_list_journaled" AFTER UPDATE OF "qaListId", "qaListVersion" ON "ServiceCase"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.service_case_qa_list_journaled();

-- 3.9 A case WITH a list counts as QA-complete only by its own checks: at COMMIT, while it is stamped complete, its latest
-- QA record is against the chosen version and complete. (A case without a list: today's rule, unchanged.) Reads the
-- case as it stands at COMMIT.
CREATE OR REPLACE FUNCTION public.service_case_qa_completion_matches()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  c record;
  r record;
BEGIN
  SELECT "qaListId", "qaListVersion", "qaCompletedAt" INTO c FROM public."ServiceCase" WHERE "businessId" = NEW."businessId" AND "id" = NEW."id";
  IF NOT FOUND OR c."qaListId" IS NULL OR c."qaCompletedAt" IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT "listId", "listVersion", "completed" INTO r FROM public."ServiceCaseQaRecord"
   WHERE "businessId" = NEW."businessId" AND "caseId" = NEW."id" ORDER BY "caseVersion" DESC LIMIT 1;
  IF NOT FOUND OR r."listId" IS DISTINCT FROM c."qaListId" OR r."listVersion" IS DISTINCT FROM c."qaListVersion" OR NOT r."completed" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS09',
      MESSAGE = format('SERVICE_CASE_QA_INCOMPLETE: case %s is stamped QA-complete without a complete record against its QA list', NEW."id");
  END IF;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_case_qa_completion_matches() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER "ServiceCase_qa_completion_matches" AFTER UPDATE OF "qaCompletedAt", "qaListId", "qaListVersion" ON "ServiceCase"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.service_case_qa_completion_matches();

-- 3.10 A QA record: written while the case is in QA, against the checklist the case names (its chosen list version, or —
-- without one — a built-in template), by a user, never born erased; then immutable — UPDATE only by the erasure (user to
-- NULL, erasedAt set) or the FK action of a deleted user; DELETE only by a cascade; TRUNCATE never.
CREATE OR REPLACE FUNCTION public.service_case_qa_record_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  erasable constant text[] := ARRAY['actorUserId', 'erasedAt'];
  c record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF public.service_qa_in_erasure(TG_RELID)
       AND (to_jsonb(NEW) - erasable) = (to_jsonb(OLD) - erasable)
       AND NEW."actorUserId" IS NULL AND NEW."erasedAt" IS NOT NULL THEN
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
      RAISE EXCEPTION USING ERRCODE = 'DZS09', MESSAGE = 'SERVICE_CASE_QA_RECORD_NEW: a QA record is made by a user and never born erased';
    END IF;
    SELECT "status"::text AS status, "qaListId", "qaListVersion" INTO c FROM public."ServiceCase"
     WHERE "businessId" = NEW."businessId" AND "id" = NEW."caseId";
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'DZS09', MESSAGE = 'SERVICE_CASE_QA_RECORD_CASE: no such case in this business';
    END IF;
    IF c.status <> 'QA' THEN
      RAISE EXCEPTION USING ERRCODE = 'DZS09', MESSAGE = format('SERVICE_CASE_QA_RECORD_NOT_IN_QA: the case is %s; QA results are recorded in QA', c.status);
    END IF;
    IF NEW."listId" IS DISTINCT FROM c."qaListId" OR NEW."listVersion" IS DISTINCT FROM c."qaListVersion" THEN
      RAISE EXCEPTION USING ERRCODE = 'DZS09', MESSAGE = 'SERVICE_CASE_QA_RECORD_CHECKLIST: a QA record is judged against the list version the case names (or, without one, a built-in template)';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'DZS09',
    MESSAGE = format('SERVICE_CASE_QA_RECORD_FIXED: %s on %I is refused; a QA record is permanent', TG_OP, TG_TABLE_NAME);
END
$fn$;
REVOKE ALL ON FUNCTION public.service_case_qa_record_guard() FROM PUBLIC;
CREATE TRIGGER "ServiceCaseQaRecord_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ServiceCaseQaRecord"
  FOR EACH ROW EXECUTE FUNCTION public.service_case_qa_record_guard();
CREATE TRIGGER "ServiceCaseQaRecord_no_truncate" BEFORE TRUNCATE ON "ServiceCaseQaRecord"
  FOR EACH STATEMENT EXECUTE FUNCTION public.service_journal_truncate_guard();

-- 3.11 At COMMIT a QA record is what its rows say: its event is a RECORD_QA by the same user at its seq; it holds exactly
-- its declared results; pass / fail / required-failed are the rows'; against a list version, the number of checks, the
-- REQUIRED checks without a result and therefore "completed" are the version's — never trusted from the writer.
CREATE OR REPLACE FUNCTION public.service_case_qa_record_matches()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  n integer; p integer; f integer; rf integer;
  v_items integer;
  v_missing integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."ServiceCaseEvent" e
                  WHERE e."businessId" = NEW."businessId" AND e."caseId" = NEW."caseId" AND e."seq" = NEW."caseVersion"
                    AND e."action"::text = 'RECORD_QA' AND e."actorUserId" IS NOT DISTINCT FROM NEW."actorUserId") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS09',
      MESSAGE = format('SERVICE_CASE_QA_RECORD_EVENT: QA record %s needs a RECORD_QA event by the same user at seq %s', NEW."id", NEW."caseVersion");
  END IF;
  SELECT count(*), count(*) FILTER (WHERE x."result" = 'PASS'), count(*) FILTER (WHERE x."result" = 'FAIL'),
         count(*) FILTER (WHERE x."result" = 'FAIL' AND x."required")
    INTO n, p, f, rf
    FROM public."ServiceCaseQaItemResult" x WHERE x."businessId" = NEW."businessId" AND x."recordId" = NEW."id";
  IF n <> NEW."resultCount" OR p <> NEW."passCount" OR f <> NEW."failCount" OR rf <> NEW."requiredFailed" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS09',
      MESSAGE = format('SERVICE_CASE_QA_RECORD_COUNTS: QA record %s declares %s results, holds %s (or its pass / fail counts differ)', NEW."id", NEW."resultCount", n);
  END IF;
  IF NEW."listId" IS NOT NULL THEN
    SELECT v."itemCount" INTO v_items FROM public."ServiceQaListVersion" v
     WHERE v."businessId" = NEW."businessId" AND v."listId" = NEW."listId" AND v."version" = NEW."listVersion";
    SELECT count(*) INTO v_missing FROM public."ServiceQaListItem" i
     WHERE i."businessId" = NEW."businessId" AND i."listId" = NEW."listId" AND i."listVersion" = NEW."listVersion" AND i."required"
       AND NOT EXISTS (SELECT 1 FROM public."ServiceCaseQaItemResult" x
                        WHERE x."businessId" = NEW."businessId" AND x."recordId" = NEW."id" AND x."itemKey" = i."itemKey");
    IF v_items IS DISTINCT FROM NEW."itemCount" OR v_missing <> NEW."requiredMissing" THEN
      RAISE EXCEPTION USING ERRCODE = 'DZS09',
        MESSAGE = format('SERVICE_CASE_QA_RECORD_VERSION: QA record %s must count the checks and the missing required checks of its list version', NEW."id");
    END IF;
  END IF;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_case_qa_record_matches() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER "ServiceCaseQaRecord_matches" AFTER INSERT ON "ServiceCaseQaRecord"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.service_case_qa_record_matches();

-- 3.12 A result: added only while its record is being written (the record not yet full), against the record's own
-- checklist, with the check's REQUIRED flag as it is in that version; then immutable — UPDATE only by the erasure (note
-- to NULL, erasedAt set); DELETE only by a cascade; TRUNCATE never.
CREATE OR REPLACE FUNCTION public.service_case_qa_result_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  erasable constant text[] := ARRAY['note', 'erasedAt'];
  r record;
  v_required boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF public.service_qa_in_erasure(TG_RELID)
       AND (to_jsonb(NEW) - erasable) = (to_jsonb(OLD) - erasable)
       AND NEW."note" IS NULL AND NEW."erasedAt" IS NOT NULL THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NEW."erasedAt" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'DZS09', MESSAGE = 'SERVICE_CASE_QA_RESULT_NEW: a result is never born erased';
    END IF;
    SELECT "listId", "listVersion", "resultCount" INTO r FROM public."ServiceCaseQaRecord"
     WHERE "businessId" = NEW."businessId" AND "id" = NEW."recordId";
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'DZS09', MESSAGE = 'SERVICE_CASE_QA_RESULT_RECORD: no such QA record in this business';
    END IF;
    IF NEW."listId" IS DISTINCT FROM r."listId" OR NEW."listVersion" IS DISTINCT FROM r."listVersion" THEN
      RAISE EXCEPTION USING ERRCODE = 'DZS09', MESSAGE = 'SERVICE_CASE_QA_RESULT_CHECKLIST: a result belongs to its record''s checklist';
    END IF;
    IF NEW."listId" IS NOT NULL THEN
      SELECT i."required" INTO v_required FROM public."ServiceQaListItem" i
       WHERE i."businessId" = NEW."businessId" AND i."listId" = NEW."listId" AND i."listVersion" = NEW."listVersion" AND i."itemKey" = NEW."itemKey";
      IF v_required IS DISTINCT FROM NEW."required" THEN
        RAISE EXCEPTION USING ERRCODE = 'DZS09', MESSAGE = 'SERVICE_CASE_QA_RESULT_REQUIRED: a result carries its check''s REQUIRED flag as it is in that version';
      END IF;
    END IF;
    IF (SELECT count(*) FROM public."ServiceCaseQaItemResult" x WHERE x."businessId" = NEW."businessId" AND x."recordId" = NEW."recordId") >= r."resultCount" THEN
      RAISE EXCEPTION USING ERRCODE = 'DZS09', MESSAGE = 'SERVICE_CASE_QA_RECORD_FIXED: the record holds all its results; a new check is a new record';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'DZS09',
    MESSAGE = format('SERVICE_CASE_QA_RESULT_FIXED: %s on %I is refused; a QA result is permanent', TG_OP, TG_TABLE_NAME);
END
$fn$;
REVOKE ALL ON FUNCTION public.service_case_qa_result_guard() FROM PUBLIC;
CREATE TRIGGER "ServiceCaseQaItemResult_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ServiceCaseQaItemResult"
  FOR EACH ROW EXECUTE FUNCTION public.service_case_qa_result_guard();
CREATE TRIGGER "ServiceCaseQaItemResult_no_truncate" BEFORE TRUNCATE ON "ServiceCaseQaItemResult"
  FOR EACH STATEMENT EXECUTE FUNCTION public.service_journal_truncate_guard();

-- ── 4. Erasure (account deletion) ───────────────────────────────────────────────────────────────────────────
-- CONTRACT: no arguments; the business is the tenant context. Refuses (DZS08, nothing changed) without a context or
-- when that business is not being deleted. Otherwise blanks IN PLACE, for that business only, every text and actor this
-- migration added:
--   ServiceQaListVersion     name, createdByUserId; erasedAt stamped
--   ServiceQaListItem        label; erasedAt stamped
--   ServiceQaListEvent       actorUserId, requestDigest, digestKeyId
--   ServiceCaseQaRecord      actorUserId; erasedAt stamped
--   ServiceCaseQaItemResult  note; erasedAt stamped
-- Kept: the structure (versions, item keys, REQUIRED flags, positions, results PASS / FAIL, counts, times, template ids —
-- code tokens, no personal data). Call it in the purge transaction with the other Service Desk erase functions
-- (order-independent). Re-run safe: returns the rows touched (0 the second time).
CREATE OR REPLACE FUNCTION public.service_qa_lists_erase_business()
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
    RAISE EXCEPTION USING ERRCODE = 'DZS08', MESSAGE = 'SERVICE_QA_ERASURE_NO_CONTEXT: no tenant context; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."Business" b WHERE b."id" = v_business
                   AND (b."deletionRequestedAt" IS NOT NULL OR b."deletedAt" IS NOT NULL)) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS08', MESSAGE = 'SERVICE_QA_ERASURE_NOT_DELETING: the business is not being deleted; nothing was changed';
  END IF;
  PERFORM set_config('dubiz.service_qa_erasure', 'on', true);

  UPDATE public."ServiceQaListVersion" SET "name" = NULL, "createdByUserId" = NULL, "erasedAt" = CURRENT_TIMESTAMP
   WHERE "businessId" = v_business AND "erasedAt" IS NULL;
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;
  UPDATE public."ServiceQaListItem" SET "label" = NULL, "erasedAt" = CURRENT_TIMESTAMP
   WHERE "businessId" = v_business AND "erasedAt" IS NULL;
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;
  UPDATE public."ServiceQaListEvent" SET "actorUserId" = NULL, "requestDigest" = NULL, "digestKeyId" = NULL
   WHERE "businessId" = v_business AND ("actorUserId" IS NOT NULL OR "requestDigest" IS NOT NULL OR "digestKeyId" IS NOT NULL);
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;
  UPDATE public."ServiceCaseQaRecord" SET "actorUserId" = NULL, "erasedAt" = CURRENT_TIMESTAMP
   WHERE "businessId" = v_business AND "erasedAt" IS NULL;
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;
  UPDATE public."ServiceCaseQaItemResult" SET "note" = NULL, "erasedAt" = CURRENT_TIMESTAMP
   WHERE "businessId" = v_business AND "erasedAt" IS NULL;
  GET DIAGNOSTICS v_k = ROW_COUNT; v_n := v_n + v_k;

  PERFORM set_config('dubiz.service_qa_erasure', 'off', true);
  RETURN v_n;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_qa_lists_erase_business() FROM PUBLIC;

-- ── 5. Row-level security — per operation; no DELETE policy; UPDATE where the runtime updates (the head) or the
--      owner-run erasure scrubs ─────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "ServiceQaList" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ServiceQaList" FORCE ROW LEVEL SECURITY;
CREATE POLICY service_qa_list_tenant_select ON "ServiceQaList" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_qa_list_tenant_insert ON "ServiceQaList" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_qa_list_tenant_update ON "ServiceQaList" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "ServiceQaListVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ServiceQaListVersion" FORCE ROW LEVEL SECURITY;
CREATE POLICY service_qa_list_version_tenant_select ON "ServiceQaListVersion" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_qa_list_version_tenant_insert ON "ServiceQaListVersion" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_qa_list_version_tenant_update ON "ServiceQaListVersion" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "ServiceQaListItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ServiceQaListItem" FORCE ROW LEVEL SECURITY;
CREATE POLICY service_qa_list_item_tenant_select ON "ServiceQaListItem" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_qa_list_item_tenant_insert ON "ServiceQaListItem" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_qa_list_item_tenant_update ON "ServiceQaListItem" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "ServiceQaListEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ServiceQaListEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY service_qa_list_event_tenant_select ON "ServiceQaListEvent" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_qa_list_event_tenant_insert ON "ServiceQaListEvent" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_qa_list_event_tenant_update ON "ServiceQaListEvent" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "ServiceCaseQaRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ServiceCaseQaRecord" FORCE ROW LEVEL SECURITY;
CREATE POLICY service_case_qa_record_tenant_select ON "ServiceCaseQaRecord" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_case_qa_record_tenant_insert ON "ServiceCaseQaRecord" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_case_qa_record_tenant_update ON "ServiceCaseQaRecord" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "ServiceCaseQaItemResult" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ServiceCaseQaItemResult" FORCE ROW LEVEL SECURITY;
CREATE POLICY service_case_qa_result_tenant_select ON "ServiceCaseQaItemResult" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_case_qa_result_tenant_insert ON "ServiceCaseQaItemResult" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_case_qa_result_tenant_update ON "ServiceCaseQaItemResult" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── 6. Privileges — named explicitly ────────────────────────────────────────────────────────────────────────
REVOKE ALL ON "ServiceQaList", "ServiceQaListVersion", "ServiceQaListItem", "ServiceQaListEvent", "ServiceCaseQaRecord", "ServiceCaseQaItemResult" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "ServiceQaList_id_seq", "ServiceQaListVersion_id_seq", "ServiceQaListItem_id_seq", "ServiceQaListEvent_id_seq",
  "ServiceCaseQaRecord_id_seq", "ServiceCaseQaItemResult_id_seq" FROM PUBLIC;
DO $do$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT c.oid::regclass::text AS rel, pg_get_userbyid(x.grantee) AS grantee, c.relkind
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
     WHERE c.relname IN ('ServiceQaList', 'ServiceQaListVersion', 'ServiceQaListItem', 'ServiceQaListEvent', 'ServiceCaseQaRecord', 'ServiceCaseQaItemResult',
                         'ServiceQaList_id_seq', 'ServiceQaListVersion_id_seq', 'ServiceQaListItem_id_seq', 'ServiceQaListEvent_id_seq',
                         'ServiceCaseQaRecord_id_seq', 'ServiceCaseQaItemResult_id_seq')
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
-- The head is updated (revision / version / archive); everything else is a permanent record: read and add, nothing
-- else. The existing ServiceCase grants cover its two new columns.
GRANT SELECT, INSERT, UPDATE ON "ServiceQaList" TO app_runtime;
GRANT SELECT, INSERT ON "ServiceQaListVersion", "ServiceQaListItem", "ServiceQaListEvent", "ServiceCaseQaRecord", "ServiceCaseQaItemResult" TO app_runtime;
GRANT USAGE, SELECT ON SEQUENCE "ServiceQaList_id_seq", "ServiceQaListVersion_id_seq", "ServiceQaListItem_id_seq", "ServiceQaListEvent_id_seq",
  "ServiceCaseQaRecord_id_seq", "ServiceCaseQaItemResult_id_seq" TO app_runtime;
GRANT EXECUTE ON FUNCTION public.service_qa_lists_erase_business() TO app_runtime;
-- invoker helper the guards call
GRANT EXECUTE ON FUNCTION public.service_qa_in_erasure(oid) TO app_runtime;
