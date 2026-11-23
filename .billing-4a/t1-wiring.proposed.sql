-- LAB ONLY — PROPOSED CONTRACT for the legal identity follow-up (NOT a migration, NOT 4a's to ship).
--
-- 4a T1: the shape of the change the legal identity track (session f3) is expected to make in its own migration,
-- under its own approval: business_kind_transition_to_authorized() stops refusing ISSUER_DECLARATION_ACTIVE and calls
-- issuer_declaration_status_change() (20261223100000) instead. Everything else in the function is byte-for-byte the
-- version applied in Production (20261221090000). .billing-4a/lab.sh --with-t1-wiring applies this file to a lab
-- database so the T1 battery can exercise the joined path BEFORE the real wiring exists; results obtained with it
-- are labelled "pre-integration (simulated wiring)" and do not replace the integrated test on the real migration.
--
-- Differences from 20261221090000:
--   1. the live-declaration refusal is removed from its place (before the statement check);
--   2. after the statement check, before the history row and the profile update: a live declaration → the writer;
--      DECLARED → continue; anything else → return 'ISSUER_DECLARATION_<status>' (nothing written yet);
--   3. a new local v_decl.
-- The statement version/digest passed to the writer are the transition's own (v_sha, computed from the profile).
-- New statuses the application must map (lib/legal-identity/kind-transition.ts kindTransitionOutcome):
--   ISSUER_DECLARATION_NOT_AUTHORIZED_USER, ISSUER_DECLARATION_IDENTITY_MISMATCH, ISSUER_DECLARATION_DECLARATION_NOT_EXEMPT,
--   ISSUER_DECLARATION_DECLARATION_NOT_YET_EFFECTIVE, and (unreachable after the transition's own checks, mapped to 500)
--   ISSUER_DECLARATION_NOT_ALLOWED / _REAUTH_REQUIRED / _STATEMENT_INVALID / _VAT_NUMBER_INVALID / _NO_LIVE_DECLARATION.

CREATE OR REPLACE FUNCTION public.business_kind_transition_to_authorized(
  p_user_id integer, p_vat_number text, p_status_effective_date date,
  p_reauth_method text, p_reauth_at timestamptz, p_statement_sha256 text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_business integer := NULLIF(current_setting('app.current_business_id', true), '')::integer;
  v_today    date := (now() AT TIME ZONE 'Asia/Jerusalem')::date;
  p public."BusinessProfile";
  d public."BusinessIssuerDeclaration";
  v_sha text;
  v_decl text;
BEGIN
  -- Who: the session user (server-derived) of the business in context, which is alive.
  IF v_business IS NULL OR p_user_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM public."User" u WHERE u."id" = p_user_id AND u."businessId" = v_business)
     OR public.legal_identity_business_is_being_deleted(v_business) THEN
    RETURN 'NOT_ALLOWED';
  END IF;
  -- v1 authority rule, the same as account deletion: only the business's sole user. A business with several users
  -- has no designated authority yet (owner decision pending) — never "the first user".
  IF (SELECT count(*) FROM public."User" u WHERE u."businessId" = v_business) <> 1 THEN
    RETURN 'NOT_SOLE_USER';
  END IF;
  -- Fresh server-side re-authentication (the route verified the password / Google; this bounds its age).
  IF p_reauth_method IS NULL OR p_reauth_method NOT IN ('PASSWORD', 'GOOGLE') OR p_reauth_at IS NULL
     OR p_reauth_at < now() - interval '10 minutes' OR p_reauth_at > now() + interval '1 minute' THEN
    RETURN 'REAUTH_REQUIRED';
  END IF;

  -- One identity operation at a time per business (the same key as legal_identity_confirm_existing).
  PERFORM pg_advisory_xact_lock(hashtextextended('legal_identity:' || v_business, 0));
  SELECT * INTO p FROM public."BusinessProfile" WHERE "businessId" = v_business FOR UPDATE;
  IF p."id" IS NULL THEN RETURN 'IDENTITY_INCOMPLETE'; END IF;
  IF p."billingBusinessKind" IS DISTINCT FROM 'EXEMPT_DEALER' THEN RETURN 'NOT_EXEMPT_DEALER'; END IF;
  IF length(btrim(coalesce(p."billingLegalName", ''))) < 2
     OR p."billingTaxId" IS NULL OR NOT public.legal_identity_tax_id_ok(p."billingTaxId") THEN
    RETURN 'IDENTITY_INCOMPLETE';
  END IF;
  -- Same entity: an individual authorized dealer's VAT file number is the person's own id number (owner 11-20).
  IF p_vat_number IS NULL OR NOT public.legal_identity_tax_id_ok(p_vat_number) THEN RETURN 'VAT_NUMBER_INVALID'; END IF;
  IF p_vat_number <> p."billingTaxId" THEN RETURN 'VAT_NUMBER_DIFFERS_FROM_TAX_ID'; END IF;
  IF p_status_effective_date IS NULL OR p_status_effective_date > v_today OR p_status_effective_date < DATE '2000-01-01' THEN
    RETURN 'EFFECTIVE_DATE_INVALID';
  END IF;
  -- What the owner saw is what is on file now (nothing changed between the review screen and the confirmation).
  v_sha := encode(sha256(convert_to(public.business_kind_transition_statement(
             v_business, p_user_id, p."billingLegalName", p."billingTaxId", p_vat_number, p_status_effective_date), 'UTF8')), 'hex');
  IF p_statement_sha256 IS DISTINCT FROM v_sha THEN RETURN 'STATEMENT_STALE'; END IF;

  -- [T1 wiring] A live issuer declaration: file declaration version+1 (STATUS_CHANGE) in THIS transaction, before
  -- the profile changes, so the profile keeps following the declaration (DZD35). The writer returns a status and
  -- writes nothing unless it files the record; any refusal here returns before anything is written.
  SELECT * INTO d FROM public."BusinessIssuerDeclaration" WHERE "businessId" = v_business ORDER BY "version" DESC LIMIT 1;
  IF d."id" IS NOT NULL AND d."anonymisedAt" IS NULL THEN
    v_decl := public.issuer_declaration_status_change(
                p_user_id, p_vat_number, p_reauth_method, p_reauth_at, 'kind-transition-exempt-to-authorized-v1', v_sha);
    IF v_decl IS DISTINCT FROM 'DECLARED' THEN RETURN 'ISSUER_DECLARATION_' || coalesce(v_decl, 'UNKNOWN'); END IF;
  END IF;

  INSERT INTO public."BusinessKindTransition" (
    "businessId", "fromKind", "toKind", "statusEffectiveDate", "confirmedAt", "confirmedByUserId",
    "reauthMethod", "reauthAt", "statementVersion", "statementSha256")
  VALUES (v_business, 'EXEMPT_DEALER', 'AUTHORIZED_DEALER', p_status_effective_date, now(), p_user_id,
          p_reauth_method, p_reauth_at, 'kind-transition-exempt-to-authorized-v1', v_sha);
  -- Only the kind and the VAT number change. Name, id number and the confirmation state are not touched.
  UPDATE public."BusinessProfile"
     SET "billingBusinessKind" = 'AUTHORIZED_DEALER', "billingVatNumber" = p_vat_number, "updatedAt" = now()
   WHERE "id" = p."id" AND "billingBusinessKind" = 'EXEMPT_DEALER';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'DZL07', MESSAGE = 'KIND_TRANSITION_PROFILE_NOT_UPDATED';  -- rolls back the row
  END IF;
  RETURN 'TRANSITIONED';
END
$fn$;
