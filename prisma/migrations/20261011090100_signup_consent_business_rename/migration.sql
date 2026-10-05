-- ============================================================================
-- Signup consent + tenant-pinned business rename (M1) — AUTHORITY-CHANGING
--
-- 1. Terms consent and signup attribution on User.
--    Signup now requires accepting the terms. The fact is recorded on the
--    account it belongs to, in the same transaction that creates it, by the
--    only identity that creates accounts (app_auth):
--      termsAcceptedAt   — when the box was ticked (server clock)
--      termsVersion      — which text was accepted
--      signupAttribution — utm_* / referrer captured on the landing page; it
--                          cannot be recovered later. Bounded and sanitised by
--                          the application before it is written.
--    app_auth gains INSERT on exactly these three columns. It gains no SELECT
--    and no UPDATE on them: nothing on the auth plane reads them back.
--
-- 2. Business rename by its owner.
--    Business.name is set at signup and, until now, no role could change it: a
--    typo at signup was permanent. app_runtime gains UPDATE on the single column
--    "name". Which ROW it may change is already decided by B4
--    (20261006090000_business_tenant_write_rls): business_tenant_write pins
--    UPDATE to id = app.current_business_id, so a transaction for business A
--    cannot rename business B, and with no tenant context it renames nothing.
--    No other Business column is touched; no policy changes.
--
-- Rollback: REVOKE INSERT (the three columns) ON "User" FROM app_auth;
-- REVOKE UPDATE ("name") ON "Business" FROM app_runtime; DROP the three columns.
-- ============================================================================

ALTER TABLE "User"
  ADD COLUMN "termsAcceptedAt" TIMESTAMP(3),
  ADD COLUMN "termsVersion" TEXT,
  ADD COLUMN "signupAttribution" JSONB;

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_auth') THEN
    GRANT INSERT ("termsAcceptedAt", "termsVersion", "signupAttribution") ON "User" TO app_auth;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT UPDATE ("name") ON "Business" TO app_runtime;
  END IF;
END
$do$;
