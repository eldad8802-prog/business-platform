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

-- 3. Task → case link (decision 7): same business enforced by the composite key; the case cannot be deleted while a
-- task points at it (cases are kept, never deleted, outside the business erasure, which removes the tasks first).
ALTER TABLE "Task" ADD COLUMN "serviceCaseId" INTEGER;
ALTER TABLE "Task" ADD CONSTRAINT "Task_service_case_fkey"
  FOREIGN KEY ("businessId", "serviceCaseId") REFERENCES "ServiceCase"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
CREATE INDEX "Task_service_case_idx" ON "Task"("businessId", "serviceCaseId") WHERE "serviceCaseId" IS NOT NULL;
