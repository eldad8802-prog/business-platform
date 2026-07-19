-- Read-only Production check: does eldad8802@gmail.com exist, and what is its
-- role? Returns ONLY existence + role — never a password hash, token, name, or
-- any other personal field. SELECT-only; READ ONLY transaction that rolls back;
-- a static guard rejects any write keyword before this file reaches the database.

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;

-- U1: existence + role for the target email (case-insensitive). Email is unique.
SELECT 'U1_platform_admin_check' AS q,
  (count(*) > 0)        AS user_exists,
  max(role::text)       AS role,
  'eldad8802@gmail.com' AS email
FROM "User"
WHERE lower(email) = lower('eldad8802@gmail.com');

ROLLBACK;
