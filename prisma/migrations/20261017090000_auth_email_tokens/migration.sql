-- Auth email tokens — email verification and password reset (migration only)
--
-- WHAT THIS ADDS
--   "User"."emailVerifiedAt": when the owner of the account proved control of its address. NULL for every
--   existing user (no backfill): an unverified address is a state the product shows, never a lock-out.
--
--   "AuthEmailToken": one row per single-use link Dubiz emails to an account — EMAIL_VERIFY (24h) or
--   PASSWORD_RESET (1h). The row holds only sha256(secret): the secret itself is never stored anywhere in
--   the database (the application derives it from a server key and the token id when it renders the email),
--   so a read of this table or of the email outbox cannot be replayed as a link.
--
--   Four SECURITY DEFINER functions are the ONLY way the auth plane reaches the table:
--     auth_email_token_issue          — mint a token for a user (invalidates that user's earlier open
--                                       tokens of the same purpose; at most 5 per user, purpose and hour;
--                                       nothing for a business in deletion or an already verified address);
--     auth_email_token_check          — the status of a link the caller holds (VALID / EXPIRED / USED /
--                                       SUPERSEDED / INVALID), no change;
--     auth_email_verify_consume       — spend an EMAIL_VERIFY link: stamps emailVerifiedAt;
--     auth_password_reset_consume     — spend a PASSWORD_RESET link: sets the new bcrypt hash, bumps
--                                       tokenVersion (every access token dies), revokes every refresh
--                                       session, closes the user's other reset links, and stamps
--                                       emailVerifiedAt (the reset proved control of the address).
--   Each verifies the secret against the stored hash, the purpose, the expiry, single use, that the user's
--   address is still the one the link was sent to, and that the business is not being deleted — under a
--   row lock, in the database, atomically with its effect.
--
-- WHO MAY DO WHAT (FORCE RLS on AuthEmailToken)
--   app_auth    — EXECUTE on the four functions, and SELECT on "User"."emailVerifiedAt". NOTHING on the
--                 table itself, and still no UPDATE on "User"."password": the auth plane may change a
--                 password only by presenting a valid, unexpired, unused reset link to
--                 auth_password_reset_consume (20260908180000 kept that column out of its reach on
--                 purpose; this keeps that property for every other path).
--   app_runtime — account erasure ONLY: DELETE, and SELECT on (id, businessId), both bound by RLS to
--                 app.current_business_id. Never the hash, the address or any timestamp.
--   the migration role (owner of table and functions) — per-command policies, so the definer functions
--                 keep working under FORCE whether or not the owner carries BYPASSRLS.
--   PUBLIC      — nothing on the table, nothing on the functions.
--
-- WHAT IT DELIBERATELY DOES NOT ADD
--   no change to any existing grant, policy or column; no backfill; no catch-all policy; no DELETE for
--   app_auth; no password column privilege for anyone who did not already hold it.
--
-- Additive only.

-- ── The verified-address column ────────────────────────────────────────────────────────────────

ALTER TABLE "User" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);

-- ── The token table ────────────────────────────────────────────────────────────────────────────

CREATE TABLE "AuthEmailToken" (
  "id" UUID NOT NULL,
  "userId" INTEGER NOT NULL,
  "businessId" INTEGER NOT NULL,
  "purpose" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "invalidatedAt" TIMESTAMP(3),

  CONSTRAINT "AuthEmailToken_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AuthEmailToken_purpose" CHECK ("purpose" IN ('EMAIL_VERIFY', 'PASSWORD_RESET')),
  CONSTRAINT "AuthEmailToken_token_hash" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "AuthEmailToken_email" CHECK (char_length("email") BETWEEN 3 AND 320 AND position('@' IN "email") > 1),
  CONSTRAINT "AuthEmailToken_lifetime" CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + interval '24 hours'),
  CONSTRAINT "AuthEmailToken_single_end" CHECK ("consumedAt" IS NULL OR "invalidatedAt" IS NULL)
);

