-- sec(C) / M-14 + T-04 — explicit, least-privilege grants the migrations never shipped.
--
-- EXPAND-ONLY: GRANTs only. Nothing is revoked here (the revokes are per-environment
-- owner actions, sequenced after the code that stops needing them is live).
--
-- 1. SIGNUP ON THE ACTIVE AUTH PLANE (PR #526 finding, revalidated in a fresh lab:
--    `createAccount` as app_auth -> 42501 "permission denied for table Business").
--    20260908180000 granted app_auth INSERT ("name","updatedAt") on Business and
--    ("email","password","name","businessId","updatedAt") on User. Prisma emits
--    EVERY defaulted scalar explicitly (captured query log):
--      INSERT INTO "Business" ("name","createdAt","updatedAt") ...
--      INSERT INTO "User" ("email","password","name","businessId","role","loginCount",
--                          "tokenVersion","createdAt","updatedAt") ...
--    so every signup on the auth plane fails. Latent only while public signup is
--    closed. Adds exactly the missing columns — nothing else. (The auth plane can
--    therefore write "role" on INSERT; signup never sets it, so Prisma sends the
--    schema default USER. UPDATE of "role" stays ungranted.)
--
-- 2. PlatformAdminMfa ON THE AUTH PLANE (prepares T-04). Platform-admin second-factor
--    state is authentication material; it belongs with the identity that already
--    verifies passwords (app_auth), not with the tenant runtime (today, via an
--    out-of-repo broad grant) and not with the cross-tenant admin read identity.
--    The code moves in a follow-up (needs a CI-2a allowlist entry); the runtime's
--    access is revoked per environment after that deploy.
--
-- 3. ProductUsageEvent: the runtime's ONLY need is to append telemetry; app_admin
--    reads it (platform usage screens). Previously both rested on out-of-repo grants.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_auth') THEN
    GRANT INSERT ("createdAt") ON "Business" TO app_auth;
    GRANT INSERT ("createdAt", "role", "loginCount", "tokenVersion") ON "User" TO app_auth;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "PlatformAdminMfa" TO app_auth;
    GRANT USAGE ON SEQUENCE "PlatformAdminMfa_id_seq" TO app_auth;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT INSERT ON "ProductUsageEvent" TO app_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin') THEN
    GRANT SELECT ON "ProductUsageEvent" TO app_admin;
  END IF;
END
$$;
