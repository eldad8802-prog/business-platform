-- OAuth identity foundation — "Continue with Google", milestone 1 (migration only)
--
-- WHY IT IS SHAPED THIS WAY
--   Signing in with Google proves WHO a person is. It is not a Dubiz signup: a new person still completes
--   the existing signup (business name, terms) before any User, Business or AuthSession exists. Between
--   the Google callback and that completion the server holds exactly one thing — a single-use SIGNUP
--   TICKET — and nothing that could authenticate a request.
--
-- WHAT THIS ADDS
--   "User"."password" becomes NULL-able: an account opened with Google has no local password until its
--   owner sets one (the existing reset link sets it). Every existing row keeps its hash; nothing is
--   backfilled; no grant on the column changes.
--
--   "OAuthSignupTicket": one row per ticket the callback issues. It holds sha256(secret) only — the secret
--   lives in the visitor's httpOnly cookie and is never stored. A ticket lives at most 30 minutes, is
--   spent at most once, and a newer ticket for the same Google subject and purpose closes the older one.
--
--   "UserIdentity": the link between a Dubiz user and a Google subject (`sub`). One subject → one user,
--   one user → one Google identity. The link is written only by spending a SIGNUP ticket inside the very
--   transaction that creates the account.
--
--   Six SECURITY DEFINER functions are the ONLY way the auth plane reaches either table:
--     auth_oauth_ticket_issue     — mint a ticket (SIGNUP needs a provider-verified address and an unlinked
--                                   subject; closes the subject's earlier open tickets of the purpose;
--                                   at most 10 per subject and hour);
--     auth_oauth_ticket_read      — what the completion form may show (address, name, expiry) of an open
--                                   ticket the caller holds; no change;
--     auth_oauth_ticket_consume   — spend a ticket: ONE conditional UPDATE under the row lock. A second
--                                   spend of the same ticket — sequential or concurrent — finds it spent
--                                   and gets no row. Marks the transaction as the one that spent it;
--     auth_oauth_identity_attach  — inside THAT transaction only: link the subject to the user the
--                                   transaction just created (same address, no password, no identity yet,
--                                   business not in deletion) and stamp emailVerifiedAt;
--     auth_oauth_identity_resolve — the user a linked subject belongs to (and its last use);
--     auth_oauth_ticket_purge     — remove expired tickets (the sweep).
--   Rolling back the transaction that spent a ticket rolls the spend back with it: nothing half-done can
--   remain, and still only one transaction can ever complete with a given ticket.
--
-- WHO MAY DO WHAT (FORCE RLS on both tables)
--   app_auth    — EXECUTE on the six functions. NOTHING on either table, and still no UPDATE on
--                 "User"."password" or "User"."emailVerifiedAt".
--   app_runtime — account erasure of identities ONLY: DELETE, and SELECT on (id, businessId), both bound
--                 by RLS to app.current_business_id. Never the subject or the address. Nothing on tickets
--                 (a ticket belongs to no business; it expires within 30 minutes and the sweep removes it).
--   the migration role (owner of tables and functions) — the definer functions run as it. It carries
--                 BYPASSRLS in Production (the preflight requires it), so FORCE binds every application role.
--   PUBLIC      — nothing on the tables, nothing on the functions.
--
-- WHAT IT DELIBERATELY DOES NOT ADD
--   no change to any existing grant or policy; no backfill; no catch-all policy; no LINK attach (linking an
--   existing account needs proof of ownership and ships with milestone 3 and its own migration); no route,
--   no flag, no user-visible change.
--
-- Additive, apart from relaxing one NOT NULL.

-- ── The optional password ──────────────────────────────────────────────────────────────────────

ALTER TABLE "User" ALTER COLUMN "password" DROP NOT NULL;

-- ── The identity table ─────────────────────────────────────────────────────────────────────────

CREATE TABLE "UserIdentity" (
  "id" SERIAL NOT NULL,
  "userId" INTEGER NOT NULL,
  "businessId" INTEGER NOT NULL,
  "provider" TEXT NOT NULL,
  "providerSubject" TEXT NOT NULL,
  "emailAtLink" TEXT NOT NULL,
  "linkedAt" TIMESTAMP(3) NOT NULL,
  "lastUsedAt" TIMESTAMP(3),

  CONSTRAINT "UserIdentity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UserIdentity_provider" CHECK ("provider" IN ('google')),
  CONSTRAINT "UserIdentity_subject" CHECK (char_length("providerSubject") BETWEEN 1 AND 255),
  CONSTRAINT "UserIdentity_email" CHECK (char_length("emailAtLink") BETWEEN 3 AND 320 AND position('@' IN "emailAtLink") > 1)
);

