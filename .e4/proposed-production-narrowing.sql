-- D2 / STAGE E4 — PROPOSED Production privilege narrowing for "User" and "Business".
--
-- NOT FOR EXECUTION. This file is the reviewed artefact; running it is a separate,
-- explicitly authorised task.
--
-- WHY THE ORDER MATTERS
--
-- PostgreSQL privileges are additive, and a table-level grant cannot be partially
-- revoked. `REVOKE SELECT (password) ON "User" FROM app_runtime` does nothing at
-- all while a table-level SELECT is held: the table grant keeps answering. So the
-- table-level privilege must be removed FIRST, and the wanted columns granted back
-- afterwards. Doing it the other way round leaves the old grant in place and the
-- narrowing silently achieves nothing — which would look like success.
--
-- The consequence is a window, between the REVOKE and the GRANT, in which the
-- runtime can do less than the application needs. Everything below therefore runs
-- in ONE transaction: either the whole contract lands or none of it does, and no
-- request can observe the half-applied state. DDL is transactional in PostgreSQL,
-- which is what makes that possible.
--
-- WHAT IS DELIBERATELY NOT HERE
--
-- No RLS is added to either table. Login resolves a user by email, session
-- validation resolves one by id, and signup creates a Business before a tenant id
-- exists — all three run before any tenant GUC is set, so a `businessId =
-- current_setting(...)` predicate would match zero rows and break authentication.
-- The boundary on these two tables is privilege, not policy.
--
-- No DELETE is granted anywhere. Nothing in the application deletes a User or a
-- Business; account deletion quarantines through updateMany.
--
-- The column lists below are the ones the PG17 rehearsal proved sufficient AND
-- necessary (.tx3a1/exact-grant-battery.mjs, section 3). Two of them were wrong in
-- the original design and the rehearsal disproved them: `loginCount` is a read as
-- well as a write, because an increment reads before writing; and `updatedAt` is
-- written by Prisma on every update against a model carrying @updatedAt.

BEGIN;

-- ============================================================================
-- 1. app_runtime — the identity serving tenant traffic
-- ============================================================================

-- Table-level first. Until these are gone, every column grant below is inert.
REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public."User" FROM app_runtime;
REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public."Business" FROM app_runtime;

-- Read: the union of every runtime call site — the selects, plus the columns
-- named in where clauses and orderBy, which need SELECT too.
GRANT SELECT ("id", "email", "name", "businessId", "lastLoginAt", "loginCount")
  ON public."User" TO app_runtime;
GRANT SELECT ("id", "name", "createdAt", "deletionRequestedAt", "deletedAt")
  ON public."Business" TO app_runtime;

-- Write: account deletion, and nothing else. `updatedAt` is Prisma's, not ours.
GRANT UPDATE ("email", "name", "password", "updatedAt")
  ON public."User" TO app_runtime;
GRANT UPDATE ("deletionRequestedAt", "deletedAt", "archivedAt", "archivedByUserId", "updatedAt")
  ON public."Business" TO app_runtime;

-- No INSERT: the only creator of either row is signup, which runs on the auth
-- plane. No DELETE: there is no consumer at all.

-- ============================================================================
-- 2. app_auth — the identity serving login, session resolution and signup
-- ============================================================================

REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public."User" FROM app_auth;
REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public."Business" FROM app_auth;

-- `password` is here and nowhere else: this is the only identity that compares a
-- credential. `loginCount` is a read because the login stamp increments it.
GRANT SELECT ("id", "email", "name", "password", "businessId", "tokenVersion", "role", "loginCount")
  ON public."User" TO app_auth;
GRANT SELECT ("id", "name", "deletionRequestedAt", "deletedAt")
  ON public."Business" TO app_auth;

-- Signup writes exactly the fields Prisma supplies; the rest come from defaults.
GRANT INSERT ("email", "password", "name", "businessId", "updatedAt")
  ON public."User" TO app_auth;
GRANT INSERT ("name", "updatedAt")
  ON public."Business" TO app_auth;

-- The login stamp and the logout revocation. Note there is no `password` here:
-- the auth plane may verify a credential and may not change one.
GRANT UPDATE ("lastLoginAt", "loginCount", "tokenVersion", "updatedAt")
  ON public."User" TO app_auth;

-- No UPDATE on Business at all, and no DELETE on either.

-- ============================================================================
-- 3. Sequences
-- ============================================================================
-- The auth plane keeps USAGE, because signup inserts both rows and nextval()
-- needs it. It does NOT get UPDATE: that would additionally permit setval(),
-- which nothing requires.
GRANT USAGE ON SEQUENCE public."User_id_seq" TO app_auth;
GRANT USAGE ON SEQUENCE public."Business_id_seq" TO app_auth;

-- The runtime loses both. It holds USAGE and SELECT on them today, from the
-- blanket grant over every sequence, but under this contract it can no longer
-- INSERT into either table — so nothing it does will ever call nextval() there.
-- Left in place they would be privilege with no consumer, which is the same
-- category of residue as the DELETE grant removed in Step 1.
--
-- Scoped to these two only. `app_runtime` still needs USAGE and SELECT on every
-- other sequence in the schema, and a blanket revoke would break every insert
-- the product makes.
REVOKE ALL ON SEQUENCE public."User_id_seq" FROM app_runtime;
REVOKE ALL ON SEQUENCE public."Business_id_seq" FROM app_runtime;

COMMIT;
