-- ============================================================================
-- DRAFT FOR REVIEW — NOT A MIGRATION — DO NOT APPLY
--
-- issuer-declaration-and-series-opening-v1.DRAFT.sql   (revision 2, 2026-11-11 — owner review of #1081)
--
--   A. BusinessIssuerDeclaration  — the declared issuer identity, append-only history
--   B. Locked identity            — DB guards on BusinessProfile and on issuance (rollback-safe)
--   C. BillingSeriesOpening       — declared opening number of a document series
--   D. IssuerDeclarationEnforcement — one-way switch: once enforced, never un-enforced by a release
--
-- Design: docs/issuer-declaration-data-package-v1.md. Outside prisma/migrations on purpose: no release
-- tool reads it. The real migration is written only after the owner approves this exact shape.
--
-- Conventions from 20261114090000_business_documents_records and 20260926140000_sec_f_…:
--   FORCE RLS on app.current_business_id · runtime: SELECT + INSERT only · append-only triggers (DZD3x) ·
--   SECURITY DEFINER with search_path = pg_catalog, public, pg_temp, EXECUTE revoked from PUBLIC.
--
-- Revision 2 changes (owner review):
--   * authority is NOT "the first declarant": the server checks at confirmation time that the business has
--     exactly ONE user and that the confirming user is that user (basis SOLE_USER_VERIFIED). A business with
--     more than one user cannot self-confirm: a platform admin designates the authorized user through a
--     SECURITY DEFINER function (basis PLATFORM_DESIGNATED, evidence reference required). Order of signup
--     is never used.
--   * no DELETE ever. Erasing a never-used declaration = anonymising its personal columns, by the table
--     owner only (the account-purge definer function), and the guard admits ONLY that exact change.
--   * rollback-safe enforcement: identity edits and issuance without a declaration are refused by DB
--     triggers once enforcement is switched on — an older application release cannot reopen them.
-- ============================================================================

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
  CONSTRAINT "IssuerDeclaration_designation_evidence" CHECK ("authorityBasis" <> 'PLATFORM_DESIGNATED' OR "authorityEvidenceRef" IS NOT NULL),
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
GRANT SELECT, INSERT ON "BusinessIssuerDeclaration", "BillingSeriesOpening" TO app_runtime;
GRANT SELECT ON "IssuerDeclarationEnforcement" TO app_runtime;
GRANT USAGE, SELECT ON SEQUENCE "BusinessIssuerDeclaration_id_seq", "BillingSeriesOpening_id_seq" TO app_runtime;

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
    -- only through public.issuer_designate_authorized_user() (platform admin, elevated)
    IF current_setting('app.issuer_designation', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION USING ERRCODE = 'DZD33', MESSAGE = 'ISSUER_DESIGNATION_ONLY_BY_PLATFORM_FUNCTION';
    END IF;
  END IF;

  SELECT * INTO cur FROM public."BusinessIssuerDeclaration"
   WHERE "businessId" = NEW."businessId" ORDER BY "version" DESC LIMIT 1;
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

-- Platform designation: the ONLY way to name the authorized user of a multi-user business, or to restore
-- access when the authorized user is unavailable. Granted to the platform-admin role only; the application
-- calls it only behind the existing platform-admin MFA/passkey elevation. Copies the issuer fields of the
-- current declaration unchanged (an AUTHORITY_TRANSFER changes nothing about the issuer).
CREATE OR REPLACE FUNCTION public.issuer_designate_authorized_user(
  p_business integer, p_authorized_user integer, p_admin_user integer, p_admin_name text,
  p_evidence_ref text, p_reason text, p_statement_version text, p_statement_sha256 text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE cur public."BusinessIssuerDeclaration"; new_id integer;
BEGIN
  PERFORM set_config('app.issuer_designation', 'on', true);
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
  RETURN new_id;
END
$fn$;
REVOKE ALL ON FUNCTION public.issuer_designate_authorized_user(integer, integer, integer, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.issuer_designate_authorized_user(integer, integer, integer, text, text, text, text, text) TO app_admin;
-- NOTE: a business with >1 user and NO declaration yet is designated the same way; the INITIAL record for
-- that case is inserted by a sibling function issuer_designate_initial(...) (same rules, kind INITIAL /
-- EXISTING_CONFIRMATION, basis PLATFORM_DESIGNATED). Omitted here for length; it follows this function.

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
  IF NEW."status"::text = 'ISSUED' AND OLD."status"::text <> 'ISSUED'
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

-- SECURITY INVOKER on purpose: it must see WHO writes (the runtime is caught; the purge runs as the owner).
CREATE OR REPLACE FUNCTION public.issuer_profile_identity_lock()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE cur public."BusinessIssuerDeclaration";
BEGIN
  -- the account-purge path (session user = table owner) may clear the profile; the runtime never is the owner
  IF current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID) THEN
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
-- (the account-purge path clears these profile columns as the table owner — the only session the lock lets
--  through; a retained declaration keeps the issuer identity of the documents issued under it — §5)

-- ---------------------------------------------------------------- erase (decision R-split)
-- Anonymise (never DELETE) a declaration under which no fiscal document was issued; keep the others
-- (RETAINED_BY_DESIGN, LEGAL/FISCAL). Called only from the account-purge transaction (owner).
CREATE OR REPLACE FUNCTION public.issuer_declaration_erase()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE v_business integer := NULLIF(current_setting('app.current_business_id', true), '')::integer; n integer;
BEGIN
  IF v_business IS NULL THEN RAISE EXCEPTION USING ERRCODE = 'DZD36', MESSAGE = 'ISSUER_ERASE_NEEDS_TENANT'; END IF;
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
-- GRANT EXECUTE … TO the purge role only (same as business_documents_erase()).

-- ---------------------------------------------------------------- down
-- Code rollback: the triggers above stay; an older release cannot edit identity or issue without a
-- declaration once enforcement is on. Removing enforcement is NOT a rollback step: it needs its own
-- migration and approval. Dropping the tables is allowed only when P-DOWN returns 0/0/0.
--   P-DOWN: SELECT (SELECT count(*) FROM "BusinessIssuerDeclaration"), (SELECT count(*) FROM "BillingSeriesOpening"),
--                  (SELECT count(*) FROM "IssuerDeclarationEnforcement");
