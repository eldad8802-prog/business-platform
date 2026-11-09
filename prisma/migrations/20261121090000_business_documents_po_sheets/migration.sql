-- Business documents — the purchase-order sheet (owner-approved 2026-11-09): a SAVED COPY of the supplier order
-- document the send screen produces, with the number printed on it (the supplier order draft's id) and the external
-- number when there is one. "שמירת עותק" only: it records WHEN the copy was saved, never that it was sent.
--
-- Expand-only and additive to 20261114090000_business_documents_records:
--   1. two enum values: BusinessDocumentFilePurpose / BusinessDocumentOperation += PURCHASE_ORDER_SHEET;
--   2. the table PurchaseOrderSheet — append-only for the runtime, FORCE RLS by business, a COMMITTED stored file;
--      linked to SupplierPurchaseDraft by a guard (same business, number = '#' || draft id), with NO foreign key, so
--      nothing in the inventory tables changes (no constraint, no index, no behaviour);
--   3. business_documents_erase() redefined to erase these rows too (same contract, same name, same grants).
--   4. business_documents_file_guard() redefined so a saved copy's file counts as referenced, like a quote copy's or a
--      letter's: the runtime cannot move it COMMITTED → DELETING (same function, same grants; one condition added).
-- Touches no billing object, no inventory object, no other module's object.

-- ── 1. Enum values ───────────────────────────────────────────────────────────────────────────────────

ALTER TYPE "BusinessDocumentFilePurpose" ADD VALUE IF NOT EXISTS 'PURCHASE_ORDER_SHEET';
ALTER TYPE "BusinessDocumentOperation" ADD VALUE IF NOT EXISTS 'PURCHASE_ORDER_SHEET';

-- ── 2. The table ─────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE "PurchaseOrderSheet" (
  "id"                       SERIAL NOT NULL,
  "businessId"               INTEGER NOT NULL,
  "supplierPurchaseDraftId"  INTEGER NOT NULL,
  "fileId"                   INTEGER NOT NULL,
  "sha256"                   CHAR(64) NOT NULL,
  "contentHash"              CHAR(64) NOT NULL,
  -- What the saved document says, frozen at saving: later edits of the draft never change a saved copy.
  "displayedNumberSnapshot"  TEXT NOT NULL,
  "externalNumberSnapshot"   TEXT,
  "supplierNameSnapshot"     TEXT,
  "documentSnapshot"         JSONB NOT NULL,
  "locale"                   TEXT NOT NULL,
  "headerTitleSnapshot"      TEXT NOT NULL,
  "displayDateSnapshot"      TEXT NOT NULL,
  "createdByUserId"          INTEGER,
  "createdAt"                TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PurchaseOrderSheet_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PurchaseOrderSheet_sha256_hex" CHECK ("sha256" ~ '^[0-9a-f]{64}$' AND "contentHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "PurchaseOrderSheet_number_shape" CHECK ("displayedNumberSnapshot" ~ '^#[0-9]{1,12}$'),
  CONSTRAINT "PurchaseOrderSheet_locale" CHECK ("locale" IN ('he', 'en')),
  CONSTRAINT "PurchaseOrderSheet_snapshot_lengths"
    CHECK (("externalNumberSnapshot" IS NULL OR char_length("externalNumberSnapshot") BETWEEN 1 AND 200)
       AND ("supplierNameSnapshot" IS NULL OR char_length("supplierNameSnapshot") <= 300)
       AND char_length("headerTitleSnapshot") BETWEEN 1 AND 200
       AND char_length("displayDateSnapshot") BETWEEN 1 AND 40
       AND jsonb_typeof("documentSnapshot") = 'object')
);
CREATE UNIQUE INDEX "PurchaseOrderSheet_businessId_id_key" ON "PurchaseOrderSheet" ("businessId", "id");
CREATE UNIQUE INDEX "PurchaseOrderSheet_businessId_fileId_key" ON "PurchaseOrderSheet" ("businessId", "fileId");
CREATE INDEX "PurchaseOrderSheet_businessId_draft_createdAt_idx" ON "PurchaseOrderSheet" ("businessId", "supplierPurchaseDraftId", "createdAt");
ALTER TABLE "PurchaseOrderSheet" ADD CONSTRAINT "PurchaseOrderSheet_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrderSheet" ADD CONSTRAINT "PurchaseOrderSheet_file_fkey"
  FOREIGN KEY ("businessId", "fileId") REFERENCES "BusinessDocumentFile"("businessId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "PurchaseOrderSheet" ADD CONSTRAINT "PurchaseOrderSheet_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The draft link, enforced to the SAME business, read with the caller's own rights (RLS applies): a draft of another
-- business — or one that does not exist — is refused, and the number printed must be that draft's id. The stored
-- file must be a purchase-order-sheet file. No foreign key: the inventory tables stay exactly as they are.
CREATE OR REPLACE FUNCTION public.business_documents_po_sheet_link_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."SupplierPurchaseDraft" d
                  WHERE d."id" = NEW."supplierPurchaseDraftId" AND d."businessId" = NEW."businessId") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD04', MESSAGE = 'BUSINESS_DOCUMENTS_PO_DRAFT_NOT_FOUND: not a supplier order of this business';
  END IF;
  IF NEW."displayedNumberSnapshot" IS DISTINCT FROM ('#' || NEW."supplierPurchaseDraftId"::text) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD05', MESSAGE = 'BUSINESS_DOCUMENTS_PO_NUMBER_MISMATCH: the number printed must be the supplier order''s own number';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."BusinessDocumentFile" f
                  WHERE f."businessId" = NEW."businessId" AND f."id" = NEW."fileId" AND f."purpose"::text = 'PURCHASE_ORDER_SHEET') THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD06', MESSAGE = 'BUSINESS_DOCUMENTS_PO_FILE_PURPOSE: the stored file is not a purchase-order sheet';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.business_documents_po_sheet_link_guard() FROM PUBLIC;