CREATE UNIQUE INDEX "UserIdentity_provider_providerSubject_key" ON "UserIdentity"("provider", "providerSubject");
CREATE UNIQUE INDEX "UserIdentity_userId_provider_key" ON "UserIdentity"("userId", "provider");
-- Tenant-led: the erasure delete and the runtime policies key on it.
CREATE INDEX "UserIdentity_businessId_idx" ON "UserIdentity"("businessId");

ALTER TABLE "UserIdentity" ADD CONSTRAINT "UserIdentity_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserIdentity" ADD CONSTRAINT "UserIdentity_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── The ticket table ───────────────────────────────────────────────────────────────────────────

CREATE TABLE "OAuthSignupTicket" (
  "id" UUID NOT NULL,
  "purpose" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerSubject" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "name" TEXT,
  "emailVerified" BOOLEAN NOT NULL,
  "secretHash" TEXT NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "endedAt" TIMESTAMP(3),
  "endedReason" TEXT,
  "consumedByUserId" INTEGER,

  CONSTRAINT "OAuthSignupTicket_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OAuthSignupTicket_purpose" CHECK ("purpose" IN ('SIGNUP', 'LINK')),
  CONSTRAINT "OAuthSignupTicket_provider" CHECK ("provider" IN ('google')),
  CONSTRAINT "OAuthSignupTicket_subject" CHECK (char_length("providerSubject") BETWEEN 1 AND 255),
  CONSTRAINT "OAuthSignupTicket_email" CHECK (char_length("email") BETWEEN 3 AND 320 AND position('@' IN "email") > 1),
  CONSTRAINT "OAuthSignupTicket_name" CHECK ("name" IS NULL OR char_length("name") <= 200),
  CONSTRAINT "OAuthSignupTicket_secret_hash" CHECK ("secretHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "OAuthSignupTicket_lifetime" CHECK ("expiresAt" > "issuedAt" AND "expiresAt" <= "issuedAt" + interval '30 minutes'),
  CONSTRAINT "OAuthSignupTicket_end" CHECK (("endedAt" IS NULL) = ("endedReason" IS NULL)
    AND ("endedReason" IS NULL OR "endedReason" IN ('CONSUMED', 'SUPERSEDED'))),
  CONSTRAINT "OAuthSignupTicket_consumer" CHECK ("consumedByUserId" IS NULL OR "endedReason" = 'CONSUMED')
);

CREATE UNIQUE INDEX "OAuthSignupTicket_secretHash_key" ON "OAuthSignupTicket"("secretHash");
-- Issuance: the subject's open tickets of a purpose, and the per-hour ceiling.
CREATE INDEX "OAuthSignupTicket_provider_providerSubject_purpose_issuedAt_idx"
  ON "OAuthSignupTicket"("provider", "providerSubject", "purpose", "issuedAt");
-- The sweep.
CREATE INDEX "OAuthSignupTicket_expiresAt_idx" ON "OAuthSignupTicket"("expiresAt");

ALTER TABLE "OAuthSignupTicket" ADD CONSTRAINT "OAuthSignupTicket_consumedByUserId_fkey"
  FOREIGN KEY ("consumedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Row-level security ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "UserIdentity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UserIdentity" FORCE ROW LEVEL SECURITY;
ALTER TABLE "OAuthSignupTicket" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OAuthSignupTicket" FORCE ROW LEVEL SECURITY;

-- No policy for app_auth: it holds no privilege on either table. No policy at all on tickets.
-- Tenant plane: identity erasure only, and only inside the tenant being erased.
CREATE POLICY user_identity_runtime_select ON "UserIdentity" FOR SELECT TO app_runtime
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

CREATE POLICY user_identity_runtime_delete ON "UserIdentity" FOR DELETE TO app_runtime
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── Privileges, named explicitly ───────────────────────────────────────────────────────────────
-- The migration role's default privileges hand app_runtime arwd on every new table: taken back here.

REVOKE ALL ON "UserIdentity" FROM PUBLIC;
REVOKE ALL ON "UserIdentity" FROM app_runtime;
REVOKE ALL ON "UserIdentity" FROM app_auth;
GRANT SELECT ("id", "businessId") ON "UserIdentity" TO app_runtime;
GRANT DELETE ON "UserIdentity" TO app_runtime;

REVOKE ALL ON "OAuthSignupTicket" FROM PUBLIC;
REVOKE ALL ON "OAuthSignupTicket" FROM app_runtime;
REVOKE ALL ON "OAuthSignupTicket" FROM app_auth;

REVOKE ALL ON SEQUENCE "UserIdentity_id_seq" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "UserIdentity_id_seq" FROM app_runtime;
REVOKE ALL ON SEQUENCE "UserIdentity_id_seq" FROM app_auth;

-- ── The functions ──────────────────────────────────────────────────────────────────────────────
-- Timestamps are UTC wall-clock, exactly as Prisma writes TIMESTAMP(3). now() is the transaction's start,
-- so every timestamp one transaction writes is the same instant — attach relies on that.

CREATE OR REPLACE FUNCTION public.auth_oauth_ticket_issue(
  p_purpose text, p_provider text, p_subject text, p_email text, p_name text, p_email_verified boolean,
  p_secret_hash text
)
RETURNS TABLE (ticket_id uuid, expires_at timestamp(3))
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
#variable_conflict use_column
DECLARE
  v_now timestamp(3) := timezone('UTC', now());
  v_recent integer;
  v_id uuid := gen_random_uuid();
  v_expires timestamp(3) := timezone('UTC', now()) + interval '30 minutes';
BEGIN
  IF p_purpose IS NULL OR p_purpose NOT IN ('SIGNUP', 'LINK') THEN
    RAISE EXCEPTION 'auth_oauth_ticket_issue: unknown purpose' USING ERRCODE = '22023';
  END IF;
  IF p_provider IS NULL OR p_provider NOT IN ('google') THEN
    RAISE EXCEPTION 'auth_oauth_ticket_issue: unknown provider' USING ERRCODE = '22023';
  END IF;
  IF p_subject IS NULL OR char_length(p_subject) NOT BETWEEN 1 AND 255
     OR p_email IS NULL OR p_email <> lower(btrim(p_email)) OR char_length(p_email) NOT BETWEEN 3 AND 320
     OR position('@' IN p_email) <= 1
     OR (p_name IS NOT NULL AND char_length(p_name) > 200)
     OR p_email_verified IS NULL
     OR p_secret_hash IS NULL OR p_secret_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'auth_oauth_ticket_issue: malformed ticket' USING ERRCODE = '22023';
  END IF;

  -- A signup opens with an address the provider verified, never otherwise.
  IF p_purpose = 'SIGNUP' AND NOT p_email_verified THEN
    RETURN;
  END IF;

  -- One issuance per subject at a time: the ceiling and the supersede below cannot be raced.
  PERFORM pg_advisory_xact_lock(hashtextextended('oauth_ticket:' || p_provider || ':' || p_subject, 0));

  -- A subject already linked signs in; it never opens a second signup.
  IF p_purpose = 'SIGNUP' AND EXISTS (
    SELECT 1 FROM public."UserIdentity" i WHERE i."provider" = p_provider AND i."providerSubject" = p_subject
  ) THEN
    RETURN;
  END IF;

  SELECT count(*) INTO v_recent
    FROM public."OAuthSignupTicket" t
   WHERE t."provider" = p_provider AND t."providerSubject" = p_subject AND t."issuedAt" > v_now - interval '1 hour';
  IF v_recent >= 10 THEN
    RETURN;
  END IF;

  UPDATE public."OAuthSignupTicket" t
     SET "endedAt" = v_now, "endedReason" = 'SUPERSEDED'
   WHERE t."provider" = p_provider AND t."providerSubject" = p_subject AND t."purpose" = p_purpose
     AND t."endedAt" IS NULL;

  INSERT INTO public."OAuthSignupTicket"
    ("id", "purpose", "provider", "providerSubject", "email", "name", "emailVerified", "secretHash", "issuedAt", "expiresAt")
  VALUES
    (v_id, p_purpose, p_provider, p_subject, p_email, p_name, p_email_verified, p_secret_hash, v_now, v_expires);

  ticket_id := v_id;
  expires_at := v_expires;
  RETURN NEXT;
END
$fn$;

CREATE OR REPLACE FUNCTION public.auth_oauth_ticket_read(p_secret text, p_purpose text)
RETURNS TABLE (ticket_id uuid, email text, name text, expires_at timestamp(3))
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
#variable_conflict use_column
DECLARE
  v_now timestamp(3) := timezone('UTC', now());
BEGIN
  IF p_secret IS NULL OR char_length(p_secret) > 200 THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT t."id", t."email", t."name", t."expiresAt"
      FROM public."OAuthSignupTicket" t
     WHERE t."secretHash" = encode(sha256(convert_to(p_secret, 'UTF8')), 'hex')
       AND t."purpose" = p_purpose
       AND t."endedAt" IS NULL
       AND t."expiresAt" > v_now
       AND NOT EXISTS (SELECT 1 FROM public."UserIdentity" i
                        WHERE i."provider" = t."provider" AND i."providerSubject" = t."providerSubject");
END
$fn$;

CREATE OR REPLACE FUNCTION public.auth_oauth_ticket_consume(p_secret text, p_purpose text)
RETURNS TABLE (ticket_id uuid, provider text, provider_subject text, email text, name text, email_verified boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
#variable_conflict use_column
DECLARE
  v_now timestamp(3) := timezone('UTC', now());
  v_tok record;
BEGIN
  IF p_secret IS NULL OR char_length(p_secret) > 200 THEN
    RETURN;
  END IF;
  -- The whole single-use guarantee is this one statement. It takes the row lock; a concurrent spend of the
  -- same ticket waits on it and, once this transaction commits, re-reads the row, finds "endedAt" set and
  -- updates nothing. If this transaction rolls back, the ticket is open again — for one spender only.
  UPDATE public."OAuthSignupTicket" t
     SET "endedAt" = v_now, "endedReason" = 'CONSUMED'
   WHERE t."secretHash" = encode(sha256(convert_to(p_secret, 'UTF8')), 'hex')
     AND t."purpose" = p_purpose
     AND t."endedAt" IS NULL
     AND t."expiresAt" > v_now
     AND NOT (t."purpose" = 'SIGNUP' AND EXISTS (
       SELECT 1 FROM public."UserIdentity" i WHERE i."provider" = t."provider" AND i."providerSubject" = t."providerSubject"))
  RETURNING t."id", t."provider", t."providerSubject", t."email", t."name", t."emailVerified" INTO v_tok;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  -- Which transaction spent it: attach accepts only this one.
  PERFORM set_config('app.oauth_ticket_spent', v_tok."id"::text, true);
  ticket_id := v_tok."id";
  provider := v_tok."provider";
  provider_subject := v_tok."providerSubject";
  email := v_tok."email";
  name := v_tok."name";
  email_verified := v_tok."emailVerified";
  RETURN NEXT;
END
$fn$;

CREATE OR REPLACE FUNCTION public.auth_oauth_identity_attach(p_ticket_id uuid, p_user_id integer)
RETURNS TABLE (identity_id integer, email_verified_at timestamp(3))
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
#variable_conflict use_column
DECLARE
  v_now timestamp(3) := timezone('UTC', now());
  v_tok record;
  v_user record;
  v_identity integer;
  v_verified timestamp(3);
BEGIN
  IF p_ticket_id IS NULL OR p_user_id IS NULL
     OR current_setting('app.oauth_ticket_spent', true) IS DISTINCT FROM p_ticket_id::text THEN
    RAISE EXCEPTION 'auth_oauth_identity_attach: the ticket was not spent in this transaction' USING ERRCODE = '22023';
  END IF;

  -- Spent by THIS transaction (its "endedAt" is this transaction's instant), for a signup, not attached yet.
  SELECT t.* INTO v_tok
    FROM public."OAuthSignupTicket" t
   WHERE t."id" = p_ticket_id AND t."purpose" = 'SIGNUP' AND t."endedReason" = 'CONSUMED'
     AND t."endedAt" = v_now AND t."consumedByUserId" IS NULL
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'auth_oauth_identity_attach: the ticket was not spent in this transaction' USING ERRCODE = '22023';
  END IF;

  -- The account this signup just created: the ticket's address, no password, no identity, business alive.
  SELECT u."id", u."email", u."password", u."businessId", b."deletionRequestedAt", b."deletedAt"
    INTO v_user
    FROM public."User" u
    JOIN public."Business" b ON b."id" = u."businessId"
   WHERE u."id" = p_user_id
     FOR UPDATE OF u;
  IF NOT FOUND
     OR v_user."email" IS DISTINCT FROM v_tok."email"
     OR v_user."password" IS NOT NULL
     OR v_user."deletionRequestedAt" IS NOT NULL OR v_user."deletedAt" IS NOT NULL
     OR EXISTS (SELECT 1 FROM public."UserIdentity" i WHERE i."userId" = p_user_id) THEN
    RAISE EXCEPTION 'auth_oauth_identity_attach: not the account this signup created' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public."UserIdentity" ("userId", "businessId", "provider", "providerSubject", "emailAtLink", "linkedAt")
  VALUES (p_user_id, v_user."businessId", v_tok."provider", v_tok."providerSubject", v_tok."email", v_now)
  RETURNING "id" INTO v_identity;

  UPDATE public."OAuthSignupTicket" SET "consumedByUserId" = p_user_id WHERE "id" = p_ticket_id;

  IF v_tok."emailVerified" THEN
    UPDATE public."User"
       SET "emailVerifiedAt" = COALESCE("emailVerifiedAt", v_now)
     WHERE "id" = p_user_id
    RETURNING "emailVerifiedAt" INTO v_verified;
  END IF;

  identity_id := v_identity;
  email_verified_at := v_verified;
  RETURN NEXT;
END
$fn$;

CREATE OR REPLACE FUNCTION public.auth_oauth_identity_resolve(p_provider text, p_subject text)
RETURNS TABLE (user_id integer, business_id integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
#variable_conflict use_column
DECLARE
  v_now timestamp(3) := timezone('UTC', now());
  v_row record;
BEGIN
  IF p_provider IS NULL OR p_subject IS NULL OR char_length(p_subject) NOT BETWEEN 1 AND 255 THEN
    RETURN;
  END IF;
  UPDATE public."UserIdentity" i
     SET "lastUsedAt" = v_now
   WHERE i."provider" = p_provider AND i."providerSubject" = p_subject
  RETURNING i."userId", i."businessId" INTO v_row;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  user_id := v_row."userId";
  business_id := v_row."businessId";
  RETURN NEXT;
END
$fn$;

CREATE OR REPLACE FUNCTION public.auth_oauth_ticket_purge()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_now timestamp(3) := timezone('UTC', now());
  v_count integer;
BEGIN
  DELETE FROM public."OAuthSignupTicket" t WHERE t."expiresAt" <= v_now;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$fn$;

REVOKE ALL ON FUNCTION public.auth_oauth_ticket_issue(text, text, text, text, text, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_oauth_ticket_issue(text, text, text, text, text, boolean, text) FROM app_runtime;
REVOKE ALL ON FUNCTION public.auth_oauth_ticket_read(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_oauth_ticket_read(text, text) FROM app_runtime;
REVOKE ALL ON FUNCTION public.auth_oauth_ticket_consume(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_oauth_ticket_consume(text, text) FROM app_runtime;
REVOKE ALL ON FUNCTION public.auth_oauth_identity_attach(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_oauth_identity_attach(uuid, integer) FROM app_runtime;
REVOKE ALL ON FUNCTION public.auth_oauth_identity_resolve(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_oauth_identity_resolve(text, text) FROM app_runtime;
REVOKE ALL ON FUNCTION public.auth_oauth_ticket_purge() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_oauth_ticket_purge() FROM app_runtime;

GRANT EXECUTE ON FUNCTION public.auth_oauth_ticket_issue(text, text, text, text, text, boolean, text) TO app_auth;
GRANT EXECUTE ON FUNCTION public.auth_oauth_ticket_read(text, text) TO app_auth;
GRANT EXECUTE ON FUNCTION public.auth_oauth_ticket_consume(text, text) TO app_auth;
GRANT EXECUTE ON FUNCTION public.auth_oauth_identity_attach(uuid, integer) TO app_auth;
GRANT EXECUTE ON FUNCTION public.auth_oauth_identity_resolve(text, text) TO app_auth;
GRANT EXECUTE ON FUNCTION public.auth_oauth_ticket_purge() TO app_auth;
