-- Business kind transition ← 4a T1 wiring (owner approval 2026-11-24, lab only until a separate release approval).
--
-- "מעבר לעוסק מורשה" for a business that holds a live issuer declaration. Until now
-- business_kind_transition_to_authorized (20261221090000) refused such a business (ISSUER_DECLARATION_ACTIVE),
-- because the profile must keep following the declaration (DZD35) and no path could file the new status. 4a T1
-- (20261223100000, applied in Production) provides that path: issuer_declaration_status_change(), a SECURITY DEFINER
-- writer no role may EXECUTE, callable only from another definer owned by the same role. This migration makes the
-- transition call it, inside the transition's own transaction, exactly as .billing-4a/T1-WIRING-CONTRACT.md §2 says:
--
--   1. the early ISSUER_DECLARATION_ACTIVE refusal is removed;
--   2. after the STATEMENT_STALE check, before the history row and the profile update: if the latest declaration
--      exists and is not anonymised, the writer files version+1 (STATUS_CHANGE, AUTHORIZED_DEALER_INDIVIDUAL) with the
--      transition's OWN digest (v_sha, computed here from the profile — never a value from the request), the same
--      re-auth method and instant. DECLARED → continue; any other answer → return 'ISSUER_DECLARATION_<status>'
--      before anything is written;
--   3. everything else is byte-identical to 20261221090000: who may act, the re-auth window, the advisory lock, the
--      profile lock (FOR UPDATE), every check and its order, the history row, the profile update, DZL07.
--
-- A business WITHOUT a live declaration (none, or the latest is anonymised) never reaches the writer: it transitions
-- exactly as before and no declaration is created. A business that does not transition is not touched at all.
-- Atomic: the writer, the history row and the profile update share one transaction; any failure after the writer
-- filed v2 rolls back v2 with everything else (lab: .bkt/wiring-battery.mts + .billing-4a battery section W).
--
-- Not done here: no table, column, policy, trigger or grant changes; CREATE OR REPLACE keeps the function's owner,
-- SECURITY DEFINER flag and ACL (app_runtime EXECUTE only). No Billing table is named. Issued documents are untouched.
--
-- Statuses: those of 20261221090000 without ISSUER_DECLARATION_ACTIVE, plus 'ISSUER_DECLARATION_' || the writer's
-- refusal (NOT_AUTHORIZED_USER, IDENTITY_MISMATCH, DECLARATION_NOT_EXEMPT, DECLARATION_NOT_YET_EFFECTIVE; the others
-- are unreachable after this function's own checks).
--
-- Depends on 20261221090000_business_kind_transition, 20261223090000_issuer_reauth_google and
-- 20261223100000_issuer_declaration_status_change (all applied in Production). The guard below refuses otherwise.
-- Rollback: .bkt/rollback-wiring.sql restores the 20261221090000 body (no data to undo: STATUS_CHANGE rows filed by
-- the wiring are append-only history and stay).

-- ---------------------------------------------------------------- guard: the premises, or nothing happens
DO $guard$
DECLARE
  v_tx_owner oid;
  v_writer_owner oid;
  v_decl_owner oid;
BEGIN
  SELECT p.proowner INTO v_tx_owner FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.business_kind_transition_to_authorized(integer, text, date, text, timestamptz, text)');
  IF v_tx_owner IS NULL THEN
    RAISE EXCEPTION 'KT_WIRING_PREMISE: business_kind_transition_to_authorized (20261221090000) is missing';
  END IF;
  SELECT p.proowner INTO v_writer_owner FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.issuer_declaration_status_change(integer, text, text, timestamptz, text, text)')
     AND p.prosecdef;
  IF v_writer_owner IS NULL THEN
    RAISE EXCEPTION 'KT_WIRING_PREMISE: issuer_declaration_status_change (20261223100000) is missing or not SECURITY DEFINER';
  END IF;
  SELECT c.relowner INTO v_decl_owner FROM pg_class c
   WHERE c.oid = to_regclass('public."BusinessIssuerDeclaration"');
  -- The writer is callable only by a definer owned by its own role: both must share the owner, or every call fails.
  IF v_writer_owner <> v_tx_owner OR v_decl_owner IS DISTINCT FROM v_tx_owner THEN
    RAISE EXCEPTION 'KT_WIRING_PREMISE: the transition, the writer and BusinessIssuerDeclaration do not share one owner';
  END IF;
  -- The predecessor is the version applied in Production (it still refuses a live declaration).
  IF position('ISSUER_DECLARATION_ACTIVE' IN pg_get_functiondef(
       'public.business_kind_transition_to_authorized(integer, text, date, text, timestamptz, text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'KT_WIRING_PREMISE: business_kind_transition_to_authorized is not the 20261221090000 version';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                  WHERE t.typname = 'IssuerReauthMethod' AND e.enumlabel = 'GOOGLE') THEN
    RAISE EXCEPTION 'KT_WIRING_PREMISE: IssuerReauthMethod has no GOOGLE (20261223090000)';
  END IF;
END
$guard$;

-- ---------------------------------------------------------------- the transition, wired
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

  -- [4a T1 wiring] A live issuer declaration: file declaration version+1 (STATUS_CHANGE) in THIS transaction, before
  -- the profile changes, so the profile keeps following the declaration (DZD35). The writer returns a status and
  -- writes nothing unless it files the record; any refusal here returns before anything is written. No declaration,
  -- or an anonymised one: nothing to file, the transition goes on exactly as before.
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

-- ---------------------------------------------------------------- post-check: privileges and shape unchanged
DO $post$
DECLARE
  v_fn regprocedure := 'public.business_kind_transition_to_authorized(integer, text, date, text, timestamptz, text)'::regprocedure;
  v_writer regprocedure := 'public.issuer_declaration_status_change(integer, text, text, timestamptz, text, text)'::regprocedure;
BEGIN
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_fn) THEN
    RAISE EXCEPTION 'KT_WIRING_POST: the transition is no longer SECURITY DEFINER';
  END IF;
  IF NOT has_function_privilege('app_runtime', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'KT_WIRING_POST: app_runtime lost EXECUTE on the transition';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
              WHERE p.oid IN (v_fn, v_writer) AND x.grantee = 0) THEN
    RAISE EXCEPTION 'KT_WIRING_POST: PUBLIC may execute the transition or the writer';
  END IF;
  IF has_function_privilege('app_runtime', v_writer, 'EXECUTE') THEN
    RAISE EXCEPTION 'KT_WIRING_POST: app_runtime may execute the writer directly';
  END IF;
  IF position('ISSUER_DECLARATION_ACTIVE' IN pg_get_functiondef(v_fn)) > 0
     OR position('issuer_declaration_status_change' IN pg_get_functiondef(v_fn)) = 0 THEN
    RAISE EXCEPTION 'KT_WIRING_POST: the transition is not wired';
  END IF;
END
$post$;
