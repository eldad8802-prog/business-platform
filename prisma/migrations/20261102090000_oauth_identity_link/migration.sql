-- OAuth identity link — "Continue with Google", milestone 3: linking Google to an EXISTING account (migration only)
--
-- WHY IT IS SHAPED THIS WAY
--   A Google identity whose address belongs to an existing, unlinked Dubiz account is NOT that account. It
--   becomes linked only after the person proves they own the ACCOUNT — with its password, or with a
--   single-use link emailed to the account's address — and never because the addresses match. Until then
--   the server holds exactly one thing: a LINK ticket (OAuthSignupTicket, purpose LINK, migration
--   20261030090000), and nothing that could authenticate a request.
--
-- WHAT THIS ADDS
--   "AuthEmailToken" (migration 20261017090000) gains a third purpose, LINK_GOOGLE, and a column binding
--   such a token to the ONE LINK ticket it was requested under ("oauthTicketId"; cascades with the ticket,
--   so the ticket purge removes it). Only a LINK_GOOGLE token carries a ticket, and every LINK_GOOGLE
--   token carries one. Nothing else about the table, its policies or its grants changes.
--
--   Six SECURITY DEFINER functions, the only way the auth plane reaches any of it:
--     auth_oauth_link_email_issue   — for the open LINK ticket the caller holds: the account it names is
--                                     resolved HERE, from the ticket's provider-verified address (never
--                                     from the client); refused for a platform administrator, a business
--                                     in deletion, an account already linked to Google, a subject already
--                                     linked; at most 3 per ticket and 5 per account and hour; a new one
--                                     closes the account's earlier open ones; it never outlives its ticket;
--     auth_oauth_link_email_check   — the status of an emailed link, and whether THIS browser holds the
--                                     ticket it is bound to. Changes nothing (opening the link changes
--                                     nothing);
--     auth_oauth_link_email_consume — spend the emailed link, only inside the transaction that spent ITS
--                                     ticket; one conditional UPDATE under the row lock;
--     auth_oauth_identity_link      — inside that transaction only: link the ticket's Google subject to
--                                     the account, given the proof: PASSWORD (the account has one; the
--                                     application compared it under the login attempt limits) or EMAIL
--                                     (a LINK_GOOGLE token of THIS ticket and THIS account was spent in
--                                     THIS transaction). Same address, not an administrator, business
--                                     alive, no Google identity yet;
--     auth_oauth_identity_status    — an account's own Google link (for its settings), and whether it has
--                                     a password;
--     auth_oauth_identity_unlink    — remove an account's Google link, only when it has a password (it can
--                                     still sign in); the application re-authenticates the owner first.
--   Spending the ticket, the emailed link and creating the link happen in ONE transaction with the session
--   the application issues: a failure anywhere leaves nothing behind and the ticket open.
--
-- WHO MAY DO WHAT
--   app_auth    — EXECUTE on the six functions. Still NOTHING on AuthEmailToken, OAuthSignupTicket or
--                 UserIdentity themselves.
--   app_runtime — unchanged: account erasure on AuthEmailToken (DELETE, SELECT on (id, businessId)) and on
--                 UserIdentity, bound by RLS to app.current_business_id. Never the new column. Nothing on
--                 the functions.
--   PUBLIC      — nothing.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   no change to any existing function, policy or grant; no change to 20261030090000, 20261017090000 or
--   20261101090000 themselves; no backfill; no route, no flag, no user-visible change.
--
-- Additive: one vocabulary widening, one nullable column with its key and index, six functions.

-- ── AuthEmailToken: the LINK_GOOGLE purpose, bound to its ticket ────────────────────────────────

ALTER TABLE "AuthEmailToken" ADD COLUMN "oauthTicketId" UUID;

ALTER TABLE "AuthEmailToken" DROP CONSTRAINT "AuthEmailToken_purpose";
ALTER TABLE "AuthEmailToken" ADD CONSTRAINT "AuthEmailToken_purpose"
  CHECK ("purpose" IN ('EMAIL_VERIFY', 'PASSWORD_RESET', 'LINK_GOOGLE'));
