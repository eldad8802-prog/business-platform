-- Read-only Production verification of the manually-registered user
-- eldad8802@gmail.com. Returns ONLY booleans + role — never the user id value,
-- password hash, tokens, secrets, or any other personal field. There is no
-- separate Tenant model in this schema: the tenant unit IS the Business, so
-- tenant_exists mirrors business_exists (the user's linked Business row).
--
-- SELECT-only; READ ONLY transaction that rolls back; a static guard rejects any
-- write keyword before this file reaches the database.

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;

SELECT 'V1_user_verify' AS q,
  (u.id IS NOT NULL)                    AS user_exists,
  'eldad8802@gmail.com'                 AS email,
  u.role::text                          AS current_role_value,
  (u.id IS NOT NULL)                    AS user_id_present,
  (b.id IS NOT NULL)                    AS business_exists,
  (b.id IS NOT NULL)                    AS tenant_exists
FROM (SELECT 1) AS anchor
LEFT JOIN "User" u ON lower(u.email) = lower('eldad8802@gmail.com')
LEFT JOIN "Business" b ON b.id = u."businessId";

ROLLBACK;
