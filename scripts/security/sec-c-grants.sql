-- sec(C) — per-environment grants (owner-privileged operator; NOT a migration).
--
-- Apply with the environment's owner connection, e.g.
--   psql "$OWNER_URL" -v ON_ERROR_STOP=1 -f scripts/security/sec-c-grants.sql
-- Idempotent. Rollback: scripts/security/sec-c-rollback.sql.
--
-- 1. M-14(d) — app_admin reads "User" WITHOUT the password hash (and without the
--    session generation). d2-p7-w2gate-admin-grants.sql granted table-wide SELECT,
--    which includes "password". A column grant cannot narrow a table grant, so the
--    table grant is revoked first and the columns the platform-admin code reads are
--    granted back — in ONE transaction, so no request sees the gap.
--    Column set = every User column the admin plane selects, filters or orders by
--    (platform-usage-overview: id,email,lastLoginAt,loginCount; platform-overview /
--    business detail: counts by businessId; role/name/createdAt/updatedAt for the
--    admin screens). Excluded: "password", "tokenVersion".
--
-- 2. M-14(c)/T-07 — platform usage overview and business detail now read
--    "ProductUsageEvent" as app_admin (they used the tenant runtime before).
--
-- Prerequisite for (2) to be USEFUL in an environment: an app_admin LOGIN role and
-- ADMIN_DATABASE_URL configured there (Production has neither today — owner action).

BEGIN;

REVOKE SELECT ON "User" FROM app_admin;
GRANT SELECT ("id", "email", "name", "businessId", "role", "lastLoginAt", "loginCount", "createdAt", "updatedAt")
  ON "User" TO app_admin;

GRANT SELECT ON "ProductUsageEvent" TO app_admin;

COMMIT;
