-- PERSISTENT LOGIN — rollback for the privilege correction. NOT FOR EXECUTION.
--
-- Restores the state the tables are in immediately AFTER
-- prisma/migrations/20260908120000_persistent_auth_sessions is applied and
-- BEFORE correction.sql runs. That state is not a historical assumption: it was
-- measured on a PostgreSQL 17.11 branch cut from Production, with the migration
-- applied by `prisma migrate deploy`:
--
--   app_runtime  AuthSession        DELETE, INSERT, SELECT, UPDATE   (table-level)
--   app_runtime  AuthSessionSecret  DELETE, INSERT, SELECT, UPDATE   (table-level)
--   app_auth     AuthSession        nothing
--   app_auth     AuthSessionSecret  nothing
--
-- Those four privileges are exactly what the default ACL
-- {app_runtime=arwd/neondb_owner} confers, and no TRUNCATE, REFERENCES or
-- TRIGGER came with them — `arwd` is the whole of it. Restoring more than arwd
-- would not be a rollback; it would be a new grant wearing a rollback's name.
--
-- WHAT THIS RESTORES A STATE THAT IS KNOWN TO BE WRONG
--
-- Deliberately. A rollback exists to undo a change, not to improve on it. The
-- post-migration state gives the tenant plane privileges it should not have,
-- which is the entire reason correction.sql exists — but if the correction has
-- to be undone, the honest destination is the state that preceded it, so that
-- what is running matches what was measured. The remedy for the wrong state is
-- to run the correction again, not to invent a third state here.
--
-- WHAT THIS DOES NOT DO
--
--   * does not drop either table
--   * does not delete, insert or modify a single row
--   * does not change ALTER DEFAULT PRIVILEGES
--   * does not change role membership
--   * does not touch "User", "Business" or any other object
--   * does not restore anything to app_auth, because app_auth held nothing
--
-- One transaction, for the same reason the correction is: the intermediate state
-- must not be observable.

BEGIN;

-- ============================================================================
-- 1. app_auth — back to nothing on both tables
-- ============================================================================
-- The correction granted SELECT, column INSERT, column UPDATE and DELETE. The
-- table-level revoke below removes the table-level grants; the column-level
-- grants need their own statements, because revoking a table-level privilege
-- does not remove a column-level one that was granted separately.
REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public."AuthSession" FROM app_auth;
REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public."AuthSessionSecret" FROM app_auth;

REVOKE INSERT ("id", "userId", "secretHash", "tokenVersionAtIssue",
               "createdAt", "lastUsedAt", "idleExpiresAt", "absoluteExpiresAt")
  ON public."AuthSession" FROM app_auth;
REVOKE UPDATE ("secretHash", "lastUsedAt", "idleExpiresAt",
               "revokedAt", "revokedReason")
  ON public."AuthSession" FROM app_auth;
REVOKE INSERT ("id", "sessionId", "secretHash", "rotatedAt", "graceUntil")
  ON public."AuthSessionSecret" FROM app_auth;

-- ============================================================================
-- 2. app_runtime — back to exactly what the default ACL conferred
-- ============================================================================
-- SELECT, INSERT, UPDATE, DELETE and no more. Not TRUNCATE, not REFERENCES, not
-- TRIGGER: `arwd` is the measured grant and this restores that and nothing else.
GRANT SELECT, INSERT, UPDATE, DELETE ON public."AuthSession"       TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON public."AuthSessionSecret" TO app_runtime;

COMMIT;
