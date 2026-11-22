-- Business kind transition (owner decision 2026-11-20): "מעבר לעוסק מורשה". An exempt dealer (EXEMPT_DEALER) becomes
-- an authorized dealer (AUTHORIZED_DEALER) inside the SAME business file: same legal entity, same id number, same
-- legal name. A legal name or id number is never changed by this (or any) path — that is a new business file.
--
--   BusinessKindTransition                        append-only history, one row per transition: the kinds, the two
--                                                 dates (the status start date the owner declares for the Tax
--                                                 Authority; the moment the owner confirmed in Dubiz), who confirmed,
--                                                 how they re-authenticated, and the sha256 of the exact statement
--                                                 they confirmed. No name / id number is copied here: the profile
--                                                 holds them (locked) and the digest binds them.
--   business_kind_transition_to_authorized(...)   the ONLY writer. Tenant plane (app_runtime), SECURITY DEFINER so it
--                                                 passes the signup lock (DZL04) for exactly this change. All checks,
--                                                 the history row and the profile update in ONE transaction: it
--                                                 returns a status and writes nothing unless every check passes.
--
-- Deliberately NOT done here (separate approvals):
--   * A live issuer declaration (#1091) makes the profile follow the declaration (DZD35). The owner bypasses that lock
--     too, so this function REFUSES (ISSUER_DECLARATION_ACTIVE) instead of desynchronising profile and declaration,
--     until the STATUS_CHANGE writer is agreed with the issuer-declaration track (4a).
--   * Issued documents: untouched (issuedSnapshot is frozen, DZ010). No document is re-issued or back-dated.
--   * Authorized → exempt: no path (refused: the profile must be EXEMPT_DEALER).
--
-- Statuses: TRANSITIONED | NOT_ALLOWED | NOT_SOLE_USER | REAUTH_REQUIRED | IDENTITY_INCOMPLETE | NOT_EXEMPT_DEALER |
--           VAT_NUMBER_INVALID | VAT_NUMBER_DIFFERS_FROM_TAX_ID | EFFECTIVE_DATE_INVALID | ISSUER_DECLARATION_ACTIVE |
--           STATEMENT_STALE.  Invariant violations raise DZL06 / DZL07. Messages never carry a value.
--
-- Depends on 20261128090000_signup_legal_identity (legal_identity_tax_id_ok, legal_identity_business_is_being_deleted)
-- and 20261126100000_issuer_declaration (BusinessIssuerDeclaration, read only). Both are applied in Production.

SET lock_timeout = '3s';

-- ---------------------------------------------------------------- history
CREATE TABLE "BusinessKindTransition" (
  "id"                  SERIAL PRIMARY KEY,
  "businessId"          INTEGER NOT NULL REFERENCES "Business"("id") ON DELETE RESTRICT,
  "fromKind"            TEXT NOT NULL CHECK ("fromKind" = 'EXEMPT_DEALER'),
  "toKind"              TEXT NOT NULL CHECK ("toKind" = 'AUTHORIZED_DEALER'),
  -- The date the owner declares the authorized-dealer status started at the Tax Authority. May be earlier than
  -- confirmedAt (recorded only: nothing issued before confirmedAt changes); never later than the confirmation day.
  "statusEffectiveDate" DATE NOT NULL CHECK ("statusEffectiveDate" >= DATE '2000-01-01'),
  -- The moment the owner confirmed in Dubiz = the moment new documents start following the new kind.
  "confirmedAt"         TIMESTAMPTZ NOT NULL DEFAULT now(),
  "confirmedByUserId"   INTEGER NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
  "reauthMethod"        TEXT NOT NULL CHECK ("reauthMethod" IN ('PASSWORD', 'GOOGLE')),
  "reauthAt"            TIMESTAMPTZ NOT NULL,
  "statementVersion"    TEXT NOT NULL CHECK ("statementVersion" = 'kind-transition-exempt-to-authorized-v1'),
  "statementSha256"     TEXT NOT NULL CHECK ("statementSha256" ~ '^[0-9a-f]{64}$'),
  "createdAt"           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "BusinessKindTransition_effective_not_after_confirm"
    CHECK ("statusEffectiveDate" <= ("confirmedAt" AT TIME ZONE 'Asia/Jerusalem')::date)
);
-- Exempt → authorized happens at most once per business (the reverse has no path).
CREATE UNIQUE INDEX "BusinessKindTransition_businessId_key" ON "BusinessKindTransition" ("businessId");

ALTER TABLE "BusinessKindTransition" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessKindTransition" FORCE ROW LEVEL SECURITY;
CREATE POLICY business_kind_transition_tenant_select ON "BusinessKindTransition" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
-- The definer function inserts for the business in context only. No role but the owner holds INSERT (see grants);
-- the policy keeps even that write inside the tenant.
CREATE POLICY business_kind_transition_tenant_insert ON "BusinessKindTransition" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- Append-only: nobody but the table owner (migrations, the definer function) writes; UPDATE is refused even to the
-- owner, DELETE only to the owner (maintenance / rollback).
CREATE OR REPLACE FUNCTION public.business_kind_transition_append_only()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION USING ERRCODE = 'DZL06', MESSAGE = 'KIND_TRANSITION_IS_APPEND_ONLY';
  END IF;
  IF current_user <> (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZL06', MESSAGE = 'KIND_TRANSITION_IS_APPEND_ONLY';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.business_kind_transition_append_only() FROM PUBLIC;
CREATE TRIGGER "BusinessKindTransition_append_only"
  BEFORE INSERT OR UPDATE OR DELETE ON "BusinessKindTransition"
  FOR EACH ROW EXECUTE FUNCTION public.business_kind_transition_append_only();

-- ---------------------------------------------------------------- the canonical statement (pure)
-- Byte-identical to lib/legal-identity/kind-transition.ts canonicalKindTransitionStatement() — the lab proves it.
CREATE OR REPLACE FUNCTION public.business_kind_transition_statement(
  p_business integer, p_actor integer, p_legal_name text, p_tax_id text, p_vat text, p_effective date)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $fn$
  SELECT concat_ws(E'\n',
    'statement=kind-transition-exempt-to-authorized-v1',
    'business=' || p_business::text,
    'actor=' || p_actor::text,
    'from=EXEMPT_DEALER',
    'to=AUTHORIZED_DEALER',
    'legalName=' || coalesce(p_legal_name, ''),
    'taxId=' || coalesce(p_tax_id, ''),
    'vatNumber=' || coalesce(p_vat, ''),
    'statusEffectiveDate=' || coalesce(to_char(p_effective, 'YYYY-MM-DD'), ''),
    'ack=registered_with_vat_authority',
    'ack=same_legal_entity',
    'ack=issued_documents_unchanged',
    'ack=new_documents_as_authorized',
    'ack=not_reversible_in_dubiz')
$fn$;
REVOKE ALL ON FUNCTION public.business_kind_transition_statement(integer, integer, text, text, text, date) FROM PUBLIC;

-- ---------------------------------------------------------------- the transition (the only writer)
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
REVOKE ALL ON FUNCTION public.business_kind_transition_to_authorized(integer, text, date, text, timestamptz, text) FROM PUBLIC;

-- ---------------------------------------------------------------- privileges (minimal)
-- Default privileges may hand the new table / sequence / functions to the application roles: take everything back,
-- then grant exactly what the runtime needs. The runtime reads history and calls the transition; it never writes the
-- table directly. app_auth and app_admin get nothing.
DO $do$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT DISTINCT c.oid::regclass::text AS rel, pg_get_userbyid(x.grantee) AS grantee, c.relkind
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
     WHERE c.relname IN ('BusinessKindTransition', 'BusinessKindTransition_id_seq')
       AND c.relnamespace = 'public'::regnamespace
       AND x.grantee <> c.relowner AND x.grantee <> 0
  LOOP
    IF r.relkind = 'S' THEN
      EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM %I', r.rel, r.grantee);
    ELSE
      EXECUTE format('REVOKE ALL ON TABLE %s FROM %I', r.rel, r.grantee);
    END IF;
  END LOOP;
  FOR r IN
    SELECT p.oid::regprocedure::text AS fn, pg_get_userbyid(x.grantee) AS grantee
      FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
     WHERE p.proname IN ('business_kind_transition_append_only', 'business_kind_transition_statement',
                         'business_kind_transition_to_authorized')
       AND p.pronamespace = 'public'::regnamespace
       AND x.grantee <> p.proowner AND x.grantee <> 0
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', r.fn, r.grantee);
  END LOOP;
END
$do$;
REVOKE ALL ON "BusinessKindTransition" FROM PUBLIC;

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT ON "BusinessKindTransition" TO app_runtime;
    GRANT EXECUTE ON FUNCTION public.business_kind_transition_to_authorized(integer, text, date, text, timestamptz, text) TO app_runtime;
  END IF;
END
$do$;
