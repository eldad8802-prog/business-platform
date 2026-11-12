-- Issuer-declaration link — the single-use emailed confirmation of an issuer declaration (migration only)
--
-- WHY IT IS SHAPED THIS WAY
--   Before a business issues its first tax document it confirms an issuer declaration (billing, #1081).
--   The confirmation must come from the person who controls the account's mailbox AND is signed in as that
--   account, and it must confirm EXACTLY the declaration that was shown — not another one, not a later
--   edit. So the emailed link is bound to the account, its business and the declaration's digest
--   (statementSha256, computed by billing from the canonical declaration), lives 30 minutes, works once,
--   and is spent in the SAME transaction that records the declaration: a failure there leaves the link
--   unspent.
--
-- WHAT THIS ADDS (modeled on LINK_GOOGLE, 20261102090000)
--   "AuthEmailToken" (20261017090000) gains a fourth purpose, ISSUER_DECLARATION, and a column binding such
--   a token to the declaration digest ("bindingSha256", 64 lowercase hex). Only an ISSUER_DECLARATION token
--   carries a digest, and every one carries one. Nothing else about the table, its policies or its grants
--   changes. The link's status is read with the existing auth_email_token_check(id, secret, purpose).
--
--   Two SECURITY DEFINER functions (search_path pinned to pg_catalog, public):
--     auth_issuer_declaration_issue   — for an account and ITS business (refused otherwise, and for a
--                                       business in deletion): records the digest, 30 minutes, at most 3
--                                       per account and hour, closes the account's earlier open ones;
--     auth_issuer_declaration_consume — spend the link, only inside a tenant transaction of the link's
--                                       business (app.current_business_id), only for the account it was
--                                       sent to and only for the same digest; same address, business alive,
--                                       not used, not superseded, not expired; one conditional UPDATE under
--                                       the row lock. Called by billing in the transaction that inserts the
--                                       declaration, so the two commit or roll back together.
--
-- WHO MAY DO WHAT
--   app_auth    — EXECUTE on auth_issuer_declaration_issue (the auth plane records the link and its email).
--                 Still NOTHING on AuthEmailToken itself.
--   app_runtime — EXECUTE on auth_issuer_declaration_consume ONLY (owner decision 2026-11-11), so the link is
--                 spent in billing's tenant transaction. Its table privileges are unchanged (account erasure:
--                 DELETE, SELECT on (id, businessId), bound by RLS); never the new column.
--   PUBLIC      — nothing.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   no change to any existing function, policy or grant; no dependency on billing's migration
--   (20261123090000_issuer_declaration): business deletion is read from Business here; no backfill; no
--   route, no flag, no user-visible change.
--
-- Additive: one vocabulary widening, one nullable column with its check, two functions.

-- ── AuthEmailToken: the ISSUER_DECLARATION purpose, bound to its declaration digest ─────────────

ALTER TABLE "AuthEmailToken" ADD COLUMN "bindingSha256" TEXT;

ALTER TABLE "AuthEmailToken" DROP CONSTRAINT "AuthEmailToken_purpose";
ALTER TABLE "AuthEmailToken" ADD CONSTRAINT "AuthEmailToken_purpose"
  CHECK ("purpose" IN ('EMAIL_VERIFY', 'PASSWORD_RESET', 'LINK_GOOGLE', 'ISSUER_DECLARATION'));
ALTER TABLE "AuthEmailToken" ADD CONSTRAINT "AuthEmailToken_declaration_binding"
  CHECK ((("purpose" = 'ISSUER_DECLARATION') = ("bindingSha256" IS NOT NULL))
         AND ("bindingSha256" IS NULL OR "bindingSha256" ~ '^[0-9a-f]{64}$'));

