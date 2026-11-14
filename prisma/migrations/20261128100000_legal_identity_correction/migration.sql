-- Legal identity correction (owner decisions 2026-11-13): the confirmed legal identity (20261128090000) is never
-- edited directly. The business submits a CORRECTION REQUEST (with supporting documents); only an authorized Dubiz
-- admin holding the DEDICATED legal-identity-correction permission may view it, ask for more information, approve or
-- reject it; an approved request is applied atomically and the whole lifecycle stays on record.
--
--   LegalIdentityApprover               the dedicated permission, database side: one row per approved admin user.
--                                       No application role can read or write it; rows are added only by the table
--                                       owner (a reviewed manual step — an owner decision, never done here).
--   LegalIdentityCorrectionRequest      one row per request: who asked, the identity as it was (snapshot), the
--                                       identity asked for, the reason, how the requester was re-verified, an
--                                       optional "more information" request, the decision with a public note (shown
--                                       to the business) and an internal note (admin only). Rows are never deleted or
--                                       rewritten; only the status moves forward, only through the functions below.
--                                       The runtime may read every column EXCEPT internalNote and decidedByUserId.
--   LegalIdentityCorrectionAttachment   supporting documents (PDF / JPEG / PNG, at most 10 MB, at most 5 per request)
--                                       stored under biz/{businessId}/legal-identity/; this table holds the metadata.
--   legal_identity_correction_request   the business submits (tenant runtime): only a CONFIRMED identity; a fresh
--                                       re-verification; at most one open request per business; a typo correction
--                                       keeps the business kind, a kind change keeps the number, and moving between
--                                       an individual (עוסק) and a company is a different legal entity — refused.
--   legal_identity_correction_cancel    the requester withdraws an open request.
--   legal_identity_correction_attach    the requester records a stored document on an open request.
--   legal_identity_correction_request_info  an approver returns an open request for more information (still open).
--   legal_identity_correction_decide    an approver: a LegalIdentityApprover row, role PLATFORM_ADMIN, not the
--                                       requester, not a user of the business, running inside the request's tenant
--                                       transaction. Both notes are required. Approve applies the requested values IF
--                                       the profile still holds the snapshot (else STALE, nothing changes).
--   legal_identity_correction_erase     account deletion: anonymises the requests and attachments of a business being
--                                       deleted (personal columns and notes become NULL; the stored files are deleted
--                                       by the application purge under biz/{id}/legal-identity/).
--
-- Issued documents are never touched: they carry their own frozen issuer snapshot. Applying a correction runs as the
-- table owner, so it passes BusinessProfile_legal_identity_lock (20261128090000) and the issuer-declaration lock
-- (#1091) alike; the issuer declaration must then be superseded before the next issuance (contract with #1117).
-- Codes DZC01..DZC09. Messages never carry a value. Sorts after 20261128090000_signup_legal_identity.

SET lock_timeout = '3s';

-- ---------------------------------------------------------------- the dedicated permission (database side)
CREATE TABLE "LegalIdentityApprover" (
  "userId"    INTEGER PRIMARY KEY REFERENCES "User"("id") ON DELETE CASCADE,
  "grantedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "note"      TEXT NULL CHECK ("note" IS NULL OR length("note") <= 500)
);
ALTER TABLE "LegalIdentityApprover" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LegalIdentityApprover" FORCE ROW LEVEL SECURITY;   -- no policy: only the (BYPASSRLS) owner sees rows

-- ---------------------------------------------------------------- requests
CREATE TABLE "LegalIdentityCorrectionRequest" (
  "id"                    SERIAL PRIMARY KEY,
  "businessId"            INTEGER NOT NULL REFERENCES "Business"("id") ON DELETE CASCADE,
  "requestedByUserId"     INTEGER NOT NULL,
  "kind"                  TEXT NOT NULL CHECK ("kind" IN ('TYPO_CORRECTION', 'BUSINESS_KIND_CHANGE')),
  "currentBusinessKind"   TEXT NOT NULL,
  -- The personal columns are NULL once anonymised (the erasure contract: cleared = NULL, never a placeholder).
  "currentLegalName"      TEXT NULL CHECK ("anonymisedAt" IS NOT NULL OR "currentLegalName" IS NOT NULL),
  "currentTaxId"          TEXT NULL CHECK ("anonymisedAt" IS NOT NULL OR "currentTaxId" IS NOT NULL),
  "requestedBusinessKind" TEXT NOT NULL CHECK ("requestedBusinessKind" IN ('EXEMPT_DEALER', 'AUTHORIZED_DEALER', 'LTD_COMPANY')),
  "requestedLegalName"    TEXT NULL CHECK ("anonymisedAt" IS NOT NULL OR ("requestedLegalName" IS NOT NULL AND length(btrim("requestedLegalName")) BETWEEN 2 AND 120)),
  "requestedTaxId"        TEXT NULL CHECK ("anonymisedAt" IS NOT NULL OR ("requestedTaxId" IS NOT NULL AND "requestedTaxId" ~ '^[0-9]{9}$')),
  "reason"                TEXT NULL CHECK ("anonymisedAt" IS NOT NULL OR ("reason" IS NOT NULL AND length(btrim("reason")) BETWEEN 10 AND 1000)),
  "sameLegalEntity"       BOOLEAN NOT NULL CHECK ("sameLegalEntity"),
  "verificationMethod"    TEXT NOT NULL CHECK ("verificationMethod" IN ('PASSWORD', 'RECENT_SIGN_IN')),
  "verifiedAt"            TIMESTAMPTZ NOT NULL,
  "status"                TEXT NOT NULL DEFAULT 'PENDING'
                            CHECK ("status" IN ('PENDING', 'APPLIED', 'REJECTED', 'CANCELLED', 'STALE')),
  "infoRequestedAt"       TIMESTAMPTZ NULL,
  "infoRequestNote"       TEXT NULL CHECK ("infoRequestNote" IS NULL OR length("infoRequestNote") <= 1000),
  "decidedByUserId"       INTEGER NULL,
  "decidedAt"             TIMESTAMPTZ NULL,
  "publicNote"            TEXT NULL CHECK ("publicNote" IS NULL OR length("publicNote") <= 1000),
  "internalNote"          TEXT NULL CHECK ("internalNote" IS NULL OR length("internalNote") <= 2000),
  "anonymisedAt"          TIMESTAMPTZ NULL,
  "createdAt"             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "LegalIdentityCorrection_changes_something" CHECK (
    "requestedBusinessKind" <> "currentBusinessKind" OR "requestedLegalName" <> "currentLegalName"
    OR "requestedTaxId" <> "currentTaxId" OR "anonymisedAt" IS NOT NULL),
  CONSTRAINT "LegalIdentityCorrection_kind_rule" CHECK ("anonymisedAt" IS NOT NULL OR (
    ("kind" = 'TYPO_CORRECTION' AND "requestedBusinessKind" = "currentBusinessKind")
    OR ("kind" = 'BUSINESS_KIND_CHANGE' AND "requestedBusinessKind" <> "currentBusinessKind"
        AND "requestedTaxId" = "currentTaxId"))),
  CONSTRAINT "LegalIdentityCorrection_same_entity_form" CHECK ("anonymisedAt" IS NOT NULL OR
    (("currentBusinessKind" = 'LTD_COMPANY') = ("requestedBusinessKind" = 'LTD_COMPANY'))),
  CONSTRAINT "LegalIdentityCorrection_four_eyes" CHECK ("decidedByUserId" IS NULL OR "decidedByUserId" <> "requestedByUserId"),
  CONSTRAINT "LegalIdentityCorrection_decided_shape" CHECK (("status" = 'PENDING') = ("decidedAt" IS NULL)),
  CONSTRAINT "LegalIdentityCorrection_info_shape" CHECK (("infoRequestedAt" IS NULL) = ("infoRequestNote" IS NULL) OR "anonymisedAt" IS NOT NULL)
);
CREATE UNIQUE INDEX "LegalIdentityCorrection_one_open_per_business"
  ON "LegalIdentityCorrectionRequest" ("businessId") WHERE "status" = 'PENDING';
CREATE INDEX "LegalIdentityCorrection_business_created" ON "LegalIdentityCorrectionRequest" ("businessId", "createdAt");
CREATE INDEX "LegalIdentityCorrection_status_created" ON "LegalIdentityCorrectionRequest" ("status", "createdAt");

ALTER TABLE "LegalIdentityCorrectionRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LegalIdentityCorrectionRequest" FORCE ROW LEVEL SECURITY;
CREATE POLICY lic_tenant_read ON "LegalIdentityCorrectionRequest" FOR SELECT TO app_runtime
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ---------------------------------------------------------------- attachments (metadata; files live in storage)
CREATE TABLE "LegalIdentityCorrectionAttachment" (
  "id"               SERIAL PRIMARY KEY,
  "requestId"        INTEGER NOT NULL REFERENCES "LegalIdentityCorrectionRequest"("id") ON DELETE CASCADE,
  "businessId"       INTEGER NOT NULL REFERENCES "Business"("id") ON DELETE CASCADE,
  "storageKey"       TEXT NULL UNIQUE CHECK ("anonymisedAt" IS NOT NULL OR (
                       "storageKey" IS NOT NULL
                       AND left("storageKey", length('biz/' || "businessId" || '/legal-identity/')) = 'biz/' || "businessId" || '/legal-identity/'
                       AND length("storageKey") <= 300 AND "storageKey" !~ '(\.\.|\\|//)')),
  "mimeType"         TEXT NOT NULL CHECK ("mimeType" IN ('application/pdf', 'image/jpeg', 'image/png')),
  "sizeBytes"        INTEGER NOT NULL CHECK ("sizeBytes" BETWEEN 1 AND 10485760),
  "sha256"           CHAR(64) NULL CHECK ("anonymisedAt" IS NOT NULL OR ("sha256" IS NOT NULL AND "sha256" ~ '^[0-9a-f]{64}$')),
  "uploadedByUserId" INTEGER NOT NULL,
  "createdAt"        TIMESTAMPTZ NOT NULL DEFAULT now(),
  "anonymisedAt"     TIMESTAMPTZ NULL
);
CREATE INDEX "LegalIdentityCorrectionAttachment_request" ON "LegalIdentityCorrectionAttachment" ("requestId");
CREATE INDEX "LegalIdentityCorrectionAttachment_business" ON "LegalIdentityCorrectionAttachment" ("businessId");
ALTER TABLE "LegalIdentityCorrectionAttachment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LegalIdentityCorrectionAttachment" FORCE ROW LEVEL SECURITY;
CREATE POLICY lica_tenant_read ON "LegalIdentityCorrectionAttachment" FOR SELECT TO app_runtime
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- Rows move only through the definer functions (the owner): any other write is refused, on both tables.
CREATE OR REPLACE FUNCTION public.legal_identity_correction_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'DZC07', MESSAGE = 'LEGAL_IDENTITY_CORRECTION_IS_APPEND_ONLY';
END
$fn$;
REVOKE ALL ON FUNCTION public.legal_identity_correction_guard() FROM PUBLIC;
CREATE TRIGGER "LegalIdentityCorrection_guard" BEFORE INSERT OR UPDATE OR DELETE ON "LegalIdentityCorrectionRequest"
  FOR EACH ROW EXECUTE FUNCTION public.legal_identity_correction_guard();
CREATE TRIGGER "LegalIdentityCorrection_no_truncate" BEFORE TRUNCATE ON "LegalIdentityCorrectionRequest"
  FOR EACH STATEMENT EXECUTE FUNCTION public.legal_identity_correction_guard();
CREATE TRIGGER "LegalIdentityCorrectionAttachment_guard" BEFORE INSERT OR UPDATE OR DELETE ON "LegalIdentityCorrectionAttachment"
  FOR EACH ROW EXECUTE FUNCTION public.legal_identity_correction_guard();
CREATE TRIGGER "LegalIdentityCorrectionAttachment_no_truncate" BEFORE TRUNCATE ON "LegalIdentityCorrectionAttachment"
  FOR EACH STATEMENT EXECUTE FUNCTION public.legal_identity_correction_guard();

-- The approver rule shared by request_info and decide (definer-internal; granted to nobody).
CREATE OR REPLACE FUNCTION public.legal_identity_correction_is_approver(p_approver_user_id integer, p_request_id integer)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public."LegalIdentityCorrectionRequest" r
      JOIN public."User" u ON u."id" = p_approver_user_id
      JOIN public."LegalIdentityApprover" a ON a."userId" = u."id"
     WHERE r."id" = p_request_id
       AND u."role" = 'PLATFORM_ADMIN'
       AND u."id" <> r."requestedByUserId"
       AND u."businessId" <> r."businessId"
       -- inside the request's own tenant transaction, never another tenant's
       AND r."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
$fn$;
REVOKE ALL ON FUNCTION public.legal_identity_correction_is_approver(integer, integer) FROM PUBLIC;

-- ---------------------------------------------------------------- submit (tenant runtime)
CREATE OR REPLACE FUNCTION public.legal_identity_correction_request(
  p_user_id integer, p_kind text, p_requested_kind text, p_requested_legal_name text, p_requested_tax_id text,
  p_reason text, p_same_legal_entity boolean, p_verification_method text, p_verified_at timestamptz)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_business integer := NULLIF(current_setting('app.current_business_id', true), '')::integer;
  p public."BusinessProfile";
  v_id integer;
BEGIN
  IF v_business IS NULL OR p_user_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM public."User" u WHERE u."id" = p_user_id AND u."businessId" = v_business)
     OR public.legal_identity_business_is_being_deleted(v_business) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZC01', MESSAGE = 'LEGAL_IDENTITY_CORRECTION_NOT_ALLOWED';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('legal_identity:' || v_business, 0));
  SELECT * INTO p FROM public."BusinessProfile" WHERE "businessId" = v_business FOR UPDATE;
  IF p."id" IS NULL OR p."legalIdentityConfirmedAt" IS NULL THEN
    -- Not confirmed: there is nothing locked to correct; the business edits its details directly.
    RAISE EXCEPTION USING ERRCODE = 'DZC01', MESSAGE = 'LEGAL_IDENTITY_NOT_CONFIRMED';
  END IF;
  IF p_verification_method IS NULL OR p_verification_method NOT IN ('PASSWORD', 'RECENT_SIGN_IN')
     OR p_verified_at IS NULL OR p_verified_at > now() + interval '1 minute' OR p_verified_at < now() - interval '10 minutes' THEN
    RAISE EXCEPTION USING ERRCODE = 'DZC02', MESSAGE = 'LEGAL_IDENTITY_CORRECTION_VERIFICATION_STALE';
  END IF;
  IF p_same_legal_entity IS DISTINCT FROM true
     OR (p."billingBusinessKind" = 'LTD_COMPANY') <> (p_requested_kind = 'LTD_COMPANY') THEN
    RAISE EXCEPTION USING ERRCODE = 'DZC03', MESSAGE = 'LEGAL_IDENTITY_CORRECTION_DIFFERENT_ENTITY';
  END IF;
  IF p_requested_kind IS NULL OR p_requested_kind NOT IN ('EXEMPT_DEALER', 'AUTHORIZED_DEALER', 'LTD_COMPANY') THEN
    RAISE EXCEPTION USING ERRCODE = 'DZC04', MESSAGE = 'LEGAL_IDENTITY_CORRECTION_INVALID', DETAIL = 'kind';
  END IF;
  IF p_requested_legal_name IS NULL OR p_requested_legal_name <> btrim(p_requested_legal_name)
     OR length(p_requested_legal_name) NOT BETWEEN 2 AND 120 THEN
    RAISE EXCEPTION USING ERRCODE = 'DZC04', MESSAGE = 'LEGAL_IDENTITY_CORRECTION_INVALID', DETAIL = 'legalName';
  END IF;
  IF p_requested_tax_id IS NULL OR NOT public.legal_identity_tax_id_ok(p_requested_tax_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZC04', MESSAGE = 'LEGAL_IDENTITY_CORRECTION_INVALID', DETAIL = 'taxId';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 10 AND 1000 THEN
    RAISE EXCEPTION USING ERRCODE = 'DZC04', MESSAGE = 'LEGAL_IDENTITY_CORRECTION_INVALID', DETAIL = 'reason';
  END IF;
  IF p_requested_kind = p."billingBusinessKind" AND p_requested_legal_name = p."billingLegalName"
     AND p_requested_tax_id = p."billingTaxId" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZC04', MESSAGE = 'LEGAL_IDENTITY_CORRECTION_INVALID', DETAIL = 'noChange';
  END IF;
  IF NOT ((p_kind = 'TYPO_CORRECTION' AND p_requested_kind = p."billingBusinessKind")
       OR (p_kind = 'BUSINESS_KIND_CHANGE' AND p_requested_kind <> p."billingBusinessKind"
           AND p_requested_tax_id = p."billingTaxId")) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZC05', MESSAGE = 'LEGAL_IDENTITY_CORRECTION_KIND_RULE';
  END IF;
  IF EXISTS (SELECT 1 FROM public."LegalIdentityCorrectionRequest" r WHERE r."businessId" = v_business AND r."status" = 'PENDING') THEN
    RAISE EXCEPTION USING ERRCODE = 'DZC06', MESSAGE = 'LEGAL_IDENTITY_CORRECTION_ALREADY_OPEN';
  END IF;
  INSERT INTO public."LegalIdentityCorrectionRequest" (
    "businessId", "requestedByUserId", "kind",
    "currentBusinessKind", "currentLegalName", "currentTaxId",
    "requestedBusinessKind", "requestedLegalName", "requestedTaxId",
    "reason", "sameLegalEntity", "verificationMethod", "verifiedAt")
  VALUES (v_business, p_user_id, p_kind,
          p."billingBusinessKind", p."billingLegalName", p."billingTaxId",
          p_requested_kind, p_requested_legal_name, p_requested_tax_id,
          btrim(p_reason), true, p_verification_method, p_verified_at)
  RETURNING "id" INTO v_id;
  RETURN v_id;
END
$fn$;
REVOKE ALL ON FUNCTION public.legal_identity_correction_request(integer, text, text, text, text, text, boolean, text, timestamptz) FROM PUBLIC;

-- ---------------------------------------------------------------- withdraw (tenant runtime, the requester)
-- Answers: CANCELLED | NOT_FOUND | NOT_PENDING.
CREATE OR REPLACE FUNCTION public.legal_identity_correction_cancel(p_user_id integer, p_request_id integer)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_business integer := NULLIF(current_setting('app.current_business_id', true), '')::integer;
  r public."LegalIdentityCorrectionRequest";
BEGIN
  IF v_business IS NULL THEN RETURN 'NOT_FOUND'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('legal_identity:' || v_business, 0));
  SELECT * INTO r FROM public."LegalIdentityCorrectionRequest"
   WHERE "id" = p_request_id AND "businessId" = v_business AND "requestedByUserId" = p_user_id FOR UPDATE;
  IF r."id" IS NULL THEN RETURN 'NOT_FOUND'; END IF;
  IF r."status" <> 'PENDING' THEN RETURN 'NOT_PENDING'; END IF;
  UPDATE public."LegalIdentityCorrectionRequest" SET "status" = 'CANCELLED', "decidedAt" = now() WHERE "id" = r."id";
  RETURN 'CANCELLED';