CREATE TRIGGER "PurchaseOrderSheet_not_erasing" BEFORE INSERT ON "PurchaseOrderSheet"
  FOR EACH ROW EXECUTE FUNCTION public.business_documents_not_erasing();
CREATE TRIGGER "PurchaseOrderSheet_link" BEFORE INSERT ON "PurchaseOrderSheet"
  FOR EACH ROW EXECUTE FUNCTION public.business_documents_po_sheet_link_guard();
CREATE TRIGGER "PurchaseOrderSheet_file_ready" BEFORE INSERT ON "PurchaseOrderSheet"
  FOR EACH ROW EXECUTE FUNCTION public.business_documents_file_ready_guard();
CREATE TRIGGER "PurchaseOrderSheet_append_only" BEFORE UPDATE OR DELETE ON "PurchaseOrderSheet"
  FOR EACH ROW EXECUTE FUNCTION public.business_documents_append_only_guard('createdByUserId');
CREATE TRIGGER "PurchaseOrderSheet_no_truncate" BEFORE TRUNCATE ON "PurchaseOrderSheet"
  FOR EACH STATEMENT EXECUTE FUNCTION public.business_documents_truncate_guard();

-- ── 2b. The file state machine — a saved copy's file is referenced too ────────────────────────────────
-- Identical to 20261114090000 except the PurchaseOrderSheet condition: only the owner (the erasure function) may move
-- a file a saved copy points at to DELETING; the append-only sheet can never be left pointing at a fenced file.

