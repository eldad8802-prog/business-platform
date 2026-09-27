-- Read-only Production verification of a manually-registered user. Returns ONLY
-- booleans — never the address, user id value, role name, password hash, tokens,
-- secrets, or any other personal field. There is no separate Tenant model in this
-- schema: the tenant unit IS the Business, so tenant_exists mirrors business_exists.
--
-- M-1: the target address is NOT committed here. The workflow binds it as the psql
-- variable :'target_email' from the production-db environment secret PROD_VERIFY_EMAIL.
--
-- SELECT-only; READ ONLY transaction that rolls back; a static guard rejects any
-- write keyword before this file reaches the database.

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;

SELECT 'V1_user_verify' AS q,
  (u.id IS NOT NULL)                    AS user_exists,
  (u.role::text = 'PLATFORM_ADMIN')     AS is_platform_admin,
  (b.id IS NOT NULL)                    AS business_exists,
  (b.id IS NOT NULL)                    AS tenant_exists
FROM (SELECT 1) AS anchor
LEFT JOIN "User" u ON lower(u.email) = lower(:'target_email')
LEFT JOIN "Business" b ON b.id = u."businessId";

ROLLBACK;
