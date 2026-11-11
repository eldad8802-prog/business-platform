-- Issuer declaration, series opening and one-way enforcement (#1081, owner decisions 2026-11-11).
-- DRAFT PR — NOT APPROVED FOR MERGE OR FOR APPLY IN ANY SHARED ENVIRONMENT.
--
-- Built from docs/sql-drafts/issuer-declaration-and-series-opening-v1.DRAFT.sql (revision 2, lab 40/40) with
-- three changes found while turning the draft into a migration:
--   1. a PLATFORM_DESIGNATED record is admitted only when written by the table owner (the designation
--      definer functions). Revision 2 trusted the session setting app.issuer_designation, which the runtime
--      can set itself with set_config() — closed (trigger BusinessIssuerDeclaration_designation_origin).
--   2. issuer_designate_initial(): the first declaration of a business with more than one user, named by a
--      platform admin with an evidence reference (revision 2 described it but omitted it).
--   3. privileges follow 20261121090000_business_documents_po_sheets: default privileges revoked, grants
--      only when the role exists.
--
-- Expand-only: three new tables, new enums, new functions and triggers. Existing rows are not touched.
-- Two triggers are added on existing tables and are INERT until an owner-approved step (not this migration):
--   * BillingDocument  — refuses ISSUED without a declaration ONLY when "IssuerDeclarationEnforcement" has its row;
--   * BusinessProfile  — refuses identity edits ONLY for a business that already has a live declaration.
-- No business has a declaration and the enforcement table is empty after this migration → no behaviour change.
--
-- Locks: CREATE TRIGGER on "BillingDocument" / "BusinessProfile" takes SHARE ROW EXCLUSIVE for the catalog change
-- only (writes wait milliseconds; reads continue). lock_timeout makes the apply fail fast instead of queueing every
-- issuance behind a long transaction — rerun it when the preflight shows no long transaction.

SET lock_timeout = '3s';

-- ---------------------------------------------------------------- enums
CREATE TYPE "IssuerTrack" AS ENUM ('EXEMPT_DEALER', 'AUTHORIZED_DEALER_INDIVIDUAL', 'COMPANY_AUTHORIZED_DEALER');
CREATE TYPE "IssuerLegalForm" AS ENUM ('INDIVIDUAL', 'COMPANY');
CREATE TYPE "IssuerVatStatus" AS ENUM ('EXEMPT', 'AUTHORIZED');
CREATE TYPE "IssuerIdType" AS ENUM ('ISRAELI_ID', 'COMPANY_NUMBER');
CREATE TYPE "IssuerDeclarationKind" AS ENUM (
  'INITIAL', 'EXISTING_CONFIRMATION', 'CONTACT_UPDATE', 'STATUS_CHANGE', 'CORRECTION', 'AUTHORITY_TRANSFER'
);
-- SOLE_USER_VERIFIED: first confirmation in a one-user business (server-checked) · PLATFORM_DESIGNATED: by the
-- platform designation function only · CURRENT_AUTHORIZED_USER: a later filing by the user the current
-- declaration names as authorized
CREATE TYPE "IssuerAuthorityBasis" AS ENUM ('SOLE_USER_VERIFIED', 'PLATFORM_DESIGNATED', 'CURRENT_AUTHORIZED_USER');
-- the EXISTING step-up mechanisms only: password re-check, or the existing AuthEmailToken link (new purpose)
CREATE TYPE "IssuerReauthMethod" AS ENUM ('PASSWORD', 'EMAIL_LINK', 'PLATFORM_ADMIN_ELEVATION');
CREATE TYPE "SeriesOpeningSource" AS ENUM ('NEW_BUSINESS', 'CONTINUES_PREVIOUS_TOOL', 'EXPLICIT_NEW_SERIES');

-- ---------------------------------------------------------------- A. declaration
CREATE TABLE "BusinessIssuerDeclaration" (
  "id"                    SERIAL PRIMARY KEY,
  "businessId"            INTEGER NOT NULL REFERENCES "Business"("id") ON DELETE RESTRICT,
  "version"               INTEGER NOT NULL CHECK ("version" >= 1),
  "supersedesId"          INTEGER NULL,
  "kind"                  "IssuerDeclarationKind" NOT NULL,
  "track"                 "IssuerTrack" NOT NULL,
  "legalForm"             "IssuerLegalForm" NOT NULL,
  "vatStatus"             "IssuerVatStatus" NOT NULL,
  "legalName"             TEXT NOT NULL CHECK (length(btrim("legalName")) BETWEEN 1 AND 200),
  "tradeName"             TEXT NULL CHECK ("tradeName" IS NULL OR length(btrim("tradeName")) BETWEEN 1 AND 200),
  "idType"                "IssuerIdType" NOT NULL,
  "idNumber"              TEXT NOT NULL CHECK ("idNumber" ~ '^[0-9]{9}$'),
  "vatRegistrationNumber" TEXT NULL CHECK ("vatRegistrationNumber" IS NULL OR "vatRegistrationNumber" ~ '^[0-9]{9}$'),
  "address"               TEXT NOT NULL CHECK (length(btrim("address")) BETWEEN 1 AND 300),
  "phone"                 TEXT NOT NULL CHECK (length(btrim("phone")) BETWEEN 1 AND 30),
  "email"                 TEXT NOT NULL CHECK (length(btrim("email")) BETWEEN 3 AND 320),
  "effectiveFrom"         TIMESTAMPTZ NOT NULL,
  "reason"                TEXT NULL CHECK ("reason" IS NULL OR length("reason") <= 1000),
  -- who may act from now on for this business, and on what basis
  "authorizedUserId"      INTEGER NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
  "authorityBasis"        "IssuerAuthorityBasis" NOT NULL,
  "authorityEvidenceRef"  TEXT NULL CHECK ("authorityEvidenceRef" IS NULL OR length("authorityEvidenceRef") <= 200),
  -- who confirmed THIS record (the authorized user, or the platform admin for a designation)
  "declaredByUserId"      INTEGER NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
  "declarantName"         TEXT NOT NULL CHECK (length(btrim("declarantName")) BETWEEN 1 AND 120),
  "declarantCapacity"     TEXT NOT NULL CHECK (length(btrim("declarantCapacity")) BETWEEN 1 AND 120),
  "statementVersion"      TEXT NOT NULL,
  "statementSha256"       CHAR(64) NOT NULL,
  "reauthMethod"          "IssuerReauthMethod" NOT NULL,
  "reauthAt"              TIMESTAMPTZ NOT NULL,
  "anonymisedAt"          TIMESTAMPTZ NULL,       -- set only by the erase path (see guard)
  "createdAt"             TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "IssuerDeclaration_track_shape" CHECK (
       ("track" = 'EXEMPT_DEALER'                AND "legalForm" = 'INDIVIDUAL' AND "vatStatus" = 'EXEMPT'     AND "idType" = 'ISRAELI_ID')
    OR ("track" = 'AUTHORIZED_DEALER_INDIVIDUAL' AND "legalForm" = 'INDIVIDUAL' AND "vatStatus" = 'AUTHORIZED' AND "idType" = 'ISRAELI_ID')
    OR ("track" = 'COMPANY_AUTHORIZED_DEALER'    AND "legalForm" = 'COMPANY'    AND "vatStatus" = 'AUTHORIZED' AND "idType" = 'COMPANY_NUMBER')
  ),
  CONSTRAINT "IssuerDeclaration_vat_number" CHECK ("vatStatus" = 'EXEMPT' OR "vatRegistrationNumber" IS NOT NULL),
  CONSTRAINT "IssuerDeclaration_first_has_no_predecessor" CHECK (("version" = 1) = ("supersedesId" IS NULL)),
  CONSTRAINT "IssuerDeclaration_first_kind" CHECK ("version" > 1 OR "kind" IN ('INITIAL', 'EXISTING_CONFIRMATION')),
  CONSTRAINT "IssuerDeclaration_designation_evidence" CHECK ("authorityBasis" <> 'PLATFORM_DESIGNATED' OR length(btrim(COALESCE("authorityEvidenceRef", ''))) >= 1),
  CONSTRAINT "IssuerDeclaration_admin_reauth" CHECK (("reauthMethod" = 'PLATFORM_ADMIN_ELEVATION') = ("authorityBasis" = 'PLATFORM_DESIGNATED' AND "declaredByUserId" <> "authorizedUserId"))
);
CREATE UNIQUE INDEX "BusinessIssuerDeclaration_businessId_version_key" ON "BusinessIssuerDeclaration" ("businessId", "version");
CREATE UNIQUE INDEX "BusinessIssuerDeclaration_supersedesId_key" ON "BusinessIssuerDeclaration" ("supersedesId") WHERE "supersedesId" IS NOT NULL;
CREATE UNIQUE INDEX "BusinessIssuerDeclaration_businessId_id_key" ON "BusinessIssuerDeclaration" ("businessId", "id");
CREATE INDEX "BusinessIssuerDeclaration_businessId_effectiveFrom_idx" ON "BusinessIssuerDeclaration" ("businessId", "effectiveFrom" DESC);
ALTER TABLE "BusinessIssuerDeclaration"
  ADD CONSTRAINT "BusinessIssuerDeclaration_supersedes_same_business"
  FOREIGN KEY ("businessId", "supersedesId") REFERENCES "BusinessIssuerDeclaration" ("businessId", "id");

-- ---------------------------------------------------------------- C. series opening
CREATE TABLE "BillingSeriesOpening" (
  "id"                       SERIAL PRIMARY KEY,
  "businessId"               INTEGER NOT NULL REFERENCES "Business"("id") ON DELETE RESTRICT,
  "documentType"             "BillingDocumentType" NOT NULL CHECK ("documentType"::text IN ('TAX_INVOICE', 'TAX_INVOICE_RECEIPT', 'RECEIPT', 'CREDIT_NOTE')),
  "seriesCode"               TEXT NOT NULL DEFAULT 'MAIN' CHECK ("seriesCode" ~ '^[A-Z][A-Z0-9_]{0,15}$'),
  "openingNumber"            INTEGER NOT NULL CHECK ("openingNumber" BETWEEN 1 AND 999999),
  "source"                   "SeriesOpeningSource" NOT NULL,
  "previousToolName"         TEXT NULL CHECK ("previousToolName" IS NULL OR length("previousToolName") <= 120),
  "lastNumberInPreviousTool" INTEGER NULL CHECK ("lastNumberInPreviousTool" IS NULL OR "lastNumberInPreviousTool" >= 1),
  "declarationId"            INTEGER NOT NULL,
  "declaredByUserId"         INTEGER NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
  "createdAt"                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "SeriesOpening_source_shape" CHECK (
       ("source" = 'NEW_BUSINESS'            AND "openingNumber" = 1 AND "previousToolName" IS NULL AND "lastNumberInPreviousTool" IS NULL)
    OR ("source" = 'CONTINUES_PREVIOUS_TOOL' AND "previousToolName" IS NOT NULL AND "lastNumberInPreviousTool" IS NOT NULL
                                             AND "openingNumber" = "lastNumberInPreviousTool" + 1)
    OR ("source" = 'EXPLICIT_NEW_SERIES'     AND "seriesCode" <> 'MAIN')
  ),
  CONSTRAINT "SeriesOpening_declaration_same_business"
    FOREIGN KEY ("businessId", "declarationId") REFERENCES "BusinessIssuerDeclaration" ("businessId", "id")
);
CREATE UNIQUE INDEX "BillingSeriesOpening_series_key" ON "BillingSeriesOpening" ("businessId", "documentType", "seriesCode");

-- ---------------------------------------------------------------- D. enforcement switch (one-way)
CREATE TABLE "IssuerDeclarationEnforcement" (
  "id"            SERIAL PRIMARY KEY,
  "enforcedFrom"  TIMESTAMPTZ NOT NULL,
  "recordedBy"    TEXT NOT NULL,                      -- the approval record / release that switched it on
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "IssuerDeclarationEnforcement_single" ON "IssuerDeclarationEnforcement" ((true));
-- written once by the owner (migration / ops), never by the runtime; append-only like the rest

-- ---------------------------------------------------------------- RLS + grants
ALTER TABLE "BusinessIssuerDeclaration" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessIssuerDeclaration" FORCE ROW LEVEL SECURITY;
CREATE POLICY issuer_declaration_tenant_select ON "BusinessIssuerDeclaration" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY issuer_declaration_tenant_insert ON "BusinessIssuerDeclaration" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
ALTER TABLE "BillingSeriesOpening" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BillingSeriesOpening" FORCE ROW LEVEL SECURITY;
CREATE POLICY series_opening_tenant_select ON "BillingSeriesOpening" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY series_opening_tenant_insert ON "BillingSeriesOpening" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

REVOKE ALL ON "BusinessIssuerDeclaration", "BillingSeriesOpening", "IssuerDeclarationEnforcement" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "BusinessIssuerDeclaration_id_seq", "BillingSeriesOpening_id_seq", "IssuerDeclarationEnforcement_id_seq" FROM PUBLIC;
-- (role grants: section "privileges" at the end, after every function exists)

-- ---------------------------------------------------------------- guards
-- Append-only. The ONLY admitted change: the table owner (the account-purge definer function) anonymising
-- the personal columns of a declaration, setting anonymisedAt — every other column must stay identical.
CREATE OR REPLACE FUNCTION public.issuer_records_append_only_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  is_owner boolean := current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID);
  personal text[] := ARRAY['legalName','tradeName','idNumber','vatRegistrationNumber','address','phone','email','declarantName','declarantCapacity','anonymisedAt'];
BEGIN
  IF TG_OP = 'UPDATE' AND is_owner AND TG_TABLE_NAME = 'BusinessIssuerDeclaration' THEN
    IF OLD."anonymisedAt" IS NULL AND NEW."anonymisedAt" IS NOT NULL
     AND (to_jsonb(NEW) - personal) = (to_jsonb(OLD) - personal)
     AND NEW."legalName" = '—' AND NEW."tradeName" IS NULL AND NEW."idNumber" = '000000000'
     AND NEW."vatRegistrationNumber" IS NOT DISTINCT FROM (CASE WHEN OLD."vatRegistrationNumber" IS NULL THEN NULL ELSE '000000000' END)
     AND NEW."address" = '—' AND NEW."phone" = '—' AND NEW."email" = 'erased@invalid'
     AND NEW."declarantName" = '—' AND NEW."declarantCapacity" = '—' THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'DZD30', MESSAGE = format('ISSUER_RECORDS_APPEND_ONLY: %s on %I is refused', TG_OP, TG_TABLE_NAME);
END
$fn$;
REVOKE ALL ON FUNCTION public.issuer_records_append_only_guard() FROM PUBLIC;
CREATE TRIGGER "BusinessIssuerDeclaration_append_only" BEFORE UPDATE OR DELETE ON "BusinessIssuerDeclaration"
  FOR EACH ROW EXECUTE FUNCTION public.issuer_records_append_only_guard();
CREATE TRIGGER "BillingSeriesOpening_append_only" BEFORE UPDATE OR DELETE ON "BillingSeriesOpening"
  FOR EACH ROW EXECUTE FUNCTION public.issuer_records_append_only_guard();
CREATE TRIGGER "IssuerDeclarationEnforcement_append_only" BEFORE UPDATE OR DELETE ON "IssuerDeclarationEnforcement"
  FOR EACH ROW EXECUTE FUNCTION public.issuer_records_append_only_guard();

-- Chain + authority. SECURITY DEFINER so it can count the business's users (the runtime need not read "User").
CREATE OR REPLACE FUNCTION public.issuer_declaration_chain_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  cur public."BusinessIssuerDeclaration";
  users_in_business integer;
  issued_under boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('issuer_declaration:' || NEW."businessId", 0));
  SELECT count(*) INTO users_in_business FROM public."User" u WHERE u."businessId" = NEW."businessId";

  -- AUTHORITY (no order-of-signup anywhere)
  IF NEW."authorityBasis" = 'SOLE_USER_VERIFIED' THEN
    IF users_in_business <> 1 OR NEW."declaredByUserId" <> NEW."authorizedUserId"
       OR NOT EXISTS (SELECT 1 FROM public."User" u WHERE u."id" = NEW."authorizedUserId" AND u."businessId" = NEW."businessId") THEN
      RAISE EXCEPTION USING ERRCODE = 'DZD33', MESSAGE = 'ISSUER_AUTHORITY_SOLE_USER_REQUIRED';
    END IF;
  ELSIF NEW."authorityBasis" = 'CURRENT_AUTHORIZED_USER' THEN
    NULL;  -- checked against the current declaration below
  ELSIF NEW."authorityBasis" = 'PLATFORM_DESIGNATED' THEN
    NULL;  -- the writer is checked by BusinessIssuerDeclaration_designation_origin (SECURITY INVOKER)
  END IF;

  -- R1 (review 2026-11-11): a declaration cannot take effect in the future — a far-future effectiveFrom would make
  -- "documents issued under it" (issuedAt >= effectiveFrom) always empty and so open CORRECTION and erase.
  IF NEW."effectiveFrom" > now() + interval '5 minutes' THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD31', MESSAGE = 'ISSUER_EFFECTIVE_FROM_IN_FUTURE';
  END IF;
  SELECT * INTO cur FROM public."BusinessIssuerDeclaration"
   WHERE "businessId" = NEW."businessId" ORDER BY "version" DESC LIMIT 1;
  IF cur."id" IS NOT NULL AND NEW."effectiveFrom" < cur."effectiveFrom" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD31', MESSAGE = 'ISSUER_EFFECTIVE_FROM_BEFORE_CURRENT';
  END IF;
  IF cur."id" IS NULL THEN
    IF NEW."version" <> 1 THEN RAISE EXCEPTION USING ERRCODE = 'DZD31', MESSAGE = 'ISSUER_DECLARATION_FIRST_MUST_BE_VERSION_1'; END IF;
    IF NEW."authorityBasis" = 'CURRENT_AUTHORIZED_USER' THEN
      RAISE EXCEPTION USING ERRCODE = 'DZD33', MESSAGE = 'ISSUER_NO_CURRENT_AUTHORIZED_USER';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."authorityBasis" = 'CURRENT_AUTHORIZED_USER'
     AND (NEW."declaredByUserId" <> cur."authorizedUserId" OR NEW."authorizedUserId" <> cur."authorizedUserId") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD33', MESSAGE = 'ISSUER_ONLY_AUTHORIZED_USER_MAY_CHANGE';
  END IF;
  IF NEW."supersedesId" IS DISTINCT FROM cur."id" OR NEW."version" <> cur."version" + 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD31', MESSAGE = 'ISSUER_DECLARATION_MUST_SUPERSEDE_CURRENT';
  END IF;
  -- after the first: only the CURRENT authorized user may file, unless this is a platform designation
  IF NEW."kind" <> 'AUTHORITY_TRANSFER' AND NEW."declaredByUserId" <> cur."authorizedUserId" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD33', MESSAGE = 'ISSUER_ONLY_AUTHORIZED_USER_MAY_CHANGE';
  END IF;
  IF NEW."kind" = 'AUTHORITY_TRANSFER' AND NEW."authorityBasis" <> 'PLATFORM_DESIGNATED'
     AND NOT (users_in_business = 1 AND NEW."authorityBasis" = 'SOLE_USER_VERIFIED') THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD33', MESSAGE = 'ISSUER_TRANSFER_REQUIRES_DESIGNATION';
  END IF;
  -- the legal person never changes inside a business (a company is a new business)
  IF (NEW."legalForm" <> cur."legalForm" OR NEW."idType" <> cur."idType" OR NEW."idNumber" <> cur."idNumber")
     AND NEW."kind" <> 'CORRECTION' THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD31', MESSAGE = 'ISSUER_IDENTITY_IS_LOCKED';
  END IF;
  -- an AUTHORITY_TRANSFER changes WHO may act, nothing about the issuer
  IF NEW."kind" = 'AUTHORITY_TRANSFER' AND (to_jsonb(NEW) - ARRAY['id','version','supersedesId','kind','authorizedUserId','authorityBasis','authorityEvidenceRef','declaredByUserId','declarantName','declarantCapacity','statementVersion','statementSha256','reauthMethod','reauthAt','effectiveFrom','reason','createdAt'])
                                             <> (to_jsonb(cur) - ARRAY['id','version','supersedesId','kind','authorizedUserId','authorityBasis','authorityEvidenceRef','declaredByUserId','declarantName','declarantCapacity','statementVersion','statementSha256','reauthMethod','reauthAt','effectiveFrom','reason','createdAt']) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD31', MESSAGE = 'ISSUER_TRANSFER_TOUCHES_IDENTITY';
  END IF;
  SELECT EXISTS (SELECT 1 FROM public."BillingDocument" d
                  WHERE d."businessId" = NEW."businessId" AND d."status"::text = 'ISSUED'
                    AND d."documentType"::text IN ('TAX_INVOICE','TAX_INVOICE_RECEIPT','RECEIPT','CREDIT_NOTE')
                    AND d."issuedAt" >= cur."effectiveFrom") INTO issued_under;
  IF NEW."kind" = 'CORRECTION' AND issued_under THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD31', MESSAGE = 'ISSUER_CORRECTION_AFTER_ISSUANCE_REFUSED';
  END IF;
  IF NEW."kind" = 'CONTACT_UPDATE' AND (NEW."track" <> cur."track" OR NEW."legalName" <> cur."legalName"
       OR NEW."vatRegistrationNumber" IS DISTINCT FROM cur."vatRegistrationNumber") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD31', MESSAGE = 'ISSUER_CONTACT_UPDATE_TOUCHES_IDENTITY';
  END IF;
  IF NEW."kind" = 'STATUS_CHANGE' AND (NEW."vatStatus" = cur."vatStatus" OR NEW."effectiveFrom" < cur."effectiveFrom") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD31', MESSAGE = 'ISSUER_STATUS_CHANGE_INVALID';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.issuer_declaration_chain_guard() FROM PUBLIC;