CREATE OR REPLACE FUNCTION public.business_documents_file_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  is_owner boolean := current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID);
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF (is_owner AND OLD."state" = 'FENCED') OR pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'DZD21', MESSAGE = 'BUSINESS_DOCUMENTS_FILE_DELETE_REFUSED';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'PENDING' THEN
      RAISE EXCEPTION USING ERRCODE = 'DZD21', MESSAGE = 'BUSINESS_DOCUMENTS_FILE_MUST_START_PENDING';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR (NEW."state" = 'COMMITTED' AND OLD."state" <> 'COMMITTED') THEN
    PERFORM pg_advisory_xact_lock_shared(hashtext('business_documents_erasure'), NEW."businessId");
    IF EXISTS (SELECT 1 FROM public."BusinessDocumentErasure" e WHERE e."businessId" = NEW."businessId")
       OR EXISTS (SELECT 1 FROM public."Business" b WHERE b."id" = NEW."businessId"
                    AND (b."deletionRequestedAt" IS NOT NULL OR b."deletedAt" IS NOT NULL)) THEN
      RAISE EXCEPTION USING ERRCODE = 'DZD20', MESSAGE = 'BUSINESS_DOCUMENTS_BUSINESS_BEING_ERASED';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  IF NEW."objectKey" IS DISTINCT FROM OLD."objectKey" OR NEW."businessId" IS DISTINCT FROM OLD."businessId"
     OR NEW."purpose" IS DISTINCT FROM OLD."purpose" OR NEW."id" IS DISTINCT FROM OLD."id" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD22', MESSAGE = 'BUSINESS_DOCUMENTS_FILE_IDENTITY_IMMUTABLE';
  END IF;
  IF NEW."state" = OLD."state" THEN
    IF OLD."state" IN ('PENDING') THEN
      RETURN NEW;  -- lease refresh
    END IF;
    IF (to_jsonb(NEW) - 'leaseOwner' - 'leaseUntil') = (to_jsonb(OLD) - 'leaseOwner' - 'leaseUntil') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'DZD24', MESSAGE = format('BUSINESS_DOCUMENTS_FILE_FROZEN in state %s', OLD."state");
  END IF;
  IF (OLD."state", NEW."state") IN (('PENDING', 'COMMITTED'), ('PENDING', 'DELETING'), ('DELETING', 'FENCED')) THEN
    RETURN NEW;
  END IF;
  IF (OLD."state", NEW."state") = ('COMMITTED', 'DELETING') THEN
    -- READ COMMITTED: this statement sees every reference committed while the UPDATE waited for the row lock.
    -- The erasure / purge functions (the owner) mark referenced files too; nothing else may.
    IF NOT is_owner AND (
         EXISTS (SELECT 1 FROM public."QuoteShareCopy" c WHERE c."businessId" = NEW."businessId" AND c."fileId" = NEW."id")
      OR EXISTS (SELECT 1 FROM public."BusinessLetter" l WHERE l."businessId" = NEW."businessId" AND l."fileId" = NEW."id")
      OR EXISTS (SELECT 1 FROM public."PurchaseOrderSheet" s WHERE s."businessId" = NEW."businessId" AND s."fileId" = NEW."id")) THEN
      RAISE EXCEPTION USING ERRCODE = 'DZD23', MESSAGE = 'BUSINESS_DOCUMENTS_FILE_STILL_REFERENCED';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'DZD24', MESSAGE = format('BUSINESS_DOCUMENTS_FILE_TRANSITION_REFUSED %s -> %s', OLD."state", NEW."state");
END
$fn$;
REVOKE ALL ON FUNCTION public.business_documents_file_guard() FROM PUBLIC;

-- ── 3. Account erasure — the same function, now covering the sheets ──────────────────────────────────

CREATE OR REPLACE FUNCTION public.business_documents_erase()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_business integer := NULLIF(current_setting('app.current_business_id', true), '')::integer;
  v_files integer;