-- ── auth_issuer_declaration_issue ───────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.auth_issuer_declaration_issue(
  p_user_id integer, p_business_id integer, p_binding_sha256 text, p_token_id uuid, p_token_hash text
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
  IF p_user_id IS NULL OR p_business_id IS NULL OR p_token_id IS NULL
     OR p_binding_sha256 IS NULL OR p_binding_sha256 !~ '^[0-9a-f]{64}$'
     OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'auth_issuer_declaration_issue: malformed input' USING ERRCODE = '22023';
  END IF;

  SELECT u."id", u."email", u."businessId", b."deletionRequestedAt", b."deletedAt"
    INTO v_user
    FROM public."User" u
    JOIN public."Business" b ON b."id" = u."businessId"
   WHERE u."id" = p_user_id
     FOR UPDATE OF u;

  -- Only the account's own business, and never a business in deletion: nothing is issued.
  IF NOT FOUND OR v_user."businessId" <> p_business_id
     OR v_user."deletionRequestedAt" IS NOT NULL OR v_user."deletedAt" IS NOT NULL THEN
    RETURN;
  END IF;

  SELECT count(*) INTO v_recent
    FROM public."AuthEmailToken" t
   WHERE t."userId" = p_user_id AND t."purpose" = 'ISSUER_DECLARATION' AND t."createdAt" > v_now - interval '1 hour';
  IF v_recent >= 3 THEN
    RETURN;
  END IF;

  -- A new link closes the account's earlier open ones: only the latest works.
  UPDATE public."AuthEmailToken" t
     SET "invalidatedAt" = v_now
   WHERE t."userId" = p_user_id AND t."purpose" = 'ISSUER_DECLARATION'
     AND t."consumedAt" IS NULL AND t."invalidatedAt" IS NULL;

  v_expires := v_now + interval '30 minutes';

  INSERT INTO public."AuthEmailToken"
    ("id", "userId", "businessId", "purpose", "email", "tokenHash", "createdAt", "expiresAt", "bindingSha256")
  VALUES
    (p_token_id, v_user."id", v_user."businessId", 'ISSUER_DECLARATION', v_user."email", p_token_hash, v_now, v_expires,
     p_binding_sha256);

  token_id := p_token_id;
  business_id := v_user."businessId";
  email := v_user."email";
  expires_at := v_expires;
  RETURN NEXT;
END
$fn$;

-- ── auth_issuer_declaration_consume ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.auth_issuer_declaration_consume(
  p_token_id uuid, p_secret text, p_user_id integer, p_binding_sha256 text
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
#variable_conflict use_column
DECLARE
  v_now timestamp(3) := timezone('UTC', now());
  v_ctx text := current_setting('app.current_business_id', true);
  v_tok record;
BEGIN
  IF p_token_id IS NULL OR p_secret IS NULL OR char_length(p_secret) > 200 OR p_user_id IS NULL
     OR p_binding_sha256 IS NULL OR p_binding_sha256 !~ '^[0-9a-f]{64}$'
     OR v_ctx IS NULL OR v_ctx = '' THEN
    RETURN 'INVALID';
  END IF;

  SELECT t.*, u."email" AS "userEmail", u."businessId" AS "userBusinessId", b."deletionRequestedAt", b."deletedAt"
    INTO v_tok
    FROM public."AuthEmailToken" t
    JOIN public."User" u ON u."id" = t."userId"
    JOIN public."Business" b ON b."id" = t."businessId"
   WHERE t."id" = p_token_id
     FOR UPDATE OF t;

  -- Unknown, another purpose, a wrong secret, another account, another business (the tenant transaction's
  -- or the account's), a changed address or a business in deletion: one answer, nothing changes.
  IF NOT FOUND
     OR v_tok."purpose" <> 'ISSUER_DECLARATION'
     OR v_tok."tokenHash" <> encode(sha256(convert_to(p_secret, 'UTF8')), 'hex')
     OR v_tok."userId" <> p_user_id
     OR v_tok."businessId"::text <> v_ctx
     OR v_tok."userBusinessId" <> v_tok."businessId"
     OR v_tok."userEmail" IS DISTINCT FROM v_tok."email"
     OR v_tok."deletionRequestedAt" IS NOT NULL OR v_tok."deletedAt" IS NOT NULL THEN
    RETURN 'INVALID';
  END IF;
  IF v_tok."consumedAt" IS NOT NULL THEN RETURN 'USED'; END IF;
  IF v_tok."invalidatedAt" IS NOT NULL THEN RETURN 'SUPERSEDED'; END IF;
  IF v_tok."expiresAt" <= v_now THEN RETURN 'EXPIRED'; END IF;
  -- The declaration changed since the link was sent: the link stays unspent; a new one is needed.
  IF v_tok."bindingSha256" IS DISTINCT FROM p_binding_sha256 THEN RETURN 'BINDING_MISMATCH'; END IF;

  UPDATE public."AuthEmailToken" SET "consumedAt" = v_now WHERE "id" = p_token_id AND "consumedAt" IS NULL;
  RETURN 'CONFIRMED';
END
$fn$;

-- ── Who may call them ───────────────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.auth_issuer_declaration_issue(integer, integer, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_issuer_declaration_issue(integer, integer, text, uuid, text) FROM app_runtime;
REVOKE ALL ON FUNCTION public.auth_issuer_declaration_consume(uuid, text, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_issuer_declaration_consume(uuid, text, integer, text) FROM app_auth;

GRANT EXECUTE ON FUNCTION public.auth_issuer_declaration_issue(integer, integer, text, uuid, text) TO app_auth;
GRANT EXECUTE ON FUNCTION public.auth_issuer_declaration_consume(uuid, text, integer, text) TO app_runtime;
