-- ============================================================================================================
-- 20261214090000_service_desk_case_fields — DRAFT (A7). NOT APPLIED anywhere. Owner approval required to apply.
--
-- Owner decisions 2026-11-19 (repairs vs service spec), the light fields the spec asked for — nothing heavier:
--   * estimated completion date: optional DATE on the case, no alerts, no SLA (spec: "סיום משוער: תאריך אופציונלי");
--   * item location: optional free text on the case (spec: "מיקום פריט: טקסט חופשי ואופציונלי"), no shelves / barcodes;
--   * loaner equipment (decision 5): one simple row per loan — what, when lent, when returned, a note. A reminder at
--     handover only; NOTHING here blocks a handover (no trigger on ServiceHandover / ServiceCase status);
--   * task link (decision 7): one nullable column on the existing Task, pointing at a case of the SAME business.
-- The site address already exists (M1: ServiceCase."siteAddress"), so it is not added again.
--
-- Unchanged: every existing row, constraint, policy, grant and function; billing is not read or written.
-- ============================================================================================================

DO $do$
BEGIN
  IF to_regclass('public."ServiceCase"') IS NULL OR to_regclass('public."Task"') IS NULL THEN
    RAISE EXCEPTION 'SERVICE_CASE_FIELDS: ServiceCase or Task is missing; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ServiceCase_businessId_id_key') THEN
    RAISE EXCEPTION 'SERVICE_CASE_FIELDS: ServiceCase (businessId, id) unique key is missing; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    RAISE EXCEPTION 'SERVICE_CASE_FIELDS: role app_runtime is missing; nothing was changed';
  END IF;
END
$do$;

-- 1. Light case fields (both optional).
ALTER TABLE "ServiceCase"
  ADD COLUMN "estimatedReadyOn" DATE,
  ADD COLUMN "itemLocationNote" TEXT;
-- (The case keeps its rows on erasure; "itemLocationNote" joins the case texts the M1 tracks erasure blanks when the
-- code that writes it lands — until then nothing writes it.)
ALTER TABLE "ServiceCase" ADD CONSTRAINT "ServiceCase_item_location_note" CHECK (
  "itemLocationNote" IS NULL OR (btrim("itemLocationNote") <> '' AND char_length("itemLocationNote") <= 120)
);