BEGIN
  IF v_business IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD50', MESSAGE = 'BUSINESS_DOCUMENTS_ERASURE_NO_CONTEXT: no tenant context; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."Business" b WHERE b."id" = v_business
                   AND (b."deletionRequestedAt" IS NOT NULL OR b."deletedAt" IS NOT NULL)) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD51', MESSAGE = 'BUSINESS_DOCUMENTS_ERASURE_NOT_DELETING: the business is not being deleted; nothing was changed';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('business_documents_erasure'), v_business);
  INSERT INTO public."BusinessDocumentErasure" ("businessId", "state") VALUES (v_business, 'PURGING_OBJECTS')
    ON CONFLICT ("businessId") DO NOTHING;
  UPDATE public."BusinessDocumentFile" SET "state" = 'DELETING', "leaseOwner" = NULL, "leaseUntil" = NULL
   WHERE "businessId" = v_business AND "state" IN ('PENDING', 'COMMITTED');
  GET DIAGNOSTICS v_files = ROW_COUNT;
  DELETE FROM public."QuoteShareEvent" WHERE "businessId" = v_business AND "correctsEventId" IS NOT NULL;
  DELETE FROM public."QuoteShareEvent" WHERE "businessId" = v_business;
  DELETE FROM public."QuoteShareCopy" WHERE "businessId" = v_business;
  DELETE FROM public."BusinessLetter" WHERE "businessId" = v_business;
  DELETE FROM public."PurchaseOrderSheet" WHERE "businessId" = v_business;
  DELETE FROM public."BusinessDocumentRequest" WHERE "businessId" = v_business;
  -- Silent-zero proof: a role without the privilege to see the rows would have deleted nothing and said so quietly.
  IF EXISTS (SELECT 1 FROM public."QuoteShareEvent" WHERE "businessId" = v_business)
     OR EXISTS (SELECT 1 FROM public."QuoteShareCopy" WHERE "businessId" = v_business)
     OR EXISTS (SELECT 1 FROM public."BusinessLetter" WHERE "businessId" = v_business)
     OR EXISTS (SELECT 1 FROM public."PurchaseOrderSheet" WHERE "businessId" = v_business)
     OR EXISTS (SELECT 1 FROM public."BusinessDocumentRequest" WHERE "businessId" = v_business)
     OR EXISTS (SELECT 1 FROM public."BusinessDocumentFile" WHERE "businessId" = v_business AND "state" IN ('PENDING', 'COMMITTED')) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD52', MESSAGE = 'BUSINESS_DOCUMENTS_ERASURE_INCOMPLETE: rows remain; rolled back';
  END IF;
  RETURN v_files;
END
$fn$;
REVOKE ALL ON FUNCTION public.business_documents_erase() FROM PUBLIC;

-- ── 4. Row-level security ────────────────────────────────────────────────────────────────────────────

ALTER TABLE "PurchaseOrderSheet" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PurchaseOrderSheet" FORCE ROW LEVEL SECURITY;
CREATE POLICY purchase_order_sheet_tenant_select ON "PurchaseOrderSheet" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY purchase_order_sheet_tenant_insert ON "PurchaseOrderSheet" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── 5. Privileges — named explicitly ─────────────────────────────────────────────────────────────────

REVOKE ALL ON "PurchaseOrderSheet" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "PurchaseOrderSheet_id_seq" FROM PUBLIC;

-- Whatever the migration role's DEFAULT PRIVILEGES handed out on the NEW objects goes first.
DO $do$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT c.oid::regclass::text AS rel, pg_get_userbyid(x.grantee) AS grantee, c.relkind
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
     WHERE c.relname IN ('PurchaseOrderSheet', 'PurchaseOrderSheet_id_seq')
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

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    -- Append-only for the runtime: read and add.
    GRANT SELECT, INSERT ON "PurchaseOrderSheet" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "PurchaseOrderSheet_id_seq" TO app_runtime;
    -- The redefined erase function keeps its grant (CREATE OR REPLACE preserves it); stated again explicitly.
    GRANT EXECUTE ON FUNCTION public.business_documents_erase() TO app_runtime;
  END IF;
END
$do$;