ALTER TABLE "AuthEmailToken" ADD CONSTRAINT "AuthEmailToken_oauth_ticket"
  CHECK (("purpose" = 'LINK_GOOGLE') = ("oauthTicketId" IS NOT NULL));

ALTER TABLE "AuthEmailToken" ADD CONSTRAINT "AuthEmailToken_oauthTicketId_fkey"
  FOREIGN KEY ("oauthTicketId") REFERENCES "OAuthSignupTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "AuthEmailToken_oauthTicketId_idx" ON "AuthEmailToken"("oauthTicketId");

-- ── The functions ──────────────────────────────────────────────────────────────────────────────
-- Timestamps are UTC wall-clock, exactly as Prisma writes TIMESTAMP(3). now() is the transaction's start,
-- so every timestamp one transaction writes is the same instant — consume and link rely on that.

CREATE OR REPLACE FUNCTION public.auth_oauth_link_email_issue(p_ticket_secret text, p_token_id uuid, p_token_hash text)
RETURNS TABLE (token_id uuid, user_id integer, business_id integer, email text, name text, expires_at timestamp(3))
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
  v_count integer;
  v_expires timestamp(3);
BEGIN
  IF p_token_id IS NULL OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'auth_oauth_link_email_issue: malformed token' USING ERRCODE = '22023';
  END IF;
  IF p_ticket_secret IS NULL OR char_length(p_ticket_secret) > 200 THEN
    RETURN;
  END IF;

  -- The open LINK ticket the caller holds; its lock serializes every request made under it.
  SELECT t.* INTO v_tok
    FROM public."OAuthSignupTicket" t
   WHERE t."secretHash" = encode(sha256(convert_to(p_ticket_secret, 'UTF8')), 'hex')
     AND t."purpose" = 'LINK' AND t."endedAt" IS NULL AND t."expiresAt" > v_now AND t."emailVerified"
     FOR UPDATE;
  IF NOT FOUND OR EXISTS (
    SELECT 1 FROM public."UserIdentity" i WHERE i."provider" = v_tok."provider" AND i."providerSubject" = v_tok."providerSubject"
  ) THEN
    RETURN;
  END IF;

  -- The account is the one that holds the ticket's provider-verified address — resolved here, never given.
  SELECT u."id", u."email", u."name", u."businessId", u."role"::text AS "role", b."deletionRequestedAt", b."deletedAt"
    INTO v_user
    FROM public."User" u
    JOIN public."Business" b ON b."id" = u."businessId"
   WHERE u."email" = v_tok."email"
     FOR UPDATE OF u;
  IF NOT FOUND
     OR v_user."role" = 'PLATFORM_ADMIN'
     OR v_user."deletionRequestedAt" IS NOT NULL OR v_user."deletedAt" IS NOT NULL
     OR EXISTS (SELECT 1 FROM public."UserIdentity" i WHERE i."userId" = v_user."id" AND i."provider" = v_tok."provider") THEN
    RETURN;
  END IF;

  SELECT count(*) INTO v_count FROM public."AuthEmailToken" e WHERE e."oauthTicketId" = v_tok."id";
  IF v_count >= 3 THEN
    RETURN;
  END IF;
  SELECT count(*) INTO v_count
    FROM public."AuthEmailToken" e
   WHERE e."userId" = v_user."id" AND e."purpose" = 'LINK_GOOGLE' AND e."createdAt" > v_now - interval '1 hour';
  IF v_count >= 5 THEN
    RETURN;
  END IF;

  UPDATE public."AuthEmailToken" e
     SET "invalidatedAt" = v_now
   WHERE e."userId" = v_user."id" AND e."purpose" = 'LINK_GOOGLE'
     AND e."consumedAt" IS NULL AND e."invalidatedAt" IS NULL;

  v_expires := LEAST(v_now + interval '30 minutes', v_tok."expiresAt");

  INSERT INTO public."AuthEmailToken"
    ("id", "userId", "businessId", "purpose", "email", "tokenHash", "createdAt", "expiresAt", "oauthTicketId")
  VALUES
    (p_token_id, v_user."id", v_user."businessId", 'LINK_GOOGLE', v_user."email", p_token_hash, v_now, v_expires, v_tok."id");

  token_id := p_token_id;
  user_id := v_user."id";
  business_id := v_user."businessId";
  email := v_user."email";
  name := v_user."name";
  expires_at := v_expires;
  RETURN NEXT;