END
$fn$;
REVOKE ALL ON FUNCTION public.legal_identity_correction_cancel(integer, integer) FROM PUBLIC;

-- ---------------------------------------------------------------- attach a stored document (tenant runtime, the requester)
-- Returns the attachment id. Refusals: DZC01 not allowed, DZC09 not open, DZC08 limit (5), DZC04 invalid (DETAIL field).
CREATE OR REPLACE FUNCTION public.legal_identity_correction_attach(
  p_user_id integer, p_request_id integer, p_storage_key text, p_mime text, p_size integer, p_sha256 text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_business integer := NULLIF(current_setting('app.current_business_id', true), '')::integer;
  r public."LegalIdentityCorrectionRequest";
  v_prefix text;
  v_id integer;
BEGIN
  IF v_business IS NULL OR public.legal_identity_business_is_being_deleted(v_business) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZC01', MESSAGE = 'LEGAL_IDENTITY_CORRECTION_NOT_ALLOWED';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('legal_identity:' || v_business, 0));
  SELECT * INTO r FROM public."LegalIdentityCorrectionRequest"
   WHERE "id" = p_request_id AND "businessId" = v_business AND "requestedByUserId" = p_user_id FOR UPDATE;
  IF r."id" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'DZC01', MESSAGE = 'LEGAL_IDENTITY_CORRECTION_NOT_ALLOWED';
  END IF;
  IF r."status" <> 'PENDING' THEN
    RAISE EXCEPTION USING ERRCODE = 'DZC09', MESSAGE = 'LEGAL_IDENTITY_CORRECTION_NOT_PENDING';
  END IF;
  v_prefix := 'biz/' || v_business || '/legal-identity/';
  IF p_storage_key IS NULL OR left(p_storage_key, length(v_prefix)) <> v_prefix OR length(p_storage_key) > 300
     OR p_storage_key ~ '(\.\.|\\|//)' OR length(p_storage_key) = length(v_prefix) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZC04', MESSAGE = 'LEGAL_IDENTITY_CORRECTION_INVALID', DETAIL = 'storageKey';
  END IF;
  IF p_mime IS NULL OR p_mime NOT IN ('application/pdf', 'image/jpeg', 'image/png') THEN
    RAISE EXCEPTION USING ERRCODE = 'DZC04', MESSAGE = 'LEGAL_IDENTITY_CORRECTION_INVALID', DETAIL = 'mimeType';
  END IF;
  IF p_size IS NULL OR p_size NOT BETWEEN 1 AND 10485760 THEN
    RAISE EXCEPTION USING ERRCODE = 'DZC04', MESSAGE = 'LEGAL_IDENTITY_CORRECTION_INVALID', DETAIL = 'sizeBytes';
  END IF;
  IF p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE = 'DZC04', MESSAGE = 'LEGAL_IDENTITY_CORRECTION_INVALID', DETAIL = 'sha256';
  END IF;
  IF (SELECT count(*) FROM public."LegalIdentityCorrectionAttachment" a WHERE a."requestId" = r."id") >= 5 THEN
    RAISE EXCEPTION USING ERRCODE = 'DZC08', MESSAGE = 'LEGAL_IDENTITY_CORRECTION_ATTACHMENT_LIMIT';
  END IF;
  INSERT INTO public."LegalIdentityCorrectionAttachment"
    ("requestId", "businessId", "storageKey", "mimeType", "sizeBytes", "sha256", "uploadedByUserId")
  VALUES (r."id", v_business, p_storage_key, p_mime, p_size, p_sha256, p_user_id)
  RETURNING "id" INTO v_id;
  RETURN v_id;
END
$fn$;
REVOKE ALL ON FUNCTION public.legal_identity_correction_attach(integer, integer, text, text, integer, text) FROM PUBLIC;

-- ---------------------------------------------------------------- ask for more information (approver, tenant tx)
-- Answers: REQUESTED | NOT_PENDING | NOT_FOUND | NOT_ALLOWED | NOTE_REQUIRED. The request stays PENDING.
CREATE OR REPLACE FUNCTION public.legal_identity_correction_request_info(
  p_request_id integer, p_approver_user_id integer, p_note text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE r public."LegalIdentityCorrectionRequest";
BEGIN
  SELECT * INTO r FROM public."LegalIdentityCorrectionRequest" WHERE "id" = p_request_id;
  IF r."id" IS NULL THEN RETURN 'NOT_FOUND'; END IF;
  IF NOT public.legal_identity_correction_is_approver(p_approver_user_id, p_request_id) THEN RETURN 'NOT_ALLOWED'; END IF;
  IF p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 5 AND 1000 THEN RETURN 'NOTE_REQUIRED'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('legal_identity:' || r."businessId", 0));
  SELECT * INTO r FROM public."LegalIdentityCorrectionRequest" WHERE "id" = p_request_id FOR UPDATE;
  IF r."status" <> 'PENDING' THEN RETURN 'NOT_PENDING'; END IF;
  UPDATE public."LegalIdentityCorrectionRequest"
     SET "infoRequestedAt" = now(), "infoRequestNote" = btrim(p_note)
   WHERE "id" = r."id";
  RETURN 'REQUESTED';
END
$fn$;
REVOKE ALL ON FUNCTION public.legal_identity_correction_request_info(integer, integer, text) FROM PUBLIC;

-- ---------------------------------------------------------------- decide (approver, tenant tx)
-- Answers: APPLIED | REJECTED | STALE | NOT_PENDING | NOT_FOUND | NOT_ALLOWED | NOTE_REQUIRED | DECLARATION_ACTIVE.
CREATE OR REPLACE FUNCTION public.legal_identity_correction_decide(
  p_request_id integer, p_approver_user_id integer, p_approve boolean, p_public_note text, p_internal_note text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  r public."LegalIdentityCorrectionRequest";
  p public."BusinessProfile";
  v_declared boolean;
BEGIN
  SELECT * INTO r FROM public."LegalIdentityCorrectionRequest" WHERE "id" = p_request_id;
  IF r."id" IS NULL THEN RETURN 'NOT_FOUND'; END IF;
  IF p_approve IS NULL OR NOT public.legal_identity_correction_is_approver(p_approver_user_id, p_request_id) THEN
    RETURN 'NOT_ALLOWED';
  END IF;
  IF p_public_note IS NULL OR length(btrim(p_public_note)) NOT BETWEEN 5 AND 1000
     OR p_internal_note IS NULL OR length(btrim(p_internal_note)) NOT BETWEEN 5 AND 2000 THEN
    RETURN 'NOTE_REQUIRED';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('legal_identity:' || r."businessId", 0));
  SELECT * INTO r FROM public."LegalIdentityCorrectionRequest" WHERE "id" = p_request_id FOR UPDATE;
  IF r."status" <> 'PENDING' THEN RETURN 'NOT_PENDING'; END IF;
  IF NOT p_approve THEN
    UPDATE public."LegalIdentityCorrectionRequest"
       SET "status" = 'REJECTED', "decidedByUserId" = p_approver_user_id, "decidedAt" = now(),
           "publicNote" = btrim(p_public_note), "internalNote" = btrim(p_internal_note)
     WHERE "id" = r."id";
    RETURN 'REJECTED';
  END IF;
  -- Same legal entity, re-checked at decision time (the row CHECK holds it too).
  IF (r."currentBusinessKind" = 'LTD_COMPANY') <> (r."requestedBusinessKind" = 'LTD_COMPANY') THEN RETURN 'NOT_ALLOWED'; END IF;
  SELECT * INTO p FROM public."BusinessProfile" WHERE "businessId" = r."businessId" FOR UPDATE;
  IF p."id" IS NULL OR p."legalIdentityConfirmedAt" IS NULL
     OR public.legal_identity_business_is_being_deleted(r."businessId")
     OR p."billingBusinessKind" IS DISTINCT FROM r."currentBusinessKind"
     OR p."billingLegalName" IS DISTINCT FROM r."currentLegalName"
     OR p."billingTaxId" IS DISTINCT FROM r."currentTaxId" THEN
    -- The identity moved since the request was made (or the business is leaving): apply nothing.
    UPDATE public."LegalIdentityCorrectionRequest"
       SET "status" = 'STALE', "decidedByUserId" = p_approver_user_id, "decidedAt" = now(),
           "publicNote" = btrim(p_public_note), "internalNote" = btrim(p_internal_note)
     WHERE "id" = r."id";
    RETURN 'STALE';
  END IF;
  -- A live issuer declaration (20261126100000_issuer_declaration): the profile's identity is a projection of it and
  -- its lock refuses any other value. This function runs as the table owner and would pass that lock, so it refuses
  -- here instead: nothing is applied, the request stays PENDING. No silent divergence between profile and declaration.
  -- Read dynamically, so this function does not depend on that table existing.
  IF to_regclass('public."BusinessIssuerDeclaration"') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public."BusinessIssuerDeclaration" WHERE "businessId" = $1 AND "anonymisedAt" IS NULL)'
      INTO v_declared USING r."businessId";
    IF v_declared THEN RETURN 'DECLARATION_ACTIVE'; END IF;
  END IF;
  -- As the table owner: passes the legal identity lock (DZL04). Issued documents untouched.
  UPDATE public."BusinessProfile"
     SET "billingBusinessKind" = r."requestedBusinessKind", "billingLegalName" = r."requestedLegalName",
         "billingTaxId" = r."requestedTaxId", "updatedAt" = now()
   WHERE "id" = p."id";
  UPDATE public."LegalIdentityCorrectionRequest"
     SET "status" = 'APPLIED', "decidedByUserId" = p_approver_user_id, "decidedAt" = now(),
         "publicNote" = btrim(p_public_note), "internalNote" = btrim(p_internal_note)
   WHERE "id" = r."id";
  RETURN 'APPLIED';