-- 2. Loaner equipment (decision 5): a reminder only, never a block.
CREATE TABLE "ServiceCaseLoaner" (
  "id"         SERIAL       NOT NULL,
  "businessId" INTEGER      NOT NULL,
  "caseId"     INTEGER      NOT NULL,
  "itemName"   TEXT         NOT NULL,
  "lentAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "returnedAt" TIMESTAMP(3),
  "note"       TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "erasedAt"   TIMESTAMP(3),
  CONSTRAINT "ServiceCaseLoaner_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ServiceCaseLoaner_item_name" CHECK (btrim("itemName") <> '' AND char_length("itemName") <= 120),
  CONSTRAINT "ServiceCaseLoaner_note" CHECK ("note" IS NULL OR char_length("note") <= 500),
  CONSTRAINT "ServiceCaseLoaner_returned_after_lent" CHECK ("returnedAt" IS NULL OR "returnedAt" >= "lentAt")
);
CREATE INDEX "ServiceCaseLoaner_case_idx" ON "ServiceCaseLoaner"("businessId", "caseId");
ALTER TABLE "ServiceCaseLoaner" ADD CONSTRAINT "ServiceCaseLoaner_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceCaseLoaner" ADD CONSTRAINT "ServiceCaseLoaner_case_fkey"
  FOREIGN KEY ("businessId", "caseId") REFERENCES "ServiceCase"("businessId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "ServiceCaseLoaner" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ServiceCaseLoaner" FORCE ROW LEVEL SECURITY;
CREATE POLICY service_case_loaner_tenant_select ON "ServiceCaseLoaner" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_case_loaner_tenant_insert ON "ServiceCaseLoaner" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY service_case_loaner_tenant_update ON "ServiceCaseLoaner" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
GRANT SELECT, INSERT, UPDATE ON "ServiceCaseLoaner" TO app_runtime;
GRANT USAGE, SELECT ON SEQUENCE "ServiceCaseLoaner_id_seq" TO app_runtime;

-- Guard: no write for a business being deleted (the Service Desk rule); a loan is never deleted by the application,
-- only returned; an erased row stays erased. The erasure itself passes under its own marker, as the table owner.
CREATE OR REPLACE FUNCTION public.service_case_loaner_in_erasure(p_relid oid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT current_setting('dubiz.service_loaner_erasure', true) = 'on'
     AND current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = p_relid)
$fn$;
REVOKE ALL ON FUNCTION public.service_case_loaner_in_erasure(oid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.service_case_loaner_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF; -- the case / business cascade
    RAISE EXCEPTION USING ERRCODE = 'DZU12', MESSAGE = 'SERVICE_LOANER_KEPT: a loan is never deleted; it is returned';
  END IF;
  IF TG_OP = 'UPDATE' AND public.service_case_loaner_in_erasure(TG_RELID) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."erasedAt" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU12', MESSAGE = 'SERVICE_LOANER_ERASED: an erased loan is not changed';
  END IF;
  IF NEW."erasedAt" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU12', MESSAGE = 'SERVICE_LOANER_ERASED_ON_WRITE: only the erasure marks a loan erased';
  END IF;
  IF NOT public.service_ui_business_writable(NEW."businessId") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU02', MESSAGE = 'SERVICE_UI_BUSINESS_DELETING: the business is being deleted; nothing was written';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."businessId" <> OLD."businessId" OR NEW."caseId" <> OLD."caseId" OR NEW."lentAt" <> OLD."lentAt") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU12', MESSAGE = 'SERVICE_LOANER_FIXED: the case and the lend time of a loan do not change';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_case_loaner_guard() FROM PUBLIC;
CREATE TRIGGER "ServiceCaseLoaner_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ServiceCaseLoaner"
  FOR EACH ROW EXECUTE FUNCTION public.service_case_loaner_guard();

-- Erasure (account deletion): the loan's free texts are blanked; the dates stay (the same shape as the charge erasure).
-- Called by the purge once the code wiring lands with the screens that write loans.
CREATE OR REPLACE FUNCTION public.service_case_loaner_erase_business()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_business integer := NULLIF(current_setting('app.current_business_id', true), '')::integer;
  v_n integer := 0;
BEGIN
  IF v_business IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU11', MESSAGE = 'SERVICE_LOANER_ERASURE_NO_CONTEXT: no tenant context; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."Business" b WHERE b."id" = v_business
                   AND (b."deletionRequestedAt" IS NOT NULL OR b."deletedAt" IS NOT NULL)) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZU11', MESSAGE = 'SERVICE_LOANER_ERASURE_NOT_DELETING: only a business being deleted is erased; nothing was changed';
  END IF;
  PERFORM set_config('dubiz.service_loaner_erasure', 'on', true);
  UPDATE public."ServiceCaseLoaner" SET "itemName" = 'נמחק', "note" = NULL, "erasedAt" = CURRENT_TIMESTAMP
   WHERE "businessId" = v_business AND "erasedAt" IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('dubiz.service_loaner_erasure', 'off', true);
  RETURN v_n;
END
$fn$;
REVOKE ALL ON FUNCTION public.service_case_loaner_erase_business() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.service_case_loaner_erase_business() TO app_runtime;

-- 3. Task → case link (decision 7): same business enforced by the composite key. If a case row is ever removed (the
-- business purge), only the link is cleared — the task and its business stay (PG ≥ 15: SET NULL of one column).
ALTER TABLE "Task" ADD COLUMN "serviceCaseId" INTEGER;
ALTER TABLE "Task" ADD CONSTRAINT "Task_service_case_fkey"
  FOREIGN KEY ("businessId", "serviceCaseId") REFERENCES "ServiceCase"("businessId", "id") ON DELETE SET NULL ("serviceCaseId") ON UPDATE NO ACTION;
CREATE INDEX "Task_service_case_idx" ON "Task"("businessId", "serviceCaseId") WHERE "serviceCaseId" IS NOT NULL;
