-- Legal identity correction (owner decision 2026-11-13): the confirmed legal identity (20261128090000) is never
-- edited directly. The business submits a CORRECTION REQUEST; an authorized party that is not the requester decides
-- it; an approved request is applied atomically and the whole lifecycle stays on record. Draft — and inert until the
-- owner approves WHO decides and the verification policy: the decision function is granted to NO application role.
--
--   LegalIdentityCorrectionRequest      one row per request: who asked, the identity as it was (snapshot), the
--                                       identity asked for, the reason, how the requester was re-verified, the
--                                       decision and its author. Rows are never deleted or rewritten; only the status
--                                       moves forward, and only through the functions below. It IS the history.
--   legal_identity_correction_request   the business submits (tenant runtime): only a CONFIRMED identity; a fresh
--                                       re-verification; at most one open request per business; a typo correction
--                                       keeps the business kind, a kind change keeps the number, and moving between
--                                       an individual (עוסק) and a company is a different legal entity — refused
--                                       (a new business, never an edit of the number).
--   legal_identity_correction_cancel    the requester withdraws an open request.
--   legal_identity_correction_decide    the approver: a PLATFORM_ADMIN who is neither the requester nor a user of the
--                                       business. Approve applies the requested values IF the profile still holds the
--                                       snapshot (else STALE, nothing changes); reject needs a note. GRANTED TO NOBODY
--                                       here: the approver plane and verification policy are an owner decision.
--   legal_identity_correction_erase     account deletion: anonymises the requests of a business being deleted (the
--                                       five personal columns and the note become NULL).
--
-- Issued documents are never touched: they carry their own frozen issuer snapshot. Applying a correction runs as the
-- table owner, so it passes BusinessProfile_legal_identity_lock (20261128090000) and the issuer-declaration lock
-- (#1091) alike; the issuer declaration must then be superseded before the next issuance (contract with #1117).
-- Codes DZC01..DZC07. Messages never carry a value. Sorts after 20261128090000_signup_legal_identity.

SET lock_timeout = '3s';

CREATE TABLE "LegalIdentityCorrectionRequest" (
  "id"                    SERIAL PRIMARY KEY,
  "businessId"            INTEGER NOT NULL REFERENCES "Business"("id") ON DELETE CASCADE,
  "requestedByUserId"     INTEGER NOT NULL,
  "kind"                  TEXT NOT NULL CHECK ("kind" IN ('TYPO_CORRECTION', 'BUSINESS_KIND_CHANGE')),
  "currentBusinessKind"   TEXT NOT NULL,
  -- The five personal columns are NULL once anonymised (the erasure contract: cleared = NULL, never a placeholder).
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
  "decidedByUserId"       INTEGER NULL,
  "decidedAt"             TIMESTAMPTZ NULL,
  "decisionNote"          TEXT NULL CHECK ("decisionNote" IS NULL OR length("decisionNote") <= 1000),
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
  CONSTRAINT "LegalIdentityCorrection_decided_shape" CHECK (("status" = 'PENDING') = ("decidedAt" IS NULL))
);
CREATE UNIQUE INDEX "LegalIdentityCorrection_one_open_per_business"
  ON "LegalIdentityCorrectionRequest" ("businessId") WHERE "status" = 'PENDING';
CREATE INDEX "LegalIdentityCorrection_business_created" ON "LegalIdentityCorrectionRequest" ("businessId", "createdAt");

ALTER TABLE "LegalIdentityCorrectionRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LegalIdentityCorrectionRequest" FORCE ROW LEVEL SECURITY;
CREATE POLICY lic_tenant_read ON "LegalIdentityCorrectionRequest" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- Rows move only through the definer functions (the owner): any other UPDATE / DELETE / TRUNCATE is refused.
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

-- ---------------------------------------------------------------- decide (approver — granted to NOBODY yet)
-- Answers: APPLIED | REJECTED | STALE | NOT_PENDING | NOT_FOUND | NOT_ALLOWED | NOTE_REQUIRED.
CREATE OR REPLACE FUNCTION public.legal_identity_correction_decide(
  p_request_id integer, p_approver_user_id integer, p_approve boolean, p_note text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  r public."LegalIdentityCorrectionRequest";
  p public."BusinessProfile";
BEGIN
  SELECT * INTO r FROM public."LegalIdentityCorrectionRequest" WHERE "id" = p_request_id;
  IF r."id" IS NULL THEN RETURN 'NOT_FOUND'; END IF;
  -- Four eyes, from outside the business: a platform administrator who is neither the requester nor its user.
  IF p_approver_user_id IS NULL OR p_approver_user_id = r."requestedByUserId"
     OR NOT EXISTS (SELECT 1 FROM public."User" u WHERE u."id" = p_approver_user_id AND u."role" = 'PLATFORM_ADMIN'
                      AND u."businessId" <> r."businessId") THEN
    RETURN 'NOT_ALLOWED';
  END IF;
  IF p_approve IS DISTINCT FROM true AND (p_note IS NULL OR length(btrim(p_note)) < 5) THEN RETURN 'NOTE_REQUIRED'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('legal_identity:' || r."businessId", 0));
  SELECT * INTO r FROM public."LegalIdentityCorrectionRequest" WHERE "id" = p_request_id FOR UPDATE;
  IF r."status" <> 'PENDING' THEN RETURN 'NOT_PENDING'; END IF;
  IF p_approve IS DISTINCT FROM true THEN
    UPDATE public."LegalIdentityCorrectionRequest"
       SET "status" = 'REJECTED', "decidedByUserId" = p_approver_user_id, "decidedAt" = now(), "decisionNote" = btrim(p_note)
     WHERE "id" = r."id";
    RETURN 'REJECTED';
  END IF;
  SELECT * INTO p FROM public."BusinessProfile" WHERE "businessId" = r."businessId" FOR UPDATE;
  IF p."id" IS NULL OR p."legalIdentityConfirmedAt" IS NULL
     OR public.legal_identity_business_is_being_deleted(r."businessId")
     OR p."billingBusinessKind" IS DISTINCT FROM r."currentBusinessKind"
     OR p."billingLegalName" IS DISTINCT FROM r."currentLegalName"
     OR p."billingTaxId" IS DISTINCT FROM r."currentTaxId" THEN
    -- The identity moved since the request was made (or the business is leaving): apply nothing.
    UPDATE public."LegalIdentityCorrectionRequest"
       SET "status" = 'STALE', "decidedByUserId" = p_approver_user_id, "decidedAt" = now(), "decisionNote" = NULLIF(btrim(coalesce(p_note, '')), '')
     WHERE "id" = r."id";
    RETURN 'STALE';
  END IF;
  -- As the table owner: passes the legal identity lock and the issuer-declaration lock. Issued documents untouched.
  UPDATE public."BusinessProfile"
     SET "billingBusinessKind" = r."requestedBusinessKind", "billingLegalName" = r."requestedLegalName",
         "billingTaxId" = r."requestedTaxId", "updatedAt" = now()
   WHERE "id" = p."id";
  UPDATE public."LegalIdentityCorrectionRequest"
     SET "status" = 'APPLIED', "decidedByUserId" = p_approver_user_id, "decidedAt" = now(), "decisionNote" = NULLIF(btrim(coalesce(p_note, '')), '')
   WHERE "id" = r."id";
  RETURN 'APPLIED';
END
$fn$;
REVOKE ALL ON FUNCTION public.legal_identity_correction_decide(integer, integer, boolean, text) FROM PUBLIC;

-- ---------------------------------------------------------------- erase (account deletion, tenant runtime)
-- Anonymises (never deletes) the requests of the tenant business, only while it is being deleted: names, numbers, the
-- reason and the note become NULL; status, decision author and times stay. Returns the count.
CREATE OR REPLACE FUNCTION public.legal_identity_correction_erase()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE v_business integer := NULLIF(current_setting('app.current_business_id', true), '')::integer; n integer;
BEGIN
  IF v_business IS NULL OR NOT public.legal_identity_business_is_being_deleted(v_business) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZC01', MESSAGE = 'LEGAL_IDENTITY_CORRECTION_ERASE_NOT_DELETING';
  END IF;
  UPDATE public."LegalIdentityCorrectionRequest"
     SET "currentLegalName" = NULL, "currentTaxId" = NULL, "requestedLegalName" = NULL,
         "requestedTaxId" = NULL, "reason" = NULL,
         "decisionNote" = NULL, "status" = CASE WHEN "status" = 'PENDING' THEN 'CANCELLED' ELSE "status" END,
         "decidedAt" = COALESCE("decidedAt", now()), "anonymisedAt" = now()
   WHERE "businessId" = v_business AND "anonymisedAt" IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$fn$;
REVOKE ALL ON FUNCTION public.legal_identity_correction_erase() FROM PUBLIC;

-- ---------------------------------------------------------------- privileges
REVOKE ALL ON "LegalIdentityCorrectionRequest" FROM PUBLIC;
REVOKE ALL ON "LegalIdentityCorrectionRequest" FROM app_runtime, app_auth;
GRANT SELECT ON "LegalIdentityCorrectionRequest" TO app_runtime;   -- its own business's history (RLS)
REVOKE ALL ON FUNCTION public.legal_identity_correction_guard() FROM app_runtime, app_auth;
REVOKE ALL ON FUNCTION public.legal_identity_correction_request(integer, text, text, text, text, text, boolean, text, timestamptz) FROM app_runtime, app_auth;
REVOKE ALL ON FUNCTION public.legal_identity_correction_cancel(integer, integer) FROM app_runtime, app_auth;
REVOKE ALL ON FUNCTION public.legal_identity_correction_decide(integer, integer, boolean, text) FROM app_runtime, app_auth;
REVOKE ALL ON FUNCTION public.legal_identity_correction_erase() FROM app_runtime, app_auth;
GRANT EXECUTE ON FUNCTION public.legal_identity_correction_request(integer, text, text, text, text, text, boolean, text, timestamptz) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.legal_identity_correction_cancel(integer, integer) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.legal_identity_correction_erase() TO app_runtime;
-- legal_identity_correction_decide: intentionally NOT granted. A follow-up migration grants it to the approver plane
-- the owner chooses, together with the verification policy.
