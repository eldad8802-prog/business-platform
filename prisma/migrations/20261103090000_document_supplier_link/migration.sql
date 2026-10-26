-- Document ↔ supplier link — data foundation (owner decisions 2026-10-26, supplier-linking milestone 1)
--
-- WHY
--   An expense document carries its supplier only as free text (ExtractedData / FinancialRecord "vendorName"); no
--   document ever reaches a supplier file. The reading of a document also drops the supplier's tax id it found, and
--   nothing stops the business ITSELF from being read as the supplier (audit 2026-10-26: a synthetic invoice with the
--   business's own block printed first was read as "supplier = the business", confidence 0.9, no review flag).
--
-- WHAT THIS ADDS (nothing existing is changed or dropped)
--   "ExtractedData", five nullable / defaulted columns — what the READING found about the document's issuer,
--   kept apart from any decision:
--     "issuerTaxId"          the issuer's tax id as read, digits only (5–9), NULL when none was found;
--     "issuerTaxIdSource"    where it was read: VENDOR_LINE (beside the chosen issuer name), HEADER (the
--                            document's top block), ONLY_ON_DOCUMENT (the single non-own id on the page);
--     "issuerTaxIdValid"     its Israeli check digit holds (NULL exactly when there is no id);
--     "issuerCheck"          the reading's verdict on the issuer: OK | NO_TAX_ID | TAX_ID_INVALID |
--                            CONFLICTING_TAX_IDS | OWN_BUSINESS_ONLY; NULL = read before this foundation;
--     "ownBusinessExcluded"  the business's own name or tax id appeared and was kept OUT of the issuer.
--   "DocumentSupplierLink"       the owner's DECISION: at most one row per document (current state). ACTIVE names a
--                                supplier; REMOVED keeps the row (no DELETE anywhere) with no supplier. "version" is
--                                the optimistic-concurrency counter every change must name.
--   "DocumentSupplierLinkEvent"  the append-only trail of every decision: LINKED, RELINKED, UNLINKED and
--                                SUGGESTION_DISMISSED (a suggested supplier the owner said is NOT this document's —
--                                never suggested again for it). Ids, closed tokens and times only: NO free text.
--
-- ISOLATION
--   Both tables: ENABLE + FORCE RLS, per-command policies on app.current_business_id, privileges named explicitly.
--   The runtime may never DELETE either table, and may never UPDATE the trail.
--   Cross-tenant references are refused by the DATABASE, not only by the application: composite (businessId, …)
--   foreign keys to "Document"(businessId, id) and "Supplier"(businessId, id) — a link can only name a document and
--   a supplier of its own business — and a trigger for the user columns. A supplier that a link or the trail names
--   cannot be removed (NO ACTION); a removed document takes its link and trail with it (CASCADE).
--
-- FUNCTIONS (owned by the migration role, EXECUTE revoked from PUBLIC)
--   document_supplier_link_user_same_business()  trigger function (not callable directly).
--   document_supplier_link_event_guard()          trigger function: the trail refuses every UPDATE (owner included)
--                                                 except erasure nulling the acting user.
--   document_supplier_link_erase_business()       SECURITY DEFINER, search_path pinned, EXECUTE for app_runtime:
--     account erasure — nulls the acting users of both tables for the business in the tenant context, and refuses
--     unless that business is being deleted (the same contract as appointment_erase_business()).
--
-- FLAG — OFF
--   document_supplier_linking: definition + policy rows, defaultEnabled false, globalEnabled false. The application
--   PR gates the supplier picker, the suggestions and the supplier file's documents section on it.
--
-- RELEASE ORDER
--   Sorts after 20261102090000_oauth_identity_link, the last migration applied in Production, so it is the next
--   (and only) pending migration in name order — release-migrate applies an approved prefix only.
--
-- Additive. Rollback: .dsl/rollback.sql (owner-run; refuses while any link, event or issuer reading exists).

-- ── 1. ExtractedData — what the reading found about the issuer ──────────────────────────────────

ALTER TABLE "ExtractedData"
  ADD COLUMN "issuerTaxId" TEXT,
  ADD COLUMN "issuerTaxIdSource" TEXT,
  ADD COLUMN "issuerTaxIdValid" BOOLEAN,
  ADD COLUMN "issuerCheck" TEXT,
  ADD COLUMN "ownBusinessExcluded" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "ExtractedData" ADD CONSTRAINT "ExtractedData_issuerTaxId_shape"
  CHECK ("issuerTaxId" IS NULL OR "issuerTaxId" ~ '^[0-9]{5,9}$');
ALTER TABLE "ExtractedData" ADD CONSTRAINT "ExtractedData_issuerTaxIdSource"
  CHECK ("issuerTaxIdSource" IS NULL OR "issuerTaxIdSource" IN ('VENDOR_LINE', 'HEADER', 'ONLY_ON_DOCUMENT'));
ALTER TABLE "ExtractedData" ADD CONSTRAINT "ExtractedData_issuerTaxId_together"
  CHECK (("issuerTaxId" IS NULL) = ("issuerTaxIdSource" IS NULL)
     AND ("issuerTaxId" IS NULL) = ("issuerTaxIdValid" IS NULL));
ALTER TABLE "ExtractedData" ADD CONSTRAINT "ExtractedData_issuerCheck"
  CHECK ("issuerCheck" IS NULL OR "issuerCheck" IN ('OK', 'NO_TAX_ID', 'TAX_ID_INVALID', 'CONFLICTING_TAX_IDS', 'OWN_BUSINESS_ONLY'));
-- OK always carries a valid id, TAX_ID_INVALID an invalid one; NO_TAX_ID and OWN_BUSINESS_ONLY never carry one.
ALTER TABLE "ExtractedData" ADD CONSTRAINT "ExtractedData_issuerCheck_shape"
  CHECK (("issuerCheck" IS DISTINCT FROM 'OK' OR ("issuerTaxId" IS NOT NULL AND "issuerTaxIdValid" IS TRUE))
     AND ("issuerCheck" IS DISTINCT FROM 'TAX_ID_INVALID' OR ("issuerTaxId" IS NOT NULL AND "issuerTaxIdValid" IS FALSE))
     AND ("issuerCheck" IS NULL OR "issuerCheck" NOT IN ('NO_TAX_ID', 'OWN_BUSINESS_ONLY') OR "issuerTaxId" IS NULL));

-- ── 2. DocumentSupplierLink — the owner's decision (one row per document) ───────────────────────

CREATE TABLE "DocumentSupplierLink" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "documentId" INTEGER NOT NULL,
    "supplierId" INTEGER,
    "status" TEXT NOT NULL,
    "method" TEXT,
    "suggestionReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "linkedByUserId" INTEGER,
    "linkedAt" TIMESTAMP(3),
    "removedByUserId" INTEGER,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentSupplierLink_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DocumentSupplierLink_status" CHECK ("status" IN ('ACTIVE', 'REMOVED')),
    CONSTRAINT "DocumentSupplierLink_method" CHECK ("method" IS NULL OR "method" IN ('MANUAL_PICK', 'SUGGESTION_ACCEPTED')),
    CONSTRAINT "DocumentSupplierLink_reason" CHECK ("suggestionReason" IS NULL
      OR ("suggestionReason" IN ('TAX_ID', 'NAME') AND "method" = 'SUGGESTION_ACCEPTED')),
    -- ACTIVE names a supplier, how and when it was chosen; REMOVED names none and says when.
    CONSTRAINT "DocumentSupplierLink_shape" CHECK (
         ("status" = 'ACTIVE' AND "supplierId" IS NOT NULL AND "method" IS NOT NULL AND "linkedAt" IS NOT NULL
            AND "removedAt" IS NULL AND "removedByUserId" IS NULL)
      OR ("status" = 'REMOVED' AND "supplierId" IS NULL AND "method" IS NULL AND "suggestionReason" IS NULL
            AND "removedAt" IS NOT NULL)),
    CONSTRAINT "DocumentSupplierLink_version" CHECK ("version" >= 1)
);

CREATE UNIQUE INDEX "DocumentSupplierLink_businessId_documentId_key" ON "DocumentSupplierLink"("businessId", "documentId");
CREATE UNIQUE INDEX "DocumentSupplierLink_businessId_id_key" ON "DocumentSupplierLink"("businessId", "id");
CREATE INDEX "DocumentSupplierLink_businessId_supplierId_status_idx" ON "DocumentSupplierLink"("businessId", "supplierId", "status");

ALTER TABLE "DocumentSupplierLink" ADD CONSTRAINT "DocumentSupplierLink_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentSupplierLink" ADD CONSTRAINT "DocumentSupplierLink_document_fkey"
  FOREIGN KEY ("businessId", "documentId") REFERENCES "Document"("businessId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentSupplierLink" ADD CONSTRAINT "DocumentSupplierLink_supplier_fkey"
  FOREIGN KEY ("businessId", "supplierId") REFERENCES "Supplier"("businessId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "DocumentSupplierLink" ADD CONSTRAINT "DocumentSupplierLink_linkedByUserId_fkey"
  FOREIGN KEY ("linkedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DocumentSupplierLink" ADD CONSTRAINT "DocumentSupplierLink_removedByUserId_fkey"
  FOREIGN KEY ("removedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 3. DocumentSupplierLinkEvent — the append-only trail ────────────────────────────────────────

CREATE TABLE "DocumentSupplierLinkEvent" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "documentId" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "supplierId" INTEGER,
    "previousSupplierId" INTEGER,
    "method" TEXT,
    "suggestionReason" TEXT,
    "actorUserId" INTEGER,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentSupplierLinkEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DocumentSupplierLinkEvent_action" CHECK ("action" IN ('LINKED', 'RELINKED', 'UNLINKED', 'SUGGESTION_DISMISSED')),
    CONSTRAINT "DocumentSupplierLinkEvent_method" CHECK ("method" IS NULL OR "method" IN ('MANUAL_PICK', 'SUGGESTION_ACCEPTED')),
    CONSTRAINT "DocumentSupplierLinkEvent_reason" CHECK ("suggestionReason" IS NULL
      OR ("suggestionReason" IN ('TAX_ID', 'NAME') AND "method" = 'SUGGESTION_ACCEPTED')),
    -- Each action names exactly the suppliers it is about.
    CONSTRAINT "DocumentSupplierLinkEvent_shape" CHECK (
         ("action" = 'LINKED' AND "supplierId" IS NOT NULL AND "previousSupplierId" IS NULL AND "method" IS NOT NULL)
      OR ("action" = 'RELINKED' AND "supplierId" IS NOT NULL AND "previousSupplierId" IS NOT NULL
            AND "supplierId" <> "previousSupplierId" AND "method" IS NOT NULL)
      OR ("action" = 'UNLINKED' AND "supplierId" IS NULL AND "previousSupplierId" IS NOT NULL AND "method" IS NULL)
      OR ("action" = 'SUGGESTION_DISMISSED' AND "supplierId" IS NOT NULL AND "previousSupplierId" IS NULL
            AND "method" IS NULL AND "suggestionReason" IS NULL)),
    -- A client-generated token so a repeated request is recognised; never text.
    CONSTRAINT "DocumentSupplierLinkEvent_idempotencyKey" CHECK ("idempotencyKey" IS NULL OR "idempotencyKey" ~ '^[A-Za-z0-9_-]{8,64}$')
);

CREATE UNIQUE INDEX "DocumentSupplierLinkEvent_businessId_idempotencyKey_key"
  ON "DocumentSupplierLinkEvent"("businessId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;
CREATE INDEX "DocumentSupplierLinkEvent_businessId_documentId_createdAt_idx"
  ON "DocumentSupplierLinkEvent"("businessId", "documentId", "createdAt");
CREATE INDEX "DocumentSupplierLinkEvent_businessId_supplierId_idx"
  ON "DocumentSupplierLinkEvent"("businessId", "supplierId");

ALTER TABLE "DocumentSupplierLinkEvent" ADD CONSTRAINT "DocumentSupplierLinkEvent_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentSupplierLinkEvent" ADD CONSTRAINT "DocumentSupplierLinkEvent_document_fkey"
  FOREIGN KEY ("businessId", "documentId") REFERENCES "Document"("businessId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentSupplierLinkEvent" ADD CONSTRAINT "DocumentSupplierLinkEvent_supplier_fkey"
  FOREIGN KEY ("businessId", "supplierId") REFERENCES "Supplier"("businessId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "DocumentSupplierLinkEvent" ADD CONSTRAINT "DocumentSupplierLinkEvent_previousSupplier_fkey"
  FOREIGN KEY ("businessId", "previousSupplierId") REFERENCES "Supplier"("businessId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "DocumentSupplierLinkEvent" ADD CONSTRAINT "DocumentSupplierLinkEvent_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 4. User references stay inside the business ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.document_supplier_link_user_same_business()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  col text;
  uid integer;
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    uid := (to_jsonb(NEW) ->> col)::integer;
    IF uid IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "User" u WHERE u."id" = uid AND u."businessId" = NEW."businessId"
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'DZS01',
        MESSAGE = format('DOCUMENT_SUPPLIER_LINK_USER_OTHER_BUSINESS: %I.%I must name a user of the same business', TG_TABLE_NAME, col);
    END IF;
  END LOOP;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.document_supplier_link_user_same_business() FROM PUBLIC;

CREATE TRIGGER "DocumentSupplierLink_user_same_business"
  BEFORE INSERT OR UPDATE OF "businessId", "linkedByUserId", "removedByUserId" ON "DocumentSupplierLink"
  FOR EACH ROW EXECUTE FUNCTION public.document_supplier_link_user_same_business('linkedByUserId', 'removedByUserId');
CREATE TRIGGER "DocumentSupplierLinkEvent_user_same_business"
  BEFORE INSERT ON "DocumentSupplierLinkEvent"
  FOR EACH ROW EXECUTE FUNCTION public.document_supplier_link_user_same_business('actorUserId');

-- The trail is append-only for EVERY role, the owner included: the one change ever allowed is account erasure
-- nulling the acting user. Removal is not guarded here — a removed document or business must still take its trail
-- with it (the foreign keys' CASCADE); the runtime holds no DELETE privilege on it at all.
CREATE OR REPLACE FUNCTION public.document_supplier_link_event_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF (to_jsonb(NEW) - 'actorUserId') IS DISTINCT FROM (to_jsonb(OLD) - 'actorUserId')
     OR (NEW."actorUserId" IS NOT NULL AND NEW."actorUserId" IS DISTINCT FROM OLD."actorUserId") THEN
    RAISE EXCEPTION USING
      ERRCODE = 'DZS03',
      MESSAGE = 'DOCUMENT_SUPPLIER_LINK_EVENT_APPEND_ONLY: the trail cannot be changed (only erasure may null the acting user)';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.document_supplier_link_event_guard() FROM PUBLIC;

CREATE TRIGGER "DocumentSupplierLinkEvent_append_only"
  BEFORE UPDATE ON "DocumentSupplierLinkEvent"
  FOR EACH ROW EXECUTE FUNCTION public.document_supplier_link_event_guard();

-- ── 5. Account erasure — the acting users go with the account ───────────────────────────────────

CREATE OR REPLACE FUNCTION public.document_supplier_link_erase_business()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_business integer := NULLIF(current_setting('app.current_business_id', true), '')::integer;
  v_links integer;
  v_events integer;
BEGIN
  IF v_business IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS02', MESSAGE = 'DOCUMENT_SUPPLIER_LINK_ERASURE_NO_CONTEXT: no tenant context; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Business" b WHERE b."id" = v_business
                   AND (b."deletionRequestedAt" IS NOT NULL OR b."deletedAt" IS NOT NULL)) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZS02', MESSAGE = 'DOCUMENT_SUPPLIER_LINK_ERASURE_NOT_DELETING: the business is not being deleted; nothing was changed';
  END IF;
  UPDATE "DocumentSupplierLink" SET "linkedByUserId" = NULL, "removedByUserId" = NULL
   WHERE "businessId" = v_business AND ("linkedByUserId" IS NOT NULL OR "removedByUserId" IS NOT NULL);
  GET DIAGNOSTICS v_links = ROW_COUNT;
  UPDATE "DocumentSupplierLinkEvent" SET "actorUserId" = NULL
   WHERE "businessId" = v_business AND "actorUserId" IS NOT NULL;
  GET DIAGNOSTICS v_events = ROW_COUNT;
  RETURN v_links + v_events;
END
$fn$;
REVOKE ALL ON FUNCTION public.document_supplier_link_erase_business() FROM PUBLIC;

-- ── 6. Row-level security (FORCE; per command; no DELETE anywhere; the trail is append-only) ────

ALTER TABLE "DocumentSupplierLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DocumentSupplierLink" FORCE ROW LEVEL SECURITY;
CREATE POLICY document_supplier_link_tenant_select ON "DocumentSupplierLink" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY document_supplier_link_tenant_insert ON "DocumentSupplierLink" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY document_supplier_link_tenant_update ON "DocumentSupplierLink" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "DocumentSupplierLinkEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DocumentSupplierLinkEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY document_supplier_link_event_tenant_select ON "DocumentSupplierLinkEvent" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY document_supplier_link_event_tenant_insert ON "DocumentSupplierLinkEvent" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── 7. Privileges — named explicitly ────────────────────────────────────────────────────────────

REVOKE ALL ON "DocumentSupplierLink", "DocumentSupplierLinkEvent" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "DocumentSupplierLink_id_seq", "DocumentSupplierLinkEvent_id_seq" FROM PUBLIC;

-- Whatever the migration role's DEFAULT PRIVILEGES handed out on the new objects goes first.
DO $do$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT c.oid::regclass::text AS rel, pg_get_userbyid(x.grantee) AS grantee, c.relkind
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
     WHERE c.relname IN ('DocumentSupplierLink', 'DocumentSupplierLinkEvent',
                         'DocumentSupplierLink_id_seq', 'DocumentSupplierLinkEvent_id_seq')
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
    -- The decision row: read, create, change. Never removed (REMOVED is a state, not a DELETE).
    GRANT SELECT, INSERT, UPDATE ON "DocumentSupplierLink" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "DocumentSupplierLink_id_seq" TO app_runtime;

    -- Append-only for the runtime.
    GRANT SELECT, INSERT ON "DocumentSupplierLinkEvent" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "DocumentSupplierLinkEvent_id_seq" TO app_runtime;

    GRANT EXECUTE ON FUNCTION public.document_supplier_link_erase_business() TO app_runtime;
  END IF;
END
$do$;

-- ── 8. The flag — OFF ──────────────────────────────────────────────────────────────────────────

INSERT INTO "PlatformFeatureDefinition" ("key", "displayName", "category", "description", "defaultEnabled", "mutable", "createdAt")
VALUES ('document_supplier_linking', 'שיוך מסמכים לספקים', 'documents',
        'בחירת ספק במסך אישור המסמך, הצעות שיוך באישור בעל העסק והצגת המסמכים בתיק הספק', false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "PlatformFeaturePolicy" ("featureKey", "globalEnabled", "emergencyDisabled", "updatedAt")
VALUES ('document_supplier_linking', false, false, CURRENT_TIMESTAMP)
ON CONFLICT ("featureKey") DO NOTHING;
