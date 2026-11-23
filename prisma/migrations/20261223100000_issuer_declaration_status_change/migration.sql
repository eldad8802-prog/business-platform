-- 4a T1 — the issuer declaration STATUS_CHANGE writer (DRAFT — NOT APPROVED FOR MERGE OR APPLY).
--
-- Owner decisions 2026-11-20/21: an exempt dealer becomes an authorized dealer inside the same business file
-- ("מעבר לעוסק מורשה"; business_kind_transition_to_authorized, 20261221090000). While the business holds a live issuer
-- declaration (20261126100000) the profile is a projection of it (DZD35), so the transition refuses today
-- (ISSUER_DECLARATION_ACTIVE). This migration adds the writer the transition will call, in ITS transaction, before it
-- updates the profile:
--
--   issuer_declaration_status_change(...)   files declaration version+1, kind STATUS_CHANGE, track
--                                           AUTHORIZED_DEALER_INDIVIDUAL, vatStatus AUTHORIZED, the new VAT number;
--                                           every other issuer field copied from the current record (same legal
--                                           form, id type, id number, legal name, contact details); supersedes the
--                                           current record; effectiveFrom = now(); filed by the current authorized
--                                           user; the statement = the transition statement the owner confirmed
--                                           (version + sha256), the re-authentication = the transition's.
--                                           Returns a status. Writes nothing unless every check passes.
--   issuer_status_change_origin_guard()     a STATUS_CHANGE record is admitted only from the table owner (the definer
--                                           functions). The runtime keeps INSERT on the table for the emailed-link
--                                           flow (INITIAL / EXISTING_CONFIRMATION); without this guard it could file
--                                           a STATUS_CHANGE on its own and leave the profile behind the declaration.
--
-- Nobody but the owner may EXECUTE the writer: the runtime never calls it directly — only the transition (SECURITY
-- DEFINER, same owner) does, so a declaration and a profile can only change together.
--
-- NOT done here (separate approval, legal identity track): the transition calling this function instead of
-- refusing. Until then this function has no caller and nothing changes for any business.
--
-- Statuses: DECLARED | NOT_ALLOWED | REAUTH_REQUIRED | STATEMENT_INVALID | NO_LIVE_DECLARATION |
--           DECLARATION_NOT_EXEMPT | NOT_AUTHORIZED_USER | IDENTITY_MISMATCH | VAT_NUMBER_INVALID |
--           DECLARATION_NOT_YET_EFFECTIVE. The chain guard (DZD31/DZD33) re-checks the record itself on INSERT.
-- Messages never carry a value.
--
-- Depends on: 20261126100000_issuer_declaration, 20261128090000_signup_legal_identity (legal_identity_tax_id_ok),
-- 20261221090000_business_kind_transition (the statement version), 20261223090000_issuer_reauth_google (GOOGLE).

SET lock_timeout = '3s';

