-- sec(C) — rollback of scripts/security/sec-c-grants.sql (restores the previous
-- table-wide admin SELECT on "User", which INCLUDES the password hash — only for an
-- emergency where an admin screen needs a column not in the narrowed list).
BEGIN;
REVOKE SELECT ("id", "email", "name", "businessId", "role", "lastLoginAt", "loginCount", "createdAt", "updatedAt")
  ON "User" FROM app_admin;
GRANT SELECT ON "User" TO app_admin;
COMMIT;