CREATE UNIQUE INDEX "AuthEmailToken_tokenHash_key" ON "AuthEmailToken"("tokenHash");
-- Issuance: the user's open tokens of a purpose, and the per-hour ceiling.
CREATE INDEX "AuthEmailToken_userId_purpose_createdAt_idx" ON "AuthEmailToken"("userId", "purpose", "createdAt");
-- Tenant-led: the erasure delete and the runtime policies key on it.
CREATE INDEX "AuthEmailToken_businessId_idx" ON "AuthEmailToken"("businessId");

ALTER TABLE "AuthEmailToken" ADD CONSTRAINT "AuthEmailToken_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuthEmailToken" ADD CONSTRAINT "AuthEmailToken_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Row-level security ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "AuthEmailToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuthEmailToken" FORCE ROW LEVEL SECURITY;

-- The definer functions run as the migration role. Named per command, never FOR ALL, and no DELETE:
-- a token leaves only by cascade (User / Business) or by the tenant erasure below.
CREATE POLICY auth_email_token_owner_select ON "AuthEmailToken" FOR SELECT TO CURRENT_USER
  USING (true);
CREATE POLICY auth_email_token_owner_insert ON "AuthEmailToken" FOR INSERT TO CURRENT_USER
  WITH CHECK (true);
CREATE POLICY auth_email_token_owner_update ON "AuthEmailToken" FOR UPDATE TO CURRENT_USER
  USING (true)
  WITH CHECK (true);

-- Tenant plane: account erasure only, and only inside the tenant being erased.
CREATE POLICY auth_email_token_runtime_select ON "AuthEmailToken" FOR SELECT TO app_runtime
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

CREATE POLICY auth_email_token_runtime_delete ON "AuthEmailToken" FOR DELETE TO app_runtime
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── Privileges, named explicitly ───────────────────────────────────────────────────────────────

REVOKE ALL ON "AuthEmailToken" FROM PUBLIC;
REVOKE ALL ON "AuthEmailToken" FROM app_runtime;
REVOKE ALL ON "AuthEmailToken" FROM app_auth;
GRANT SELECT ("id", "businessId") ON "AuthEmailToken" TO app_runtime;
GRANT DELETE ON "AuthEmailToken" TO app_runtime;

GRANT SELECT ("emailVerifiedAt") ON "User" TO app_auth;

-- ── The functions ──────────────────────────────────────────────────────────────────────────────
-- Timestamps are UTC wall-clock, exactly as Prisma writes TIMESTAMP(3).

CREATE OR REPLACE FUNCTION public.auth_email_token_issue(
  p_user_id integer, p_purpose text, p_token_id uuid, p_token_hash text
)
RETURNS TABLE (token_id uuid, business_id integer, email text, expires_at timestamp(3))
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
#variable_conflict use_column
DECLARE
  v_now timestamp(3) := timezone('UTC', now());
  v_user record;
  v_recent integer;
  v_expires timestamp(3);
BEGIN
  IF p_purpose IS NULL OR p_purpose NOT IN ('EMAIL_VERIFY', 'PASSWORD_RESET') THEN
    RAISE EXCEPTION 'auth_email_token_issue: unknown purpose' USING ERRCODE = '22023';
  END IF;
  IF p_token_id IS NULL OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'auth_email_token_issue: malformed token' USING ERRCODE = '22023';
  END IF;

  -- One issuance per user at a time: the ceiling and the invalidation below cannot be raced.
  SELECT u."id", u."email", u."businessId", u."emailVerifiedAt", b."deletionRequestedAt", b."deletedAt"
    INTO v_user
    FROM public."User" u
    JOIN public."Business" b ON b."id" = u."businessId"
   WHERE u."id" = p_user_id
     FOR UPDATE OF u;

  IF NOT FOUND OR v_user."deletionRequestedAt" IS NOT NULL OR v_user."deletedAt" IS NOT NULL THEN
    RETURN;
  END IF;
  IF p_purpose = 'EMAIL_VERIFY' AND v_user."emailVerifiedAt" IS NOT NULL THEN
    RETURN;
  END IF;

  SELECT count(*) INTO v_recent
    FROM public."AuthEmailToken" t
   WHERE t."userId" = p_user_id AND t."purpose" = p_purpose AND t."createdAt" > v_now - interval '1 hour';
  IF v_recent >= 5 THEN
    RETURN;
  END IF;

  UPDATE public."AuthEmailToken" t
     SET "invalidatedAt" = v_now
   WHERE t."userId" = p_user_id AND t."purpose" = p_purpose
     AND t."consumedAt" IS NULL AND t."invalidatedAt" IS NULL;

  v_expires := v_now + CASE p_purpose WHEN 'EMAIL_VERIFY' THEN interval '24 hours' ELSE interval '1 hour' END;

  INSERT INTO public."AuthEmailToken"
    ("id", "userId", "businessId", "purpose", "email", "tokenHash", "createdAt", "expiresAt")
  VALUES
    (p_token_id, v_user."id", v_user."businessId", p_purpose, v_user."email", p_token_hash, v_now, v_expires);

  token_id := p_token_id;
  business_id := v_user."businessId";
  email := v_user."email";
  expires_at := v_expires;
  RETURN NEXT;