-- ---------------------------------------------------------------- origin guard
-- SECURITY INVOKER on purpose: current_user is the writer. Inside a SECURITY DEFINER function owned by the table
-- owner, current_user is the owner; the runtime inserting directly is refused whatever session settings it set.
CREATE OR REPLACE FUNCTION public.issuer_status_change_origin_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF NEW."kind" = 'STATUS_CHANGE'
     AND current_user IS DISTINCT FROM (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZD33', MESSAGE = 'ISSUER_STATUS_CHANGE_ONLY_BY_TRANSITION';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.issuer_status_change_origin_guard() FROM PUBLIC;
CREATE TRIGGER "BusinessIssuerDeclaration_status_change_origin" BEFORE INSERT ON "BusinessIssuerDeclaration"
  FOR EACH ROW EXECUTE FUNCTION public.issuer_status_change_origin_guard();

-- ---------------------------------------------------------------- the writer
CREATE OR REPLACE FUNCTION public.issuer_declaration_status_change(
  p_user_id integer, p_vat_number text, p_reauth_method text, p_reauth_at timestamptz,
  p_statement_version text, p_statement_sha256 text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_business integer := NULLIF(current_setting('app.current_business_id', true), '')::integer;
  cur public."BusinessIssuerDeclaration";
  p public."BusinessProfile";
BEGIN
  -- Who: a user of the business in context (the caller's tenant transaction).
  IF v_business IS NULL OR p_user_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM public."User" u WHERE u."id" = p_user_id AND u."businessId" = v_business) THEN
    RETURN 'NOT_ALLOWED';
  END IF;
  -- The same re-authentication the transition verified (method + bounded age), recorded on the declaration too.
  IF p_reauth_method IS NULL OR p_reauth_method NOT IN ('PASSWORD', 'GOOGLE') OR p_reauth_at IS NULL
     OR p_reauth_at < now() - interval '10 minutes' OR p_reauth_at > now() + interval '1 minute' THEN
    RETURN 'REAUTH_REQUIRED';
  END IF;
  -- The statement is the transition statement the owner confirmed (five acknowledgements, bound to name, id number,
  -- VAT number and the declared start date); the transition computed its digest from the profile.
  IF p_statement_version IS DISTINCT FROM 'kind-transition-exempt-to-authorized-v1'
     OR p_statement_sha256 IS NULL OR p_statement_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN 'STATEMENT_INVALID';
  END IF;

  -- The chain guard's lock, taken before reading the current record: two writers of one business queue here, and the
  -- second one reads the record the first one filed.
  PERFORM pg_advisory_xact_lock(hashtextextended('issuer_declaration:' || v_business, 0));
  SELECT * INTO cur FROM public."BusinessIssuerDeclaration"
   WHERE "businessId" = v_business ORDER BY "version" DESC LIMIT 1;
  IF cur."id" IS NULL OR cur."anonymisedAt" IS NOT NULL THEN RETURN 'NO_LIVE_DECLARATION'; END IF;
  IF cur."track" <> 'EXEMPT_DEALER' OR cur."vatStatus" <> 'EXEMPT' THEN RETURN 'DECLARATION_NOT_EXEMPT'; END IF;
  -- Only the user the current record names as authorized files the next one (the chain guard enforces it as well).
  IF cur."authorizedUserId" <> p_user_id THEN RETURN 'NOT_AUTHORIZED_USER'; END IF;

  -- The profile still matches the declaration (DZD35 kept it so): same name, same id number, still exempt.
  SELECT * INTO p FROM public."BusinessProfile" WHERE "businessId" = v_business FOR UPDATE;
  IF p."id" IS NULL
     OR p."billingBusinessKind" IS DISTINCT FROM 'EXEMPT_DEALER'
     OR p."billingLegalName" IS DISTINCT FROM cur."legalName"
     OR p."billingTaxId" IS DISTINCT FROM cur."idNumber" THEN
    RETURN 'IDENTITY_MISMATCH';
  END IF;
  -- An individual authorized dealer's VAT file number is the person's own id number (owner 11-20).
  IF p_vat_number IS NULL OR p_vat_number IS DISTINCT FROM cur."idNumber" OR NOT public.legal_identity_tax_id_ok(p_vat_number) THEN
    RETURN 'VAT_NUMBER_INVALID';
  END IF;
  -- The chain guard requires effectiveFrom >= the current record's. A record may be filed up to 5 minutes ahead.
  IF cur."effectiveFrom" > now() THEN RETURN 'DECLARATION_NOT_YET_EFFECTIVE'; END IF;

  INSERT INTO public."BusinessIssuerDeclaration" ("businessId","version","supersedesId","kind","track","legalForm","vatStatus",
      "legalName","tradeName","idType","idNumber","vatRegistrationNumber","address","phone","email","effectiveFrom","reason",
      "authorizedUserId","authorityBasis","authorityEvidenceRef","declaredByUserId","declarantName","declarantCapacity",
      "statementVersion","statementSha256","reauthMethod","reauthAt")
  VALUES (v_business, cur."version" + 1, cur."id", 'STATUS_CHANGE', 'AUTHORIZED_DEALER_INDIVIDUAL', 'INDIVIDUAL', 'AUTHORIZED',
      cur."legalName", cur."tradeName", cur."idType", cur."idNumber", p_vat_number, cur."address", cur."phone", cur."email",
      now(), 'מעבר לעוסק מורשה', p_user_id, 'CURRENT_AUTHORIZED_USER', NULL, p_user_id, cur."declarantName", cur."declarantCapacity",
      p_statement_version, p_statement_sha256, p_reauth_method::"IssuerReauthMethod", p_reauth_at);
  RETURN 'DECLARED';
END
$fn$;
REVOKE ALL ON FUNCTION public.issuer_declaration_status_change(integer, text, text, timestamptz, text, text) FROM PUBLIC;

-- ---------------------------------------------------------------- privileges
-- Default privileges may hand the new functions to the application roles: take that back. No grant follows — the
-- writer runs only inside the transition (same owner); the guard is a trigger function.
DO $do$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS fn, pg_get_userbyid(x.grantee) AS grantee
      FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
     WHERE p.proname IN ('issuer_declaration_status_change', 'issuer_status_change_origin_guard')
       AND p.pronamespace = 'public'::regnamespace
       AND x.grantee <> p.proowner AND x.grantee <> 0
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', r.fn, r.grantee);
  END LOOP;
END
$do$;

-- ---------------------------------------------------------------- down
-- While no STATUS_CHANGE record exists (P-DOWN = 0), rollback is:
--   DROP TRIGGER "BusinessIssuerDeclaration_status_change_origin" ON "BusinessIssuerDeclaration";
--   DROP FUNCTION public.issuer_status_change_origin_guard();
--   DROP FUNCTION public.issuer_declaration_status_change(integer, text, text, timestamptz, text, text);
-- (first restoring the transition's ISSUER_DECLARATION_ACTIVE refusal if the follow-up was applied).
--   P-DOWN: SELECT count(*) FROM "BusinessIssuerDeclaration" WHERE "kind" = 'STATUS_CHANGE';
-- Records already filed are append-only and stay: they are the business's issuer history.
