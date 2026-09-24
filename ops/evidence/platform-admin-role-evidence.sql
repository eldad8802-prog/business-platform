-- Read-only Production check: does the target account exist, and does it hold the
-- platform-admin role? Returns ONLY booleans — never the address, a role name, a
-- password hash, token, name, or any other personal field. SELECT-only; READ ONLY
-- transaction that rolls back; a static guard rejects any write keyword before this
-- file reaches the database.
--
-- M-1: the target address is NOT committed here. The workflow binds it as the psql
-- variable :'target_email' from the production-db environment secret PROD_VERIFY_EMAIL.

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;

-- U1: existence + platform-admin posture for the target email (case-insensitive).
SELECT 'U1_platform_admin_check' AS q,
  (count(*) > 0)                                  AS user_exists,
  bool_or(role::text = 'PLATFORM_ADMIN')          AS is_platform_admin
FROM "User"
WHERE lower(email) = lower(:'target_email');

ROLLBACK;