END
$fn$;
REVOKE ALL ON FUNCTION public.legal_identity_correction_decide(integer, integer, boolean, text, text) FROM PUBLIC;

-- ---------------------------------------------------------------- erase (account deletion, tenant runtime)
-- Anonymises (never deletes) the requests and attachments of the tenant business, only while it is being deleted:
-- names, numbers, the reason, every note and the stored-file key and hash become NULL; status, decision times stay.
-- The files themselves are deleted by the application purge (prefix biz/{id}/legal-identity/). Returns the count.
CREATE OR REPLACE FUNCTION public.legal_identity_correction_erase()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE v_business integer := NULLIF(current_setting('app.current_business_id', true), '')::integer; n integer;
BEGIN
  IF v_business IS NULL THEN RAISE EXCEPTION USING ERRCODE = 'DZC01', MESSAGE = 'LEGAL_IDENTITY_CORRECTION_ERASE_NEEDS_TENANT'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."Business" b WHERE b."id" = v_business
                   AND (b."deletionRequestedAt" IS NOT NULL OR b."deletedAt" IS NOT NULL)) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZC01', MESSAGE = 'LEGAL_IDENTITY_CORRECTION_ERASE_NOT_DELETING';
  END IF;
  UPDATE public."LegalIdentityCorrectionAttachment"
     SET "storageKey" = NULL, "sha256" = NULL, "anonymisedAt" = now()
   WHERE "businessId" = v_business AND "anonymisedAt" IS NULL;
  UPDATE public."LegalIdentityCorrectionRequest"
     SET "currentLegalName" = NULL, "currentTaxId" = NULL, "requestedLegalName" = NULL,
         "requestedTaxId" = NULL, "reason" = NULL, "infoRequestNote" = NULL,
         "publicNote" = NULL, "internalNote" = NULL,
         "status" = CASE WHEN "status" = 'PENDING' THEN 'CANCELLED' ELSE "status" END,
         "decidedAt" = COALESCE("decidedAt", now()), "anonymisedAt" = now()
   WHERE "businessId" = v_business AND "anonymisedAt" IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$fn$;