END
$fn$;

CREATE OR REPLACE FUNCTION public.auth_oauth_link_email_check(p_token_id uuid, p_secret text, p_ticket_secret text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
#variable_conflict use_column
DECLARE
  v_now timestamp(3) := timezone('UTC', now());
  v_row record;
BEGIN
  IF p_token_id IS NULL OR p_secret IS NULL OR char_length(p_secret) > 200 THEN
    RETURN 'INVALID';
  END IF;
  SELECT e."purpose", e."tokenHash", e."email", e."consumedAt", e."invalidatedAt", e."expiresAt",
         u."email" AS "userEmail", b."deletionRequestedAt", b."deletedAt",
         t."secretHash" AS "ticketHash", t."endedAt" AS "ticketEndedAt", t."expiresAt" AS "ticketExpiresAt"
    INTO v_row
    FROM public."AuthEmailToken" e
    JOIN public."User" u ON u."id" = e."userId"
    JOIN public."Business" b ON b."id" = u."businessId"
    JOIN public."OAuthSignupTicket" t ON t."id" = e."oauthTicketId"
   WHERE e."id" = p_token_id;
  IF NOT FOUND
     OR v_row."purpose" <> 'LINK_GOOGLE'
     OR v_row."tokenHash" <> encode(sha256(convert_to(p_secret, 'UTF8')), 'hex')
     OR v_row."userEmail" IS DISTINCT FROM v_row."email"
     OR v_row."deletionRequestedAt" IS NOT NULL OR v_row."deletedAt" IS NOT NULL THEN
    RETURN 'INVALID';
  END IF;
  IF v_row."consumedAt" IS NOT NULL THEN RETURN 'USED'; END IF;
  IF v_row."invalidatedAt" IS NOT NULL THEN RETURN 'SUPERSEDED'; END IF;
  IF v_row."expiresAt" <= v_now THEN RETURN 'EXPIRED'; END IF;
  IF v_row."ticketEndedAt" IS NOT NULL OR v_row."ticketExpiresAt" <= v_now THEN RETURN 'TICKET_ENDED'; END IF;
  IF p_ticket_secret IS NULL OR char_length(p_ticket_secret) > 200
     OR encode(sha256(convert_to(p_ticket_secret, 'UTF8')), 'hex') <> v_row."ticketHash" THEN
    RETURN 'OTHER_BROWSER';
  END IF;
  RETURN 'VALID';
END
$fn$;

CREATE OR REPLACE FUNCTION public.auth_oauth_link_email_consume(p_token_id uuid, p_secret text, p_ticket_id uuid)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_now timestamp(3) := timezone('UTC', now());
  v_user integer;
BEGIN
  -- Only inside the transaction that spent the very ticket the link is bound to.
  IF p_token_id IS NULL OR p_secret IS NULL OR char_length(p_secret) > 200 OR p_ticket_id IS NULL
     OR current_setting('app.oauth_ticket_spent', true) IS DISTINCT FROM p_ticket_id::text THEN
    RETURN NULL;
  END IF;
  -- One conditional UPDATE under the row lock: a second spend — sequential or concurrent — gets no row.
  UPDATE public."AuthEmailToken" e
     SET "consumedAt" = v_now
    FROM public."User" u, public."Business" b
   WHERE e."id" = p_token_id
     AND e."purpose" = 'LINK_GOOGLE'
     AND e."oauthTicketId" = p_ticket_id
     AND e."tokenHash" = encode(sha256(convert_to(p_secret, 'UTF8')), 'hex')
     AND e."consumedAt" IS NULL AND e."invalidatedAt" IS NULL AND e."expiresAt" > v_now
     AND u."id" = e."userId" AND u."email" = e."email"
     AND b."id" = u."businessId" AND b."deletionRequestedAt" IS NULL AND b."deletedAt" IS NULL
  RETURNING e."userId" INTO v_user;
  RETURN v_user;
END
$fn$;

CREATE OR REPLACE FUNCTION public.auth_oauth_identity_link(p_ticket_id uuid, p_user_id integer, p_proof text)
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
  IF p_ticket_id IS NULL OR p_user_id IS NULL OR p_proof IS NULL OR p_proof NOT IN ('PASSWORD', 'EMAIL')
     OR current_setting('app.oauth_ticket_spent', true) IS DISTINCT FROM p_ticket_id::text THEN
    RAISE EXCEPTION 'auth_oauth_identity_link: the ticket was not spent in this transaction' USING ERRCODE = '22023';
  END IF;

  -- Spent by THIS transaction, for a link, provider-verified, not attached yet.
  SELECT t.* INTO v_tok
    FROM public."OAuthSignupTicket" t
   WHERE t."id" = p_ticket_id AND t."purpose" = 'LINK' AND t."endedReason" = 'CONSUMED'
     AND t."endedAt" = v_now AND t."consumedByUserId" IS NULL AND t."emailVerified"
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'auth_oauth_identity_link: the ticket was not spent in this transaction' USING ERRCODE = '22023';
  END IF;

  -- The account: the ticket's address, not an administrator, business alive, no Google identity yet.
  SELECT u."id", u."email", u."password", u."businessId", u."role"::text AS "role", b."deletionRequestedAt", b."deletedAt"
    INTO v_user
    FROM public."User" u
    JOIN public."Business" b ON b."id" = u."businessId"
   WHERE u."id" = p_user_id
     FOR UPDATE OF u;
  IF NOT FOUND
     OR v_user."email" IS DISTINCT FROM v_tok."email"
     OR v_user."role" = 'PLATFORM_ADMIN'
     OR v_user."deletionRequestedAt" IS NOT NULL OR v_user."deletedAt" IS NOT NULL
     OR EXISTS (SELECT 1 FROM public."UserIdentity" i WHERE i."userId" = p_user_id AND i."provider" = v_tok."provider") THEN
    RAISE EXCEPTION 'auth_oauth_identity_link: not an account this ticket may link' USING ERRCODE = '22023';
  END IF;

  -- The proof of ownership. PASSWORD: compared by the application under the login attempt limits; the
  -- account must have one. EMAIL: a link of THIS ticket, sent to THIS account, spent in THIS transaction.
  IF p_proof = 'PASSWORD' AND v_user."password" IS NULL THEN
    RAISE EXCEPTION 'auth_oauth_identity_link: no proof of ownership' USING ERRCODE = '22023';
  END IF;
  IF p_proof = 'EMAIL' AND NOT EXISTS (
    SELECT 1 FROM public."AuthEmailToken" e
     WHERE e."oauthTicketId" = p_ticket_id AND e."userId" = p_user_id AND e."purpose" = 'LINK_GOOGLE'
       AND e."consumedAt" = v_now
  ) THEN
    RAISE EXCEPTION 'auth_oauth_identity_link: no proof of ownership' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public."UserIdentity" ("userId", "businessId", "provider", "providerSubject", "emailAtLink", "linkedAt")
  VALUES (p_user_id, v_user."businessId", v_tok."provider", v_tok."providerSubject", v_tok."email", v_now)
  RETURNING "id" INTO v_identity;

  UPDATE public."OAuthSignupTicket" SET "consumedByUserId" = p_user_id WHERE "id" = p_ticket_id;

  UPDATE public."User"
     SET "emailVerifiedAt" = COALESCE("emailVerifiedAt", v_now)
   WHERE "id" = p_user_id
  RETURNING "emailVerifiedAt" INTO v_verified;

  identity_id := v_identity;
  email_verified_at := v_verified;
  RETURN NEXT;
END
$fn$;

CREATE OR REPLACE FUNCTION public.auth_oauth_identity_status(p_user_id integer)
RETURNS TABLE (linked boolean, email_at_link text, linked_at timestamp(3), last_used_at timestamp(3), has_password boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
#variable_conflict use_column
DECLARE
  v_user record;
  v_id record;
BEGIN
  SELECT u."id", (u."password" IS NOT NULL) AS "hasPassword" INTO v_user FROM public."User" u WHERE u."id" = p_user_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT i."emailAtLink", i."linkedAt", i."lastUsedAt" INTO v_id
    FROM public."UserIdentity" i WHERE i."userId" = p_user_id AND i."provider" = 'google';
  linked := FOUND;
  email_at_link := CASE WHEN FOUND THEN v_id."emailAtLink" END;
  linked_at := CASE WHEN FOUND THEN v_id."linkedAt" END;
  last_used_at := CASE WHEN FOUND THEN v_id."lastUsedAt" END;
  has_password := v_user."hasPassword";
  RETURN NEXT;
END
$fn$;

CREATE OR REPLACE FUNCTION public.auth_oauth_identity_unlink(p_user_id integer)
RETURNS TABLE (identity_id integer, business_id integer, email_at_link text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
#variable_conflict use_column
DECLARE
  v_user record;
  v_row record;
BEGIN
  SELECT u."id", u."password" INTO v_user FROM public."User" u WHERE u."id" = p_user_id FOR UPDATE;
  -- Only an account that can still sign in without Google may let it go.
  IF NOT FOUND OR v_user."password" IS NULL THEN
    RETURN;
  END IF;
  DELETE FROM public."UserIdentity" i
   WHERE i."userId" = p_user_id AND i."provider" = 'google'
  RETURNING i."id", i."businessId", i."emailAtLink" INTO v_row;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  identity_id := v_row."id";
  business_id := v_row."businessId";
  email_at_link := v_row."emailAtLink";
  RETURN NEXT;
END
$fn$;

REVOKE ALL ON FUNCTION public.auth_oauth_link_email_issue(text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_oauth_link_email_issue(text, uuid, text) FROM app_runtime;
REVOKE ALL ON FUNCTION public.auth_oauth_link_email_check(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_oauth_link_email_check(uuid, text, text) FROM app_runtime;
REVOKE ALL ON FUNCTION public.auth_oauth_link_email_consume(uuid, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_oauth_link_email_consume(uuid, text, uuid) FROM app_runtime;
REVOKE ALL ON FUNCTION public.auth_oauth_identity_link(uuid, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_oauth_identity_link(uuid, integer, text) FROM app_runtime;
REVOKE ALL ON FUNCTION public.auth_oauth_identity_status(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_oauth_identity_status(integer) FROM app_runtime;
REVOKE ALL ON FUNCTION public.auth_oauth_identity_unlink(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_oauth_identity_unlink(integer) FROM app_runtime;

GRANT EXECUTE ON FUNCTION public.auth_oauth_link_email_issue(text, uuid, text) TO app_auth;
GRANT EXECUTE ON FUNCTION public.auth_oauth_link_email_check(uuid, text, text) TO app_auth;
GRANT EXECUTE ON FUNCTION public.auth_oauth_link_email_consume(uuid, text, uuid) TO app_auth;
GRANT EXECUTE ON FUNCTION public.auth_oauth_identity_link(uuid, integer, text) TO app_auth;
GRANT EXECUTE ON FUNCTION public.auth_oauth_identity_status(integer) TO app_auth;
GRANT EXECUTE ON FUNCTION public.auth_oauth_identity_unlink(integer) TO app_auth;
