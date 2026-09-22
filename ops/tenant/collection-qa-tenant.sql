-- Provision the ONE permanent Collection QA tenant.
--
-- WHY THIS EXISTS
--
-- The collection programme is closed on every proof except one: no payment has
-- ever run through the settlement engine in Production. Proving it requires a
-- real tenant — CardCom test terminal 1000 charges nothing, but everything on
-- the Dubiz side is real: a real payment request, a real verified transaction,
-- a real issued receipt with a permanent number. None of that may touch a
-- business that trades.
--
-- So one tenant is created, once, for that purpose, and it is never deleted.
--
-- WHY THIS IS NOT REGISTRATION
--
-- POST /api/auth/register is the only path in the product that creates a
-- Business and a User, and it is closed: PUBLIC_SIGNUP_ENABLED is false in
-- Production and must stay false. Opening it for one account would open public
-- registration to everyone for as long as it stayed open. This file is the
-- alternative: the same two rows, in the same order, in one transaction, with
-- the same columns lib/auth/signup.ts#createAccount writes — but reachable only
-- through the production-db approval gate.
--
-- WHAT IT IS ALLOWED TO DO
--
-- Two INSERTs. No UPDATE, no DELETE, nothing schema-level, nothing touching a
-- row that already exists. scripts/ci/collection-qa-tenant-guard.mjs proves
-- that statically before the workflow opens a connection, and refuses the run
-- otherwise — including if someone widens this file later.
--
-- IDEMPOTENCY
--
-- Identity is the login address, not the business name. The user row is
-- inserted ONLY from the business row this statement itself created, so if the
-- business is not created the user cannot be either: a second run inserts
-- nothing and leaves a single tenant behind. The two rows are one fact, so
-- they commit together or not at all.
--
-- VARIABLES (bound by the workflow; never literals in this file)
--   :qa_email          the dedicated login address, already folded
--   :qa_business_name  the approved business name
--   :qa_user_name      the approved display name
--   :qa_password_hash  bcrypt cost 10, from the production-db secret

SET statement_timeout = '30s';

BEGIN;

WITH existing_user AS (
  SELECT u.id
  FROM "User" u
  WHERE u."email" = :'qa_email'
),
existing_business AS (
  SELECT b.id
  FROM "Business" b
  WHERE b."name" = :'qa_business_name'
),
new_business AS (
  -- "updatedAt" is written explicitly: Prisma maintains it in the application
  -- layer and the column carries no database default, so an insert that omits
  -- it fails outright.
  INSERT INTO "Business" ("name", "createdAt", "updatedAt")
  SELECT :'qa_business_name', now(), now()
  WHERE NOT EXISTS (SELECT 1 FROM existing_user)
    AND NOT EXISTS (SELECT 1 FROM existing_business)
  RETURNING id
),
new_user AS (
  -- Drawn FROM new_business, which is the whole idempotency argument: no
  -- business row created, no user row created. Every other column the product
  -- relies on has a database default — role 'USER', tokenVersion 0,
  -- loginCount 0 — and is deliberately left to it.
  INSERT INTO "User" ("email", "password", "name", "businessId", "createdAt", "updatedAt")
  SELECT :'qa_email', :'qa_password_hash', :'qa_user_name', nb.id, now(), now()
  FROM new_business nb
  RETURNING id, "businessId"
)
SELECT
  'PROVISION' AS step,
  (SELECT count(*) FROM new_business) AS businesses_inserted,
  (SELECT count(*) FROM new_user)     AS users_inserted,
  (SELECT count(*) FROM existing_user) AS users_already_present;

COMMIT;
