-- ============================================================================
-- DRAFT FOR REVIEW — NOT A MIGRATION — DO NOT APPLY
--
-- issuer-declaration-and-series-opening-v1.DRAFT.sql
--
-- What an approved migration would contain for:
--   A. BusinessIssuerDeclaration — the business's declared issuer identity (append-only history)
--   C. BillingSeriesOpening      — the declared opening number of a document series
--   (B, the identity lock, is enforced in application code and by guard D below.)
--
-- Design and decisions: docs/issuer-declaration-data-package-v1.md. This file lives outside
-- prisma/migrations on purpose: no release tool reads it. The real migration is written only
-- after the owner approves the exact shape, together with schema.prisma, the erasure registry
-- (scripts/ci/erasure/*) and the runtime grants evidence.
--
-- Conventions copied from 20261114090000_business_documents_records:
--   FORCE RLS keyed on app.current_business_id · runtime gets SELECT + INSERT only ·
--   append-only trigger (UPDATE / DELETE refused, error DZD30) · TRUNCATE refused ·
--   SECURITY DEFINER functions with search_path = pg_catalog, public, pg_temp, EXECUTE revoked from PUBLIC.
-- ============================================================================

-- ---------------------------------------------------------------- enums
CREATE TYPE "IssuerTrack" AS ENUM (
  'EXEMPT_DEALER',                -- עוסק פטור (יחיד)
  'AUTHORIZED_DEALER_INDIVIDUAL', -- עוסק מורשה — עצמאי
  'COMPANY_AUTHORIZED_DEALER'     -- חברה בע"מ, רשומה כעוסק מורשה (תקנות רישום 13(7))
);
CREATE TYPE "IssuerLegalForm" AS ENUM ('INDIVIDUAL', 'COMPANY');
CREATE TYPE "IssuerVatStatus" AS ENUM ('EXEMPT', 'AUTHORIZED');
CREATE TYPE "IssuerIdType" AS ENUM ('ISRAELI_ID', 'COMPANY_NUMBER');
CREATE TYPE "IssuerDeclarationKind" AS ENUM (
  'INITIAL',                -- first declaration of a new business
  'EXISTING_CONFIRMATION',  -- an existing business confirms (its old values were shown as a draft)
  'CONTACT_UPDATE',         -- address / phone / email / trade name — identity unchanged
  'STATUS_CHANGE',          -- real change of VAT status of the same legal person (e.g. פטור → מורשה)
  'CORRECTION'              -- a typo fixed BEFORE any fiscal document was issued under the declaration
);
CREATE TYPE "IssuerReauthMethod" AS ENUM ('PASSWORD', 'EMAIL_CODE');
CREATE TYPE "SeriesOpeningSource" AS ENUM (
  'NEW_BUSINESS',                  -- never issued this type anywhere: opening = 1
  'CONTINUES_PREVIOUS_TOOL',       -- continues a manual book / other software
  'EXPLICIT_NEW_SERIES'            -- a deliberately new series with a stated first number
);

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
  "legalName"             TEXT NOT NULL CHECK (length(btrim("legalName")) BETWEEN 2 AND 200),
  "tradeName"             TEXT NULL CHECK ("tradeName" IS NULL OR length(btrim("tradeName")) BETWEEN 1 AND 200),
  "idType"                "IssuerIdType" NOT NULL,
  "idNumber"              TEXT NOT NULL CHECK ("idNumber" ~ '^[0-9]{9}$'),      -- check digit verified in code
  "vatRegistrationNumber" TEXT NULL CHECK ("vatRegistrationNumber" IS NULL OR "vatRegistrationNumber" ~ '^[0-9]{9}$'),
  "address"               TEXT NOT NULL CHECK (length(btrim("address")) BETWEEN 3 AND 300),
  "phone"                 TEXT NOT NULL CHECK (length(btrim("phone")) BETWEEN 6 AND 30),
  "email"                 TEXT NOT NULL CHECK (position('@' IN "email") > 1),
  "effectiveFrom"         TIMESTAMPTZ NOT NULL,
  "reason"                TEXT NULL CHECK ("reason" IS NULL OR length("reason") <= 1000),
  "declaredByUserId"      INTEGER NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
  "declarantName"         TEXT NOT NULL CHECK (length(btrim("declarantName")) BETWEEN 2 AND 120),
  "declarantCapacity"     TEXT NOT NULL CHECK (length(btrim("declarantCapacity")) BETWEEN 2 AND 120),
  "statementVersion"      TEXT NOT NULL,               -- e.g. 'issuer-declaration-he-v1'
  "statementSha256"       CHAR(64) NOT NULL,           -- hash of the exact Hebrew text shown
  "reauthMethod"          "IssuerReauthMethod" NOT NULL,
  "reauthAt"              TIMESTAMPTZ NOT NULL,
  "createdAt"             TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- the track fixes legal form and VAT status — never inferred later
  CONSTRAINT "IssuerDeclaration_track_shape" CHECK (
       ("track" = 'EXEMPT_DEALER'                AND "legalForm" = 'INDIVIDUAL' AND "vatStatus" = 'EXEMPT'     AND "idType" = 'ISRAELI_ID')
    OR ("track" = 'AUTHORIZED_DEALER_INDIVIDUAL' AND "legalForm" = 'INDIVIDUAL' AND "vatStatus" = 'AUTHORIZED' AND "idType" = 'ISRAELI_ID')
    OR ("track" = 'COMPANY_AUTHORIZED_DEALER'    AND "legalForm" = 'COMPANY'    AND "vatStatus" = 'AUTHORIZED' AND "idType" = 'COMPANY_NUMBER')
  ),
  -- an authorized dealer carries its VAT registration number; an exempt dealer may leave it empty
  CONSTRAINT "IssuerDeclaration_vat_number" CHECK ("vatStatus" = 'EXEMPT' OR "vatRegistrationNumber" IS NOT NULL),
  CONSTRAINT "IssuerDeclaration_first_has_no_predecessor" CHECK (("version" = 1) = ("supersedesId" IS NULL)),
  CONSTRAINT "IssuerDeclaration_first_kind" CHECK ("version" > 1 OR "kind" IN ('INITIAL', 'EXISTING_CONFIRMATION'))
);
CREATE UNIQUE INDEX "BusinessIssuerDeclaration_businessId_version_key" ON "BusinessIssuerDeclaration" ("businessId", "version");
CREATE UNIQUE INDEX "BusinessIssuerDeclaration_supersedesId_key" ON "BusinessIssuerDeclaration" ("supersedesId") WHERE "supersedesId" IS NOT NULL;
CREATE UNIQUE INDEX "BusinessIssuerDeclaration_businessId_id_key" ON "BusinessIssuerDeclaration" ("businessId", "id");
CREATE INDEX "BusinessIssuerDeclaration_businessId_effectiveFrom_idx" ON "BusinessIssuerDeclaration" ("businessId", "effectiveFrom" DESC);
-- a predecessor is always in the same business
ALTER TABLE "BusinessIssuerDeclaration"
  ADD CONSTRAINT "BusinessIssuerDeclaration_supersedes_same_business"
  FOREIGN KEY ("businessId", "supersedesId") REFERENCES "BusinessIssuerDeclaration" ("businessId", "id");

-- ---------------------------------------------------------------- C. series opening
CREATE TABLE "BillingSeriesOpening" (
  "id"                     SERIAL PRIMARY KEY,
  "businessId"             INTEGER NOT NULL REFERENCES "Business"("id") ON DELETE RESTRICT,
  "documentType"           "BillingDocumentType" NOT NULL CHECK ("documentType"::text IN ('TAX_INVOICE', 'TAX_INVOICE_RECEIPT', 'RECEIPT', 'CREDIT_NOTE')),
  "seriesCode"             TEXT NOT NULL DEFAULT 'MAIN' CHECK ("seriesCode" ~ '^[A-Z][A-Z0-9_]{0,15}$'),
  "openingNumber"          INTEGER NOT NULL CHECK ("openingNumber" BETWEEN 1 AND 999999),
  "source"                 "SeriesOpeningSource" NOT NULL,
  "previousToolName"       TEXT NULL CHECK ("previousToolName" IS NULL OR length("previousToolName") <= 120),
  "lastNumberInPreviousTool" INTEGER NULL CHECK ("lastNumberInPreviousTool" IS NULL OR "lastNumberInPreviousTool" >= 1),
  "declarationId"          INTEGER NOT NULL,
  "declaredByUserId"       INTEGER NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
  "createdAt"              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "SeriesOpening_source_shape" CHECK (
       ("source" = 'NEW_BUSINESS'            AND "openingNumber" = 1 AND "previousToolName" IS NULL AND "lastNumberInPreviousTool" IS NULL)
    OR ("source" = 'CONTINUES_PREVIOUS_TOOL' AND "previousToolName" IS NOT NULL AND "lastNumberInPreviousTool" IS NOT NULL
                                             AND "openingNumber" = "lastNumberInPreviousTool" + 1)
    OR ("source" = 'EXPLICIT_NEW_SERIES'     AND "seriesCode" <> 'MAIN')
  ),
  CONSTRAINT "SeriesOpening_declaration_same_business"
    FOREIGN KEY ("businessId", "declarationId") REFERENCES "BusinessIssuerDeclaration" ("businessId", "id")
);
-- ONE opening per series, ever: it is the series' identity, never replaced after first use (guard E)
CREATE UNIQUE INDEX "BillingSeriesOpening_series_key" ON "BillingSeriesOpening" ("businessId", "documentType", "seriesCode");

-- ---------------------------------------------------------------- RLS
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

-- ---------------------------------------------------------------- grants (runtime: read + append only)
REVOKE ALL ON "BusinessIssuerDeclaration", "BillingSeriesOpening" FROM PUBLIC;
GRANT SELECT, INSERT ON "BusinessIssuerDeclaration", "BillingSeriesOpening" TO app_runtime;
GRANT USAGE, SELECT ON SEQUENCE "BusinessIssuerDeclaration_id_seq", "BillingSeriesOpening_id_seq" TO app_runtime;
-- no UPDATE / DELETE / TRUNCATE grant to app_runtime on either table

-- ---------------------------------------------------------------- guards
CREATE OR REPLACE FUNCTION public.issuer_records_append_only_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  -- the table owner = the SECURITY DEFINER erase function (same rule as business_documents_append_only_guard)
  is_owner boolean := current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID);
BEGIN
  -- Only the account-erasure path may touch rows: an UPDATE by the owner (never a DELETE).
  IF TG_OP = 'UPDATE' AND is_owner THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'DZD30', MESSAGE = format('ISSUER_RECORDS_APPEND_ONLY: %s on %I is refused', TG_OP, TG_TABLE_NAME);
END
$fn$;
REVOKE ALL ON FUNCTION public.issuer_records_append_only_guard() FROM PUBLIC;

CREATE TRIGGER "BusinessIssuerDeclaration_append_only" BEFORE UPDATE OR DELETE ON "BusinessIssuerDeclaration"
  FOR EACH ROW EXECUTE FUNCTION public.issuer_records_append_only_guard();
CREATE TRIGGER "BillingSeriesOpening_append_only" BEFORE UPDATE OR DELETE ON "BillingSeriesOpening"
  FOR EACH ROW EXECUTE FUNCTION public.issuer_records_append_only_guard();

-- D. A new declaration must chain on the CURRENT one (no fork) and may not change who the issuer is.
CREATE OR REPLACE FUNCTION public.issuer_declaration_chain_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  cur public."BusinessIssuerDeclaration";
  issued_under boolean;
BEGIN
  -- serialize declarations of one business
  PERFORM pg_advisory_xact_lock(hashtextextended('issuer_declaration:' || NEW."businessId", 0));
  SELECT * INTO cur FROM public."BusinessIssuerDeclaration"
   WHERE "businessId" = NEW."businessId" ORDER BY "version" DESC LIMIT 1;
  IF cur."id" IS NULL THEN
    IF NEW."version" <> 1 THEN RAISE EXCEPTION USING ERRCODE = 'DZD31', MESSAGE = 'ISSUER_DECLARATION_FIRST_MUST_BE_VERSION_1'; END IF;
    RETURN NEW;
  END IF;
  IF NEW."supersedesId" IS DISTINCT FROM cur."id" OR NEW."version" <> cur."version" + 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD31', MESSAGE = 'ISSUER_DECLARATION_MUST_SUPERSEDE_CURRENT';
  END IF;
  -- the legal person never changes inside a business (a company is a new business, not a new number)
  IF NEW."legalForm" <> cur."legalForm" OR NEW."idType" <> cur."idType" OR NEW."idNumber" <> cur."idNumber" THEN
    IF NEW."kind" <> 'CORRECTION' THEN
      RAISE EXCEPTION USING ERRCODE = 'DZD31', MESSAGE = 'ISSUER_IDENTITY_IS_LOCKED';
    END IF;
  END IF;
  SELECT EXISTS (SELECT 1 FROM public."BillingDocument" d
                  WHERE d."businessId" = NEW."businessId" AND d."status"::text = 'ISSUED'
                    AND d."documentType"::text IN ('TAX_INVOICE','TAX_INVOICE_RECEIPT','RECEIPT','CREDIT_NOTE')
                    AND d."issuedAt" >= cur."effectiveFrom") INTO issued_under;
  -- a CORRECTION is only for a declaration nothing fiscal was issued under
  IF NEW."kind" = 'CORRECTION' AND issued_under THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD31', MESSAGE = 'ISSUER_CORRECTION_AFTER_ISSUANCE_REFUSED';
  END IF;
  -- CONTACT_UPDATE may not touch the track, the names that identify the issuer, or the VAT number
  IF NEW."kind" = 'CONTACT_UPDATE' AND (NEW."track" <> cur."track" OR NEW."legalName" <> cur."legalName"
       OR NEW."vatRegistrationNumber" IS DISTINCT FROM cur."vatRegistrationNumber") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD31', MESSAGE = 'ISSUER_CONTACT_UPDATE_TOUCHES_IDENTITY';
  END IF;
  -- STATUS_CHANGE: same legal person, VAT status changes, never back-dated before the current declaration
  IF NEW."kind" = 'STATUS_CHANGE' AND (NEW."vatStatus" = cur."vatStatus" OR NEW."effectiveFrom" < cur."effectiveFrom") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD31', MESSAGE = 'ISSUER_STATUS_CHANGE_INVALID';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.issuer_declaration_chain_guard() FROM PUBLIC;
CREATE TRIGGER "BusinessIssuerDeclaration_chain" BEFORE INSERT ON "BusinessIssuerDeclaration"
  FOR EACH ROW EXECUTE FUNCTION public.issuer_declaration_chain_guard();

-- E. An opening is accepted only while its series has never been used.
CREATE OR REPLACE FUNCTION public.series_opening_unused_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  -- the same lock the issue path takes before reading the opening (application change, A0)
  PERFORM pg_advisory_xact_lock(hashtextextended('series:' || NEW."businessId" || ':' || NEW."documentType"::text || ':' || NEW."seriesCode", 0));
  IF NEW."seriesCode" = 'MAIN' AND (
       EXISTS (SELECT 1 FROM public."BillingDocumentNumberSequence" s
                WHERE s."businessId" = NEW."businessId" AND s."documentType" = NEW."documentType")
    OR EXISTS (SELECT 1 FROM public."BillingDocument" d
                WHERE d."businessId" = NEW."businessId" AND d."documentType" = NEW."documentType" AND d."documentNumber" IS NOT NULL)
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

-- ---------------------------------------------------------------- erasure (depends on decision R)
-- R-split (recommended): a declaration under which no fiscal document was issued is erasable like
-- BusinessProfile's identity columns; one that documents were issued under is fiscal evidence and is
-- RETAINED_BY_DESIGN (basis LEGAL/FISCAL, הוראות 25(ג)) — the same bucket as BillingDocument. The
-- erase function is added to the account purge transaction only after decision R:
--   public.issuer_declaration_erase()  — SECURITY DEFINER, GRANT EXECUTE TO the purge role only,
--   UPDATE ... SET "legalName"='—', "tradeName"=NULL, "idNumber"='000000000', "address"='—', "phone"='—',
--   "email"='erased@invalid', "declarantName"='—', "declarantCapacity"='—'
--   WHERE "businessId" = current business AND no ISSUED fiscal document has issuedAt >= "effectiveFrom".
-- BillingSeriesOpening holds no personal data: STRUCTURAL / retained with BillingDocumentNumberSequence.
-- (Draft only: the UPDATE above runs inside the definer function as the table owner — the only UPDATE the guard admits.)

-- ---------------------------------------------------------------- down (code rollback, NOT data deletion)
-- Rolling back the application leaves both tables in place, unused. Dropping them is allowed ONLY when
-- they hold no row (preflight P-DOWN below returns 0/0); a confirmed declaration or a used opening is
-- fiscal evidence and is never dropped to undo a release.
--   P-DOWN: SELECT (SELECT count(*) FROM "BusinessIssuerDeclaration") AS declarations,
--                  (SELECT count(*) FROM "BillingSeriesOpening")     AS openings;