REVOKE ALL ON FUNCTION public.legal_identity_correction_erase() FROM PUBLIC;

-- ---------------------------------------------------------------- privileges
-- The owner's DEFAULT PRIVILEGES may hand new objects to the application roles: take everything back, then grant
-- exactly what each plane needs.
REVOKE ALL ON "LegalIdentityApprover", "LegalIdentityCorrectionRequest", "LegalIdentityCorrectionAttachment" FROM PUBLIC;
REVOKE ALL ON "LegalIdentityApprover", "LegalIdentityCorrectionRequest", "LegalIdentityCorrectionAttachment" FROM app_runtime, app_auth;
-- The business reads its own requests — every column except the internal note and the approver's identity.
GRANT SELECT ("id", "businessId", "requestedByUserId", "kind", "currentBusinessKind", "currentLegalName", "currentTaxId",
              "requestedBusinessKind", "requestedLegalName", "requestedTaxId", "reason", "sameLegalEntity",
              "verificationMethod", "verifiedAt", "status", "infoRequestedAt", "infoRequestNote", "decidedAt",
              "publicNote", "anonymisedAt", "createdAt")
  ON "LegalIdentityCorrectionRequest" TO app_runtime;
GRANT SELECT ON "LegalIdentityCorrectionAttachment" TO app_runtime;
REVOKE ALL ON FUNCTION public.legal_identity_correction_guard() FROM app_runtime, app_auth;
REVOKE ALL ON FUNCTION public.legal_identity_correction_is_approver(integer, integer) FROM app_runtime, app_auth;
REVOKE ALL ON FUNCTION public.legal_identity_correction_request(integer, text, text, text, text, text, boolean, text, timestamptz) FROM app_runtime, app_auth;
REVOKE ALL ON FUNCTION public.legal_identity_correction_cancel(integer, integer) FROM app_runtime, app_auth;
REVOKE ALL ON FUNCTION public.legal_identity_correction_attach(integer, integer, text, text, integer, text) FROM app_runtime, app_auth;
REVOKE ALL ON FUNCTION public.legal_identity_correction_request_info(integer, integer, text) FROM app_runtime, app_auth;
REVOKE ALL ON FUNCTION public.legal_identity_correction_decide(integer, integer, boolean, text, text) FROM app_runtime, app_auth;
REVOKE ALL ON FUNCTION public.legal_identity_correction_erase() FROM app_runtime, app_auth;
GRANT EXECUTE ON FUNCTION public.legal_identity_correction_request(integer, text, text, text, text, text, boolean, text, timestamptz) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.legal_identity_correction_cancel(integer, integer) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.legal_identity_correction_attach(integer, integer, text, text, integer, text) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.legal_identity_correction_request_info(integer, integer, text) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.legal_identity_correction_decide(integer, integer, boolean, text, text) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.legal_identity_correction_erase() TO app_runtime;
-- request_info and decide are reachable from the runtime, but refuse unless the approver holds a LegalIdentityApprover
-- row (writable only by the table owner), is a PLATFORM_ADMIN outside the business and not the requester, and the
-- call runs inside the request's own tenant transaction. The admin routes add the server-side permission list and a
-- fresh step-up; the feature stays OFF until the owner enables it.

-- The platform-admin read plane (app_admin), exactly as 20261107092000: read-only, every row. Role-guarded.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin') THEN
    EXECUTE 'CREATE POLICY p7adm_read ON "LegalIdentityCorrectionRequest" FOR SELECT TO app_admin USING (true)';
    EXECUTE 'CREATE POLICY p7adm_read ON "LegalIdentityCorrectionAttachment" FOR SELECT TO app_admin USING (true)';
    EXECUTE 'GRANT SELECT ON "LegalIdentityCorrectionRequest", "LegalIdentityCorrectionAttachment" TO app_admin';
  END IF;
END
$do$;
