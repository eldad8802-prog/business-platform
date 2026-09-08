-- PERSISTENT LOGIN — privilege correction for "AuthSession" and "AuthSessionSecret".
--
-- NOT FOR EXECUTION. This file is the reviewed artefact; running it against
-- Production is a separate, explicitly authorised task.
--
-- NOT the D2 Stage E4 narrowing. That artefact (.e4/) covers "User" and
-- "Business" and is separately reviewed and still unexecuted. This one touches
-- only the two tables created by
-- prisma/migrations/20260908120000_persistent_auth_sessions, shares no statement
-- with it, and neither waits on the other.
--
-- WHY THIS EXISTS
--
-- Production carries a default privilege rule, measured from the live catalog:
--
--   DEFACL owner=neondb_owner schema=public objtype=r acl={app_runtime=arwd/neondb_owner}
--
-- release-migrate connects as neondb_owner, so every table `prisma migrate
-- deploy` creates is created BY the role that rule is attached to, and arrives
-- already granting the TENANT runtime SELECT, INSERT, UPDATE and DELETE. The
-- migration did not ask for that and could not have declined it. Measured on a
-- PostgreSQL 17.11 branch cut from Production, after applying the migration:
--
--   app_runtime  AuthSession        DELETE,INSERT,SELECT,UPDATE
--   app_runtime  AuthSessionSecret  DELETE,INSERT,SELECT,UPDATE
--   app_auth     nothing on either
--
-- So the state the migration produces is backwards: the plane with no business
-- here holds everything, and the plane that will serve refresh holds nothing.
--
-- WHY THE ORDER MATTERS
--
-- PostgreSQL privileges are additive and a table-level grant cannot be partially
-- revoked. A column-level GRANT UPDATE is inert while a table-level UPDATE is
-- held — the table grant simply keeps answering, and the narrowing silently
-- achieves nothing while looking like success. So every table-level privilege is
-- removed FIRST and the wanted columns granted back afterwards.
--
-- That ordering creates a window in which the contract is incomplete, which is
-- why everything below is ONE transaction: it lands whole or not at all, and no
-- session can observe the half-applied state.
--
-- WHY THE UPDATE GRANT IS COLUMN-LEVEL
--
-- Three columns of "AuthSession" are the mechanisms the whole persistent-login
-- design rests on, and a table-level UPDATE would let the auth plane defeat all
-- three with one statement:
--
--   absoluteExpiresAt    advancing it makes a session immortal and removes the
--                        90-day ceiling
--   tokenVersionAtIssue  rewriting it revives a session that global logout
--                        already killed
--   userId               repointing a live session at another account is
--                        session hijack expressed as one UPDATE
--
-- Withholding them is the difference between a ceiling the code observes and a
-- ceiling the database enforces.
--
-- WHAT IS DELIBERATELY NOT HERE
--
--   * no change to "User", "Business" or any other table
--   * no ALTER DEFAULT PRIVILEGES change. The rule above affects every table
--     this product will ever create and correcting it is a D2 and
--     release-infrastructure decision, not a persistent-login one
--   * no role membership change
--   * no sequence privileges: both primary keys are UUID, so neither table has
--     a sequence to grant
--   * no RLS. A refresh resolves a session by selector before anyone knows which
--     tenant it belongs to, so a tenant predicate would match zero rows and
--     break authentication — the same reason "User" and "Business" sit outside
--     it. The boundary on these tables is privilege, not policy.
--
-- IDEMPOTENT. Every role is revoked to zero before anything is granted back, so
-- re-running this file converges on the same contract rather than accumulating.

BEGIN;

-- ============================================================================
-- 1. app_runtime — the tenant plane, which has no business here at all
-- ============================================================================
-- Total and table-level. There is no column of either table the tenant runtime
-- should reach: it has zero consumers for them, so it gets zero privilege.
-- app_runtime_prod is a member of app_runtime with inherit=t, so removing it
-- here removes it from the identity Production actually connects as.
REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public."AuthSession" FROM app_runtime;
REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public."AuthSessionSecret" FROM app_runtime;

-- ============================================================================
-- 2. app_auth — normalised to zero before anything is granted
-- ============================================================================
-- The default ACL granted this role nothing, so on a first run these revokes are
-- no-ops. They are here anyway for two reasons: the contract below then states
-- the whole of what the role holds rather than a delta on an unexamined start
-- state, and re-running the file is safe.
REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public."AuthSession" FROM app_auth;
REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public."AuthSessionSecret" FROM app_auth;

-- ============================================================================
-- 3. app_auth — the exact contract
-- ============================================================================

-- READ, table-level and deliberately not narrowed. Unlike "User", neither table
-- has a column this plane should not see: secretHash is a digest and everything
-- else is its own bookkeeping. PostgreSQL also requires SELECT on every column
-- named in a WHERE or ORDER BY, so a column list would have to name nearly all
-- of them and would only look stricter.
GRANT SELECT ON public."AuthSession"       TO app_auth;
GRANT SELECT ON public."AuthSessionSecret" TO app_auth;

-- CREATE. revokedAt and revokedReason are absent on purpose: a session is never
-- born revoked, and leaving them out makes that unrepresentable rather than
-- merely unusual. `id` is included so the grant does not depend on whether the
-- client supplies the uuid or lets the column default produce it.
GRANT INSERT ("id", "userId", "secretHash", "tokenVersionAtIssue",
              "createdAt", "lastUsedAt", "idleExpiresAt", "absoluteExpiresAt")
  ON public."AuthSession" TO app_auth;
GRANT INSERT ("id", "sessionId", "secretHash", "rotatedAt", "graceUntil")
  ON public."AuthSessionSecret" TO app_auth;

-- ROTATE and REVOKE, and nothing else. The columns absent from this list are the
-- point of the grant being column-level; see the header.
GRANT UPDATE ("secretHash", "lastUsedAt", "idleExpiresAt",
              "revokedAt", "revokedReason")
  ON public."AuthSession" TO app_auth;

-- No UPDATE on "AuthSessionSecret", at table level or on any column. A rotation
-- record is written once with its graceUntil already final; withholding UPDATE
-- makes that deadline unforgeable after the fact, so nobody can widen a grace
-- window retroactively to turn a chain divergence into an acceptance.

-- DELETE. Two real consumers: opportunistic cleanup of expired and revoked
-- sessions on the parent, and cap eviction on the child. Both must run inside a
-- user request, because this product has no scheduler anywhere.
--
-- Not an escalation. This role already holds UPDATE ("tokenVersion") on "User",
-- which signs out every session of every user on every device — a strictly
-- larger capability than deleting rows from these two tables.
GRANT DELETE ON public."AuthSession"       TO app_auth;
GRANT DELETE ON public."AuthSessionSecret" TO app_auth;

-- TRUNCATE, REFERENCES and TRIGGER are granted to nobody. None has a consumer,
-- and TRUNCATE in particular would bypass the row-by-row deletes above along
-- with anything watching them.

COMMIT;