CREATE TRIGGER "BusinessIssuerDeclaration_chain" BEFORE INSERT ON "BusinessIssuerDeclaration"
  FOR EACH ROW EXECUTE FUNCTION public.issuer_declaration_chain_guard();

-- A designation is written ONLY by the designation definer functions, which run as the table owner. SECURITY
-- INVOKER on purpose: current_user is the writer, so the runtime inserting directly is refused whatever session
-- settings it has set. Both BEFORE INSERT triggers must pass; their firing order does not change the outcome.
CREATE OR REPLACE FUNCTION public.issuer_designation_origin_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF NEW."authorityBasis" = 'PLATFORM_DESIGNATED'
     AND current_user IS DISTINCT FROM (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD33', MESSAGE = 'ISSUER_DESIGNATION_ONLY_BY_PLATFORM_FUNCTION';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.issuer_designation_origin_guard() FROM PUBLIC;
CREATE TRIGGER "BusinessIssuerDeclaration_designation_origin" BEFORE INSERT ON "BusinessIssuerDeclaration"
  FOR EACH ROW EXECUTE FUNCTION public.issuer_designation_origin_guard();

-- Platform designation: the ONLY way to name the authorized user of a multi-user business, or to restore
-- access when the authorized user is unavailable. Granted to the platform-admin role only; the application
-- calls it only behind the existing platform-admin MFA/passkey elevation. Copies the issuer fields of the
-- current declaration unchanged (an AUTHORITY_TRANSFER changes nothing about the issuer).
CREATE OR REPLACE FUNCTION public.issuer_designate_authorized_user(
  p_business integer, p_authorized_user integer, p_admin_user integer, p_admin_name text,
  p_evidence_ref text, p_reason text, p_statement_version text, p_statement_sha256 text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE cur public."BusinessIssuerDeclaration"; new_id integer; prev_business text;
BEGIN
  prev_business := current_setting('app.current_business_id', true);
  PERFORM set_config('app.current_business_id', p_business::text, true);
  IF NOT EXISTS (SELECT 1 FROM public."User" u WHERE u."id" = p_authorized_user AND u."businessId" = p_business) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD33', MESSAGE = 'ISSUER_DESIGNATED_USER_NOT_IN_BUSINESS';
  END IF;
  SELECT * INTO cur FROM public."BusinessIssuerDeclaration" WHERE "businessId" = p_business ORDER BY "version" DESC LIMIT 1;
  IF cur."id" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD33', MESSAGE = 'ISSUER_DESIGNATION_NEEDS_A_DECLARATION_TO_TRANSFER';
  END IF;
  INSERT INTO public."BusinessIssuerDeclaration" ("businessId","version","supersedesId","kind","track","legalForm","vatStatus",
      "legalName","tradeName","idType","idNumber","vatRegistrationNumber","address","phone","email","effectiveFrom","reason",
      "authorizedUserId","authorityBasis","authorityEvidenceRef","declaredByUserId","declarantName","declarantCapacity",
      "statementVersion","statementSha256","reauthMethod","reauthAt")
  VALUES (p_business, cur."version" + 1, cur."id", 'AUTHORITY_TRANSFER', cur."track", cur."legalForm", cur."vatStatus",
      cur."legalName", cur."tradeName", cur."idType", cur."idNumber", cur."vatRegistrationNumber", cur."address", cur."phone", cur."email",
      cur."effectiveFrom", p_reason, p_authorized_user, 'PLATFORM_DESIGNATED', p_evidence_ref, p_admin_user, p_admin_name, 'מנהל פלטפורמה',
      p_statement_version, p_statement_sha256, 'PLATFORM_ADMIN_ELEVATION', now())
  RETURNING "id" INTO new_id;
  -- R3 (review 2026-11-11): the caller's tenant setting is restored — nothing after this call runs as p_business.
  PERFORM set_config('app.current_business_id', COALESCE(prev_business, ''), true);
  RETURN new_id;
END
$fn$;
REVOKE ALL ON FUNCTION public.issuer_designate_authorized_user(integer, integer, integer, text, text, text, text, text) FROM PUBLIC;
-- The FIRST declaration of a business with more than one user: a platform admin names the authorized user and
-- records the issuer details the business supplied, with an evidence reference. Same table rules as any record.
CREATE OR REPLACE FUNCTION public.issuer_designate_initial(
  p_business integer, p_authorized_user integer, p_admin_user integer, p_admin_name text,
  p_evidence_ref text, p_reason text, p_statement_version text, p_statement_sha256 text, p_issuer jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE v public."BusinessIssuerDeclaration"; new_id integer; prev_business text;
BEGIN
  prev_business := current_setting('app.current_business_id', true);
  PERFORM set_config('app.current_business_id', p_business::text, true);
  IF NOT EXISTS (SELECT 1 FROM public."User" u WHERE u."id" = p_authorized_user AND u."businessId" = p_business) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD33', MESSAGE = 'ISSUER_DESIGNATED_USER_NOT_IN_BUSINESS';
  END IF;
  IF EXISTS (SELECT 1 FROM public."BusinessIssuerDeclaration" WHERE "businessId" = p_business) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD33', MESSAGE = 'ISSUER_DESIGNATION_INITIAL_ALREADY_DECLARED';
  END IF;
  v := jsonb_populate_record(NULL::public."BusinessIssuerDeclaration", p_issuer);
  INSERT INTO public."BusinessIssuerDeclaration" ("businessId","version","supersedesId","kind","track","legalForm","vatStatus",
      "legalName","tradeName","idType","idNumber","vatRegistrationNumber","address","phone","email","effectiveFrom","reason",
      "authorizedUserId","authorityBasis","authorityEvidenceRef","declaredByUserId","declarantName","declarantCapacity",
      "statementVersion","statementSha256","reauthMethod","reauthAt")
  VALUES (p_business, 1, NULL, COALESCE(v."kind", 'INITIAL'), v."track", v."legalForm", v."vatStatus",
      v."legalName", v."tradeName", v."idType", v."idNumber", v."vatRegistrationNumber", v."address", v."phone", v."email",
      COALESCE(v."effectiveFrom", now()), p_reason, p_authorized_user, 'PLATFORM_DESIGNATED', p_evidence_ref, p_admin_user,
      p_admin_name, 'מנהל פלטפורמה', p_statement_version, p_statement_sha256, 'PLATFORM_ADMIN_ELEVATION', now())
  RETURNING "id" INTO new_id;
  -- R3 (review 2026-11-11): the caller's tenant setting is restored — nothing after this call runs as p_business.
  PERFORM set_config('app.current_business_id', COALESCE(prev_business, ''), true);
  RETURN new_id;
END
$fn$;
REVOKE ALL ON FUNCTION public.issuer_designate_initial(integer, integer, integer, text, text, text, text, text, jsonb) FROM PUBLIC;

-- E. An opening is accepted only while its series has never been used.
CREATE OR REPLACE FUNCTION public.series_opening_unused_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('series:' || NEW."businessId" || ':' || NEW."documentType"::text || ':' || NEW."seriesCode", 0));
  IF NEW."seriesCode" = 'MAIN' AND (
       EXISTS (SELECT 1 FROM public."BillingDocumentNumberSequence" s WHERE s."businessId" = NEW."businessId" AND s."documentType" = NEW."documentType")
    OR EXISTS (SELECT 1 FROM public."BillingDocument" d WHERE d."businessId" = NEW."businessId" AND d."documentType" = NEW."documentType" AND d."documentNumber" IS NOT NULL)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD32', MESSAGE = 'SERIES_ALREADY_USED_OPENING_REFUSED';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.series_opening_unused_guard() FROM PUBLIC;
CREATE TRIGGER "BillingSeriesOpening_unused" BEFORE INSERT ON "BillingSeriesOpening"
  FOR EACH ROW EXECUTE FUNCTION public.series_opening_unused_guard();

CREATE OR REPLACE FUNCTION public.issuer_records_truncate_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'DZD30', MESSAGE = format('ISSUER_RECORDS_APPEND_ONLY: TRUNCATE on %I is refused', TG_TABLE_NAME);
END
$fn$;
REVOKE ALL ON FUNCTION public.issuer_records_truncate_guard() FROM PUBLIC;
CREATE TRIGGER "BusinessIssuerDeclaration_no_truncate" BEFORE TRUNCATE ON "BusinessIssuerDeclaration"
  FOR EACH STATEMENT EXECUTE FUNCTION public.issuer_records_truncate_guard();
CREATE TRIGGER "BillingSeriesOpening_no_truncate" BEFORE TRUNCATE ON "BillingSeriesOpening"
  FOR EACH STATEMENT EXECUTE FUNCTION public.issuer_records_truncate_guard();
CREATE TRIGGER "IssuerDeclarationEnforcement_no_truncate" BEFORE TRUNCATE ON "IssuerDeclarationEnforcement"
  FOR EACH STATEMENT EXECUTE FUNCTION public.issuer_records_truncate_guard();

-- ---------------------------------------------------------------- B. rollback-safe enforcement (A0: touches BillingDocument)
-- Once "IssuerDeclarationEnforcement" holds its row, two triggers hold the line regardless of which
-- application release is running:
--  B1. a fiscal document cannot become ISSUED in a business with no declaration (fail closed before numbering
--      is impossible at DB level, so it fails the whole issue transaction — the number is rolled back with it);
--  B2. the identity columns of "BusinessProfile" can only be written to the values of the current declaration
--      (the profile becomes a projection; an old release's PATCH that edits them is refused).
CREATE OR REPLACE FUNCTION public.issuer_issue_requires_declaration()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD."status"::text = 'ISSUED' THEN RETURN NEW; END IF;   -- not a transition to ISSUED
  END IF;
  -- R4 (review 2026-11-11): INSERT … status ISSUED is covered too (no application path does it today).
  IF NEW."status"::text = 'ISSUED'
     AND NEW."documentType"::text IN ('TAX_INVOICE','TAX_INVOICE_RECEIPT','RECEIPT','CREDIT_NOTE')
     AND EXISTS (SELECT 1 FROM public."IssuerDeclarationEnforcement")
     AND NOT EXISTS (SELECT 1 FROM public."BusinessIssuerDeclaration" x WHERE x."businessId" = NEW."businessId" AND x."anonymisedAt" IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD34', MESSAGE = 'ISSUER_DECLARATION_REQUIRED_TO_ISSUE';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.issuer_issue_requires_declaration() FROM PUBLIC;
CREATE TRIGGER "BillingDocument_issue_requires_declaration" BEFORE UPDATE OF "status" ON "BillingDocument"
  FOR EACH ROW EXECUTE FUNCTION public.issuer_issue_requires_declaration();
CREATE TRIGGER "BillingDocument_insert_issued_requires_declaration" BEFORE INSERT ON "BillingDocument"
  FOR EACH ROW WHEN (NEW."status"::text = 'ISSUED') EXECUTE FUNCTION public.issuer_issue_requires_declaration();

-- SECURITY INVOKER on purpose: it must see WHO writes (the runtime is caught).
-- The account purge (account-deletion.prisma-store.ts, stage 2) runs AS THE RUNTIME and clears these columns. It runs only
-- after stage 1 committed Business.deletionRequestedAt (a quarantine: every normal write is refused from then on), so a
-- business being deleted is let through — otherwise a declaration documents were issued under (retained, never
-- anonymised) would block the purge forever. The issued documents keep their own frozen issuer snapshot.
-- Narrow definer helper: answers one yes/no question about one business, so the invoker trigger below does not depend
-- on the caller's table grants on "Business".
CREATE OR REPLACE FUNCTION public.issuer_business_is_being_deleted(p_business integer)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
  SELECT EXISTS (SELECT 1 FROM public."Business" b WHERE b."id" = p_business
                   AND (b."deletionRequestedAt" IS NOT NULL OR b."deletedAt" IS NOT NULL))
$fn$;
REVOKE ALL ON FUNCTION public.issuer_business_is_being_deleted(integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.issuer_profile_identity_lock()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE cur public."BusinessIssuerDeclaration";
BEGIN
  IF current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID)
     OR public.issuer_business_is_being_deleted(NEW."businessId") THEN
    RETURN NEW;
  END IF;
  SELECT * INTO cur FROM public."BusinessIssuerDeclaration" WHERE "businessId" = NEW."businessId" ORDER BY "version" DESC LIMIT 1;
  IF cur."id" IS NULL OR cur."anonymisedAt" IS NOT NULL THEN
    RETURN NEW;                              -- no live declaration yet: the profile is a draft
  END IF;
  IF NEW."billingLegalName" IS DISTINCT FROM cur."legalName"
     OR NEW."billingTaxId" IS DISTINCT FROM cur."idNumber"
     OR NEW."billingVatNumber" IS DISTINCT FROM cur."vatRegistrationNumber"
     OR NEW."billingBusinessKind" IS DISTINCT FROM (CASE cur."track" WHEN 'EXEMPT_DEALER' THEN 'EXEMPT_DEALER'
                                                                    WHEN 'AUTHORIZED_DEALER_INDIVIDUAL' THEN 'AUTHORIZED_DEALER'
                                                                    ELSE 'LTD_COMPANY' END) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD35', MESSAGE = 'ISSUER_PROFILE_IDENTITY_LOCKED';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.issuer_profile_identity_lock() FROM PUBLIC;
CREATE TRIGGER "BusinessProfile_issuer_identity_lock" BEFORE UPDATE OF "billingLegalName", "billingTaxId", "billingVatNumber", "billingBusinessKind" ON "BusinessProfile"
  FOR EACH ROW EXECUTE FUNCTION public.issuer_profile_identity_lock();
-- R5 (review 2026-11-11): an upsert that CREATES the profile row is held to the same rule.
CREATE TRIGGER "BusinessProfile_issuer_identity_lock_insert" BEFORE INSERT ON "BusinessProfile"
  FOR EACH ROW EXECUTE FUNCTION public.issuer_profile_identity_lock();
-- (the account purge runs AS THE RUNTIME and is let through only for a business being deleted — see
--  issuer_business_is_being_deleted above; a retained declaration keeps the issuer identity of the documents
--  issued under it — §5)

-- ---------------------------------------------------------------- erase (decision R-split)
-- Anonymise (never DELETE) a declaration under which no fiscal document was issued; keep the others
-- (RETAINED_BY_DESIGN, LEGAL/FISCAL). Called from the account-purge transaction, which runs as the runtime
-- (like business_documents_erase()); refused unless the business is being deleted, so the runtime cannot
-- anonymise a live business's declaration.
CREATE OR REPLACE FUNCTION public.issuer_declaration_erase()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE v_business integer := NULLIF(current_setting('app.current_business_id', true), '')::integer; n integer;
BEGIN
  IF v_business IS NULL THEN RAISE EXCEPTION USING ERRCODE = 'DZD36', MESSAGE = 'ISSUER_ERASE_NEEDS_TENANT'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."Business" b WHERE b."id" = v_business
                   AND (b."deletionRequestedAt" IS NOT NULL OR b."deletedAt" IS NOT NULL)) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD36', MESSAGE = 'ISSUER_ERASE_NOT_DELETING';
  END IF;
  UPDATE public."BusinessIssuerDeclaration" x
     SET "legalName" = '—', "tradeName" = NULL, "idNumber" = '000000000',
         "vatRegistrationNumber" = CASE WHEN x."vatRegistrationNumber" IS NULL THEN NULL ELSE '000000000' END,
         "address" = '—', "phone" = '—', "email" = 'erased@invalid', "declarantName" = '—', "declarantCapacity" = '—',
         "anonymisedAt" = now()
   WHERE x."businessId" = v_business AND x."anonymisedAt" IS NULL
     AND NOT EXISTS (SELECT 1 FROM public."BillingDocument" d
                      WHERE d."businessId" = v_business AND d."status"::text = 'ISSUED'
                        AND d."documentType"::text IN ('TAX_INVOICE','TAX_INVOICE_RECEIPT','RECEIPT','CREDIT_NOTE')
                        AND d."issuedAt" >= x."effectiveFrom");
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$fn$;
REVOKE ALL ON FUNCTION public.issuer_declaration_erase() FROM PUBLIC;

-- ---------------------------------------------------------------- privileges (named explicitly)
-- Whatever the migration role's DEFAULT PRIVILEGES handed out on the NEW objects goes first.
DO $do$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT DISTINCT c.oid::regclass::text AS rel, pg_get_userbyid(x.grantee) AS grantee, c.relkind
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
     WHERE c.relname IN ('BusinessIssuerDeclaration', 'BusinessIssuerDeclaration_id_seq', 'BillingSeriesOpening',
                         'BillingSeriesOpening_id_seq', 'IssuerDeclarationEnforcement', 'IssuerDeclarationEnforcement_id_seq')
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
    -- append-only for the runtime: read and add; the enforcement switch is read-only
    GRANT SELECT, INSERT ON "BusinessIssuerDeclaration", "BillingSeriesOpening" TO app_runtime;
    GRANT SELECT ON "IssuerDeclarationEnforcement" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "BusinessIssuerDeclaration_id_seq", "BillingSeriesOpening_id_seq" TO app_runtime;
    -- the account-purge path runs as the runtime, like business_documents_erase()
    GRANT EXECUTE ON FUNCTION public.issuer_declaration_erase() TO app_runtime;
    -- read by the profile identity lock, which runs as the writer
    GRANT EXECUTE ON FUNCTION public.issuer_business_is_being_deleted(integer) TO app_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin') THEN
    -- platform designation only — the application calls these behind the existing platform-admin elevation
    GRANT EXECUTE ON FUNCTION public.issuer_designate_authorized_user(integer, integer, integer, text, text, text, text, text) TO app_admin;
    GRANT EXECUTE ON FUNCTION public.issuer_designate_initial(integer, integer, integer, text, text, text, text, text, jsonb) TO app_admin;
  END IF;
END
$do$;

-- ---------------------------------------------------------------- down
-- Code rollback: the triggers above stay; an older release cannot edit identity or issue without a
-- declaration once enforcement is on. Removing enforcement is NOT a rollback step: it needs its own
-- migration and approval. Dropping the tables is allowed only when P-DOWN returns 0/0/0.
--   P-DOWN: SELECT (SELECT count(*) FROM "BusinessIssuerDeclaration"), (SELECT count(*) FROM "BillingSeriesOpening"),
--                  (SELECT count(*) FROM "IssuerDeclarationEnforcement");