END
$fn$;

CREATE OR REPLACE FUNCTION public.auth_email_token_check(p_token_id uuid, p_secret text, p_purpose text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
#variable_conflict use_column
DECLARE
  v_now timestamp(3) := timezone('UTC', now());
  v_tok record;
BEGIN
  IF p_token_id IS NULL OR p_secret IS NULL OR char_length(p_secret) > 200 THEN
    RETURN 'INVALID';
  END IF;
  SELECT t.*, u."email" AS "userEmail", b."deletionRequestedAt", b."deletedAt"
    INTO v_tok
    FROM public."AuthEmailToken" t
    JOIN public."User" u ON u."id" = t."userId"
    JOIN public."Business" b ON b."id" = u."businessId"
   WHERE t."id" = p_token_id;
  IF NOT FOUND
     OR v_tok."purpose" IS DISTINCT FROM p_purpose
     OR v_tok."tokenHash" <> encode(sha256(convert_to(p_secret, 'UTF8')), 'hex')
     OR v_tok."userEmail" IS DISTINCT FROM v_tok."email"
     OR v_tok."deletionRequestedAt" IS NOT NULL OR v_tok."deletedAt" IS NOT NULL THEN
    RETURN 'INVALID';
  END IF;
  IF v_tok."consumedAt" IS NOT NULL THEN RETURN 'USED'; END IF;
  IF v_tok."invalidatedAt" IS NOT NULL THEN RETURN 'SUPERSEDED'; END IF;
  IF v_tok."expiresAt" <= v_now THEN RETURN 'EXPIRED'; END IF;
  RETURN 'VALID';
END
$fn$;

CREATE OR REPLACE FUNCTION public.auth_email_verify_consume(p_token_id uuid, p_secret text)
RETURNS TABLE (status text, user_id integer, business_id integer)
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
  status := 'INVALID';
  IF p_token_id IS NULL OR p_secret IS NULL OR char_length(p_secret) > 200 THEN
    RETURN NEXT; RETURN;
  END IF;
  SELECT t.*, u."email" AS "userEmail", b."deletionRequestedAt", b."deletedAt"
    INTO v_tok
    FROM public."AuthEmailToken" t
    JOIN public."User" u ON u."id" = t."userId"
    JOIN public."Business" b ON b."id" = u."businessId"
   WHERE t."id" = p_token_id
     FOR UPDATE OF t, u;
  IF NOT FOUND
     OR v_tok."purpose" <> 'EMAIL_VERIFY'
     OR v_tok."tokenHash" <> encode(sha256(convert_to(p_secret, 'UTF8')), 'hex')
     OR v_tok."userEmail" IS DISTINCT FROM v_tok."email"
     OR v_tok."deletionRequestedAt" IS NOT NULL OR v_tok."deletedAt" IS NOT NULL THEN
    RETURN NEXT; RETURN;
  END IF;
  IF v_tok."consumedAt" IS NOT NULL THEN status := 'USED'; RETURN NEXT; RETURN; END IF;
  IF v_tok."invalidatedAt" IS NOT NULL THEN status := 'SUPERSEDED'; RETURN NEXT; RETURN; END IF;
  IF v_tok."expiresAt" <= v_now THEN status := 'EXPIRED'; RETURN NEXT; RETURN; END IF;

  UPDATE public."AuthEmailToken" SET "consumedAt" = v_now WHERE "id" = p_token_id;
  UPDATE public."User"
     SET "emailVerifiedAt" = COALESCE("emailVerifiedAt", v_now)
   WHERE "id" = v_tok."userId";

  status := 'VERIFIED';
  user_id := v_tok."userId";
  business_id := v_tok."businessId";
  RETURN NEXT;
END
$fn$;

CREATE OR REPLACE FUNCTION public.auth_password_reset_consume(p_token_id uuid, p_secret text, p_password_hash text)
RETURNS TABLE (status text, user_id integer)
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
  -- A bcrypt hash and nothing else: the plain password never reaches the database.
  IF p_password_hash IS NULL OR p_password_hash !~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$' THEN
    RAISE EXCEPTION 'auth_password_reset_consume: not a bcrypt hash' USING ERRCODE = '22023';
  END IF;
  status := 'INVALID';
  IF p_token_id IS NULL OR p_secret IS NULL OR char_length(p_secret) > 200 THEN
    RETURN NEXT; RETURN;
  END IF;
  SELECT t.*, u."email" AS "userEmail", b."deletionRequestedAt", b."deletedAt"
    INTO v_tok
    FROM public."AuthEmailToken" t
    JOIN public."User" u ON u."id" = t."userId"
    JOIN public."Business" b ON b."id" = u."businessId"
   WHERE t."id" = p_token_id
     FOR UPDATE OF t, u;
  IF NOT FOUND
     OR v_tok."purpose" <> 'PASSWORD_RESET'
     OR v_tok."tokenHash" <> encode(sha256(convert_to(p_secret, 'UTF8')), 'hex')
     OR v_tok."userEmail" IS DISTINCT FROM v_tok."email"
     OR v_tok."deletionRequestedAt" IS NOT NULL OR v_tok."deletedAt" IS NOT NULL THEN
    RETURN NEXT; RETURN;
  END IF;
  IF v_tok."consumedAt" IS NOT NULL THEN status := 'USED'; RETURN NEXT; RETURN; END IF;
  IF v_tok."invalidatedAt" IS NOT NULL THEN status := 'SUPERSEDED'; RETURN NEXT; RETURN; END IF;
  IF v_tok."expiresAt" <= v_now THEN status := 'EXPIRED'; RETURN NEXT; RETURN; END IF;

  UPDATE public."AuthEmailToken" SET "consumedAt" = v_now WHERE "id" = p_token_id;
  UPDATE public."AuthEmailToken"
     SET "invalidatedAt" = v_now
   WHERE "userId" = v_tok."userId" AND "purpose" = 'PASSWORD_RESET'
     AND "consumedAt" IS NULL AND "invalidatedAt" IS NULL;
  UPDATE public."User"
     SET "password" = p_password_hash,
         "tokenVersion" = "tokenVersion" + 1,
         "emailVerifiedAt" = COALESCE("emailVerifiedAt", v_now),
         "updatedAt" = v_now
   WHERE "id" = v_tok."userId";
  UPDATE public."AuthSession"
     SET "revokedAt" = v_now, "revokedReason" = 'password_reset'
   WHERE "userId" = v_tok."userId" AND "revokedAt" IS NULL;

  status := 'RESET';
  user_id := v_tok."userId";
  RETURN NEXT;
END
$fn$;

REVOKE ALL ON FUNCTION public.auth_email_token_issue(integer, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_email_token_issue(integer, text, uuid, text) FROM app_runtime;
REVOKE ALL ON FUNCTION public.auth_email_token_check(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_email_token_check(uuid, text, text) FROM app_runtime;
REVOKE ALL ON FUNCTION public.auth_email_verify_consume(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_email_verify_consume(uuid, text) FROM app_runtime;
REVOKE ALL ON FUNCTION public.auth_password_reset_consume(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_password_reset_consume(uuid, text, text) FROM app_runtime;

GRANT EXECUTE ON FUNCTION public.auth_email_token_issue(integer, text, uuid, text) TO app_auth;
GRANT EXECUTE ON FUNCTION public.auth_email_token_check(uuid, text, text) TO app_auth;
GRANT EXECUTE ON FUNCTION public.auth_email_verify_consume(uuid, text) TO app_auth;
GRANT EXECUTE ON FUNCTION public.auth_password_reset_consume(uuid, text, text) TO app_auth;
