-- Signup legal identity (owner decision 2026-11-12): every NEW business enters its legal identity at signup, and
-- once confirmed the identity cannot be changed by the business on its own.
--
-- No new identity columns. The identity lives where billing already reads it: BusinessProfile.billingBusinessKind,
-- billingLegalName, billingTaxId (the dealer number / ח"פ), billingAddress, billingPhone, billingEmail. This adds
-- only the CONFIRMATION STATE and its enforcement:
--
--   legalIdentityConfirmedAt / legalIdentitySource  NULL/NULL = not confirmed (every existing business: untouched,
--                                                    unlocked). Set together, only by the two functions below.
--   signup_legal_identity_seed(...)                  the auth plane (app_auth) writes the identity INSIDE the account
--                                                    transaction, for the business that transaction is creating and
--                                                    no other (xmin = the current transaction). So a new account and
--                                                    its identity commit together or not at all: there is no
--                                                    "account without identity" state to gate or to bypass.
--   legal_identity_confirm_existing(user)            the controlled completion for EXISTING businesses (tenant plane,
--                                                    app_runtime). Inert until the application calls it (flag OFF).
--   BusinessProfile_legal_identity_lock              once confirmed, billingBusinessKind / billingLegalName /
--                                                    billingTaxId cannot change, and nobody but these functions
--                                                    writes the confirmation state. Address, phone, email, trade
--                                                    name and activity stay editable.
--
-- Exceptions to the lock, both deliberate: the table owner (migrations; SECURITY DEFINER functions such as a future,
-- separately approved correction path with reason + audit), and a business being deleted (the account purge runs as
-- the runtime and clears these columns only after stage 1 committed Business.deletionRequestedAt).
--
-- Independent of the issuer declaration (#1091 20261123090000, #1105 20261126090000): names none of their objects,
-- and must be applied AFTER both (it sorts after them). Codes: DZL01..DZL04. Messages never carry a value.

SET lock_timeout = '3s';

ALTER TABLE "BusinessProfile"
  ADD COLUMN "legalIdentityConfirmedAt" TIMESTAMP(3),
  ADD COLUMN "legalIdentitySource"      TEXT;

ALTER TABLE "BusinessProfile"
  ADD CONSTRAINT "BusinessProfile_legalIdentitySource_check"
    CHECK ("legalIdentitySource" IS NULL OR "legalIdentitySource" IN ('SIGNUP', 'OWNER_CONFIRMED')),
  ADD CONSTRAINT "BusinessProfile_legalIdentity_pair"
    CHECK (("legalIdentityConfirmedAt" IS NULL) = ("legalIdentitySource" IS NULL));

-- ---------------------------------------------------------------- pure checks (no table access)
-- Israeli 9-digit identifier (ת.ז. / עוסק / ח"פ): digits only, 8 digits are left-padded, not all one digit, and the
-- published check digit holds. The same rule as lib/identity/tax-id.ts authoritativeTaxId().
CREATE OR REPLACE FUNCTION public.legal_identity_tax_id_ok(p text)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog AS $fn$
  SELECT p ~ '^[0-9]{9}$'
     AND p !~ '^(.)\1{8}$'
     AND (SELECT sum(CASE WHEN d > 9 THEN d - 9 ELSE d END)
            FROM (SELECT substr(p, i, 1)::int * (CASE WHEN i % 2 = 1 THEN 1 ELSE 2 END) AS d
                    FROM generate_series(1, 9) AS i) s) % 10 = 0
$fn$;
REVOKE ALL ON FUNCTION public.legal_identity_tax_id_ok(text) FROM PUBLIC;

-- Helper for the INVOKER trigger: one yes/no about one business, independent of the caller's grants on "Business".
CREATE OR REPLACE FUNCTION public.legal_identity_business_is_being_deleted(p_business integer)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
  SELECT EXISTS (SELECT 1 FROM public."Business" b WHERE b."id" = p_business
                   AND (b."deletionRequestedAt" IS NOT NULL OR b."deletedAt" IS NOT NULL))
$fn$;
REVOKE ALL ON FUNCTION public.legal_identity_business_is_being_deleted(integer) FROM PUBLIC;

-- ---------------------------------------------------------------- signup seed (auth plane, account transaction)
CREATE OR REPLACE FUNCTION public.signup_legal_identity_seed(
  p_business_id integer, p_kind text, p_legal_name text, p_tax_id text,
  p_address text, p_phone text, p_email text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  -- Only the business THIS transaction is creating: its row was written by the current transaction. app_auth can
  -- therefore never use this to write the profile of an existing business.
  IF p_business_id IS NULL OR NOT EXISTS (
       SELECT 1 FROM public."Business" b WHERE b."id" = p_business_id AND b.xmin = pg_current_xact_id()::xid) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZL01', MESSAGE = 'LEGAL_IDENTITY_SEED_NOT_NEW_BUSINESS';
  END IF;
  -- The application validated first; this is the backstop. The message names the FIELD, never the value.
  IF p_kind IS NULL OR p_kind NOT IN ('EXEMPT_DEALER', 'AUTHORIZED_DEALER', 'LTD_COMPANY') THEN
    RAISE EXCEPTION USING ERRCODE = 'DZL02', MESSAGE = 'LEGAL_IDENTITY_INVALID', DETAIL = 'kind';
  END IF;
  IF p_legal_name IS NULL OR p_legal_name <> btrim(p_legal_name) OR length(p_legal_name) NOT BETWEEN 2 AND 200 THEN
    RAISE EXCEPTION USING ERRCODE = 'DZL02', MESSAGE = 'LEGAL_IDENTITY_INVALID', DETAIL = 'legalName';
  END IF;
  IF p_tax_id IS NULL OR NOT public.legal_identity_tax_id_ok(p_tax_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'DZL02', MESSAGE = 'LEGAL_IDENTITY_INVALID', DETAIL = 'taxId';
  END IF;
  IF p_address IS NULL OR p_address <> btrim(p_address) OR length(p_address) NOT BETWEEN 2 AND 300 THEN
    RAISE EXCEPTION USING ERRCODE = 'DZL02', MESSAGE = 'LEGAL_IDENTITY_INVALID', DETAIL = 'address';
  END IF;
  IF p_phone IS NULL OR p_phone !~ '^\+?[0-9]{7,15}$' THEN
    RAISE EXCEPTION USING ERRCODE = 'DZL02', MESSAGE = 'LEGAL_IDENTITY_INVALID', DETAIL = 'phone';
  END IF;
  IF p_email IS NULL OR p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' OR length(p_email) > 320 THEN
    RAISE EXCEPTION USING ERRCODE = 'DZL02', MESSAGE = 'LEGAL_IDENTITY_INVALID', DETAIL = 'email';
  END IF;
  -- A plain INSERT: a business created in this transaction has no profile yet; anything else is a conflict and
  -- rolls the whole signup back (fail closed) rather than writing over a row.
  INSERT INTO public."BusinessProfile" (
    "businessId", "billingBusinessKind", "billingLegalName", "billingTaxId",
    "billingAddress", "billingPhone", "billingEmail",
    "legalIdentityConfirmedAt", "legalIdentitySource", "createdAt", "updatedAt")
  VALUES (p_business_id, p_kind, p_legal_name, p_tax_id, p_address, p_phone, p_email,
          now(), 'SIGNUP', now(), now());
END
$fn$;
REVOKE ALL ON FUNCTION public.signup_legal_identity_seed(integer, text, text, text, text, text, text) FROM PUBLIC;

-- ---------------------------------------------------------------- controlled completion (existing businesses)
-- Confirms the identity an existing business already has; never writes an identity value. The caller is the tenant
-- runtime under the business's own context; p_user_id is the session user (server-derived), who must belong to it.
-- Answers: CONFIRMED | ALREADY_CONFIRMED | INCOMPLETE | INVALID_TAX_ID | NOT_ALLOWED.
CREATE OR REPLACE FUNCTION public.legal_identity_confirm_existing(p_user_id integer)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_business integer := NULLIF(current_setting('app.current_business_id', true), '')::integer;
  p public."BusinessProfile";
BEGIN
  IF v_business IS NULL OR p_user_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM public."User" u WHERE u."id" = p_user_id AND u."businessId" = v_business)
     OR public.legal_identity_business_is_being_deleted(v_business) THEN
    RETURN 'NOT_ALLOWED';
  END IF;
  -- One confirmation at a time per business.
  PERFORM pg_advisory_xact_lock(hashtextextended('legal_identity:' || v_business, 0));
  SELECT * INTO p FROM public."BusinessProfile" WHERE "businessId" = v_business FOR UPDATE;
  IF p."id" IS NULL THEN RETURN 'INCOMPLETE'; END IF;
  IF p."legalIdentityConfirmedAt" IS NOT NULL THEN RETURN 'ALREADY_CONFIRMED'; END IF;
  IF p."billingBusinessKind" IS NULL OR p."billingBusinessKind" NOT IN ('EXEMPT_DEALER', 'AUTHORIZED_DEALER', 'LTD_COMPANY')
     OR length(btrim(coalesce(p."billingLegalName", ''))) < 2
     OR length(btrim(coalesce(p."billingAddress", ''))) < 2
     OR length(btrim(coalesce(p."billingPhone", ''))) < 7
     OR length(btrim(coalesce(p."billingEmail", ''))) < 3
     OR p."billingTaxId" IS NULL THEN
    RETURN 'INCOMPLETE';
  END IF;
  IF NOT public.legal_identity_tax_id_ok(p."billingTaxId") THEN RETURN 'INVALID_TAX_ID'; END IF;
  UPDATE public."BusinessProfile"
     SET "legalIdentityConfirmedAt" = now(), "legalIdentitySource" = 'OWNER_CONFIRMED', "updatedAt" = now()
   WHERE "id" = p."id";
  RETURN 'CONFIRMED';
END
$fn$;
REVOKE ALL ON FUNCTION public.legal_identity_confirm_existing(integer) FROM PUBLIC;

-- ---------------------------------------------------------------- the lock
-- SECURITY INVOKER on purpose: it must see WHO writes. The owner (migrations and the definer functions above) passes.
CREATE OR REPLACE FUNCTION public.legal_identity_lock()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."legalIdentityConfirmedAt" IS NOT NULL OR NEW."legalIdentitySource" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'DZL03', MESSAGE = 'LEGAL_IDENTITY_STATE_IS_SERVER_OWNED';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."legalIdentityConfirmedAt" IS DISTINCT FROM OLD."legalIdentityConfirmedAt"
     OR NEW."legalIdentitySource" IS DISTINCT FROM OLD."legalIdentitySource" THEN
    RAISE EXCEPTION USING ERRCODE = 'DZL03', MESSAGE = 'LEGAL_IDENTITY_STATE_IS_SERVER_OWNED';
  END IF;
  IF OLD."legalIdentityConfirmedAt" IS NULL THEN
    RETURN NEW;                                -- not confirmed: an existing business edits its details as today
  END IF;
  IF (NEW."billingBusinessKind" IS DISTINCT FROM OLD."billingBusinessKind"
      OR NEW."billingLegalName" IS DISTINCT FROM OLD."billingLegalName"
      OR NEW."billingTaxId" IS DISTINCT FROM OLD."billingTaxId")
     AND NOT public.legal_identity_business_is_being_deleted(NEW."businessId") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZL04', MESSAGE = 'LEGAL_IDENTITY_LOCKED';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.legal_identity_lock() FROM PUBLIC;

CREATE TRIGGER "BusinessProfile_legal_identity_lock"
  BEFORE UPDATE OF "billingBusinessKind", "billingLegalName", "billingTaxId",
                   "legalIdentityConfirmedAt", "legalIdentitySource" ON "BusinessProfile"
  FOR EACH ROW EXECUTE FUNCTION public.legal_identity_lock();
CREATE TRIGGER "BusinessProfile_legal_identity_insert"
  BEFORE INSERT ON "BusinessProfile"
  FOR EACH ROW EXECUTE FUNCTION public.legal_identity_lock();

-- No DELETE guard: the runtime holds no DELETE on "BusinessProfile" (20260915120000), and the account purge clears
-- columns rather than deleting the row. The lab proves the runtime's DELETE is refused.

-- ---------------------------------------------------------------- privileges (minimal)
-- The owner's DEFAULT PRIVILEGES may hand new functions to the application roles: take everything back first, then
-- grant exactly what each plane needs. The INVOKER trigger calls the deletion helper as the writer, so the runtime
-- needs EXECUTE on it (it answers only yes/no about the business). app_auth gets the seed and nothing else;
-- app_runtime gets the completion and nothing that writes an identity value.
REVOKE ALL ON FUNCTION public.legal_identity_tax_id_ok(text) FROM app_runtime, app_auth;
REVOKE ALL ON FUNCTION public.legal_identity_business_is_being_deleted(integer) FROM app_runtime, app_auth;
REVOKE ALL ON FUNCTION public.signup_legal_identity_seed(integer, text, text, text, text, text, text) FROM app_runtime, app_auth;
REVOKE ALL ON FUNCTION public.legal_identity_confirm_existing(integer) FROM app_runtime, app_auth;
REVOKE ALL ON FUNCTION public.legal_identity_lock() FROM app_runtime, app_auth;
GRANT EXECUTE ON FUNCTION public.legal_identity_business_is_being_deleted(integer) TO app_runtime;
GRANT EXECUTE ON FUNCTION public.signup_legal_identity_seed(integer, text, text, text, text, text, text) TO app_auth;
GRANT EXECUTE ON FUNCTION public.legal_identity_confirm_existing(integer) TO app_runtime;
