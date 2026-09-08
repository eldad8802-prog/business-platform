-- Persistent login — the privilege contract for "AuthSession" and
-- "AuthSessionSecret", carried in migration history.
--
-- WHY A SECOND MIGRATION RATHER THAN PART OF THE FIRST
--
-- 20260908120000_persistent_auth_sessions created the two tables and is already
-- applied in Production. It is not edited here and its shape is not touched.
--
-- Creating those tables was not privilege-neutral. Production carries a default
-- privilege rule attached to the role that owns migrations:
--
--   DEFACL owner=neondb_owner schema=public objtype=r acl={app_runtime=arwd/neondb_owner}
--
-- so every table `prisma migrate deploy` creates arrives already granting the
-- TENANT runtime SELECT, INSERT, UPDATE and DELETE. Measured on PostgreSQL 17.11
-- after that migration: `app_runtime` held all four on both tables and `app_auth`
-- held nothing. The plane with no business here had everything, and the plane
-- that will serve refresh had nothing.
--
-- Production was corrected by hand from the reviewed artefact. That left the
-- contract true in exactly one database and recorded nowhere that runs. Preview
-- measurably differs — it has the group roles but NO such default ACL — so there
-- the same tables would arrive with `app_runtime` holding nothing and `app_auth`
-- still holding nothing, and the refresh consumer would fail closed with
-- permission denied rather than merely being over-privileged.
--
-- This migration makes the contract reproducible: any environment that applies
-- the history reaches the same effective privileges.
--
-- IT IS THE REVIEWED ARTEFACT
--
-- The statements below are those of .auth-session-privileges/correction.sql, in
-- its order, with two deliberate differences and no others:
--
--   * no BEGIN/COMMIT. Prisma runs each migration file inside its own
--     transaction, and a nested wrapper would close that transaction early —
--     turning an all-or-nothing change into a half-applied one, which is the
--     single failure the design exists to prevent.
--   * the statements are wrapped in role guards, so the migration runs on a
--     database that has neither role.
--
-- equivalence.test.ts compares the two files statement by statement and fails if
-- a privilege, table, role or column ever diverges between them.
--
-- WHY THE GUARDS
--
-- `REVOKE ... FROM app_runtime` raises 42704 where that role does not exist, and
-- a migration that cannot run on a fresh database is a migration that quietly
-- decides which environments are allowed to exist. Both roles are therefore
-- optional, independently: with neither present this is a successful no-op.
--
-- WHY ONLY THE GROUP ROLES ARE NAMED
--
-- `app_runtime` and `app_auth` are NOLOGIN groups; every environment attaches its
-- own LOGIN identity to them. Production uses app_runtime_prod and app_auth_prod;
-- Preview uses different names again. Naming any of them here would bind the
-- history to one environment. Granting the group reaches whichever identity is a
-- member, which is how the privilege actually resolves at connection time.
--
-- WHY THE UPDATE GRANT IS COLUMN-LEVEL
--
-- Three columns of "AuthSession" are the mechanisms the persistent-login design
-- rests on, and a table-level UPDATE would let the auth plane defeat all three
-- with one statement:
--
--   absoluteExpiresAt    advancing it makes a session immortal and removes the
--                        90-day ceiling
--   tokenVersionAtIssue  rewriting it revives a session that global logout
--                        already killed
--   userId               repointing a live session at another account is
--                        session hijack expressed as one UPDATE
--
-- Withheld, they stop being promises the code keeps and become guarantees the
-- database enforces.
--
-- EFFECTIVELY IDEMPOTENT. Every role is revoked to zero before anything is
-- granted back, so applying this where the contract already holds — Production —
-- reproduces the same end state and widens nothing.
--
-- Nothing here creates, drops or alters a table, a role, a policy or a row. No
-- ALTER DEFAULT PRIVILEGES: that rule governs every future table this product
-- creates and changing it is a separate decision. No sequence privileges: both
-- primary keys are UUID, so neither table has a sequence.

-- ============================================================================
-- 1. app_runtime — the tenant plane, which has no business here at all
-- ============================================================================
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
      ON public."AuthSession" FROM app_runtime;
    REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
      ON public."AuthSessionSecret" FROM app_runtime;
  END IF;
END
$do$;

-- ============================================================================
-- 2. app_auth — normalised to zero, then granted the exact contract
-- ============================================================================
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_auth') THEN
    -- Table-level first and always. A column-level GRANT is inert while a
    -- table-level privilege is held, so narrowing without revoking first would
    -- achieve nothing while looking like success.
    REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
      ON public."AuthSession" FROM app_auth;
    REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
      ON public."AuthSessionSecret" FROM app_auth;

    -- Read, table-level and deliberately not narrowed: neither table has a
    -- column this plane should not see, and PostgreSQL needs SELECT on every
    -- column named in a WHERE or ORDER BY anyway.
    GRANT SELECT ON public."AuthSession" TO app_auth;
    GRANT SELECT ON public."AuthSessionSecret" TO app_auth;

    -- Create. revokedAt and revokedReason are absent because a session is never
    -- born revoked; leaving them out makes that unrepresentable.
    GRANT INSERT ("id", "userId", "secretHash", "tokenVersionAtIssue",
                  "createdAt", "lastUsedAt", "idleExpiresAt", "absoluteExpiresAt")
      ON public."AuthSession" TO app_auth;
    GRANT INSERT ("id", "sessionId", "secretHash", "rotatedAt", "graceUntil")
      ON public."AuthSessionSecret" TO app_auth;

    -- Rotate and revoke. The columns absent here are the point; see the header.
    GRANT UPDATE ("secretHash", "lastUsedAt", "idleExpiresAt",
                  "revokedAt", "revokedReason")
      ON public."AuthSession" TO app_auth;

    -- No UPDATE on "AuthSessionSecret" at all. A rotation record is written once
    -- with its graceUntil already final, and withholding UPDATE makes that
    -- deadline unforgeable after the fact.

    -- Delete: expiry cleanup on the parent, cap eviction on the child. Both run
    -- inside a user request because this product has no scheduler. Not an
    -- escalation — this role already holds UPDATE ("tokenVersion") on "User",
    -- which signs out every session of every user on every device.
    GRANT DELETE ON public."AuthSession" TO app_auth;
    GRANT DELETE ON public."AuthSessionSecret" TO app_auth;
  END IF;
END
$do$;
