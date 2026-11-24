-- Rollback of 20261225090000_kind_transition_issuer_declaration_wiring. Run by the table owner (the function owner).
-- Restores business_kind_transition_to_authorized to the 20261221090000 body, byte for byte (generated from that
-- migration file; the wiring lab compares the restored definition with it). CREATE OR REPLACE keeps the owner,
-- SECURITY DEFINER and the ACL (app_runtime EXECUTE), so no grant is touched.
-- Order: revert the application change first ONLY if it would mislead users; the previous application maps
-- ISSUER_DECLARATION_ACTIVE, and the wired application keeps that mapping, so either order is safe.
-- Data impact: none is undone. Declaration STATUS_CHANGE rows and transition history rows filed while the wiring was
-- live are append-only records of what happened and stay; those businesses are already AUTHORIZED_DEALER and the
-- restored function answers NOT_EXEMPT_DEALER for them. Live-declaration businesses are refused again
-- (ISSUER_DECLARATION_ACTIVE).
BEGIN;
SET LOCAL lock_timeout = '3s';
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
  -- A live issuer declaration: the profile must follow it (DZD35). Not handled here yet — refuse, write nothing.
  SELECT * INTO d FROM public."BusinessIssuerDeclaration" WHERE "businessId" = v_business ORDER BY "version" DESC LIMIT 1;
  IF d."id" IS NOT NULL AND d."anonymisedAt" IS NULL THEN RETURN 'ISSUER_DECLARATION_ACTIVE'; END IF;
  -- What the owner saw is what is on file now (nothing changed between the review screen and the confirmation).
  v_sha := encode(sha256(convert_to(public.business_kind_transition_statement(
             v_business, p_user_id, p."billingLegalName", p."billingTaxId", p_vat_number, p_status_effective_date), 'UTF8')), 'hex');
  IF p_statement_sha256 IS DISTINCT FROM v_sha THEN RETURN 'STATEMENT_STALE'; END IF;

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
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261225090000_kind_transition_issuer_declaration_wiring';
COMMIT;
