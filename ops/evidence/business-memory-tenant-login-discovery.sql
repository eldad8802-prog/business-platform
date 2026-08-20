-- Business Memory · SHADOW-VERIFY-LOGIN-DISCOVERY-1 · Production tenant login discovery (read-only).
--
-- Purpose: identify the UI login account(s) attached to a specific Business.id so the owner can sign in
-- to the correct tenant (e.g. businessId=1 / Test Business) and prepare the QA document by hand.
-- OPERATIONAL EVIDENCE ONLY -- not a product read path, not an auth path, not a reusable service.
--
-- Minimal + non-sensitive output ONLY: Business.id, Business.name, and per linked User the login email
-- (login identifier), name, role, whether the account has ever signed in, and its sign-in counter. It
-- NEVER returns password, password hash, token, session, reset/auth secret, phone, address, or any
-- unrelated field. SELECT-only; READ ONLY transaction (session read-only + statement timeout + ROLLBACK).
-- businessId is a bound psql variable (:'businessId') -- there is no injection surface. A CI static guard
-- rejects any write keyword before this file reaches the database.

SET statement_timeout = '30s';
SET default_transaction_read_only = on;
BEGIN TRANSACTION READ ONLY;

\echo '== Business identity (bound businessId) =='
SELECT b.id   AS business_id,
       b.name AS business_name
FROM "Business" b
WHERE b.id = (:'businessId')::int;

\echo '== Login account(s) for this business -- non-sensitive identification only =='
SELECT u.email                        AS login_email,
       u.name                         AS user_name,
       u.role::text                   AS role,
       (u."lastLoginAt" IS NOT NULL)  AS has_logged_in,
       u."loginCount"                 AS login_count
FROM "User" u
WHERE u."businessId" = (:'businessId')::int
ORDER BY u.role ASC, u.email ASC;

ROLLBACK;
