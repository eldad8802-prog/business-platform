-- D2 / STAGE E4 — rollback for the proposed narrowing. NOT FOR EXECUTION.
--
-- Restores the privilege state that Production holds today, as measured from the
-- live catalog before the narrowing:
--
--   app_runtime : User     INSERT, SELECT, UPDATE   (table-level, no DELETE)
--                 Business INSERT, SELECT, UPDATE   (table-level, no DELETE)
--   app_auth    : User     INSERT, SELECT           (table-level)
--                          UPDATE (lastLoginAt, loginCount, tokenVersion, updatedAt)
--                 Business INSERT, SELECT           (table-level)
--   sequences   : USAGE for both roles
--
-- Note what this does NOT restore: DELETE on either table for app_runtime. That
-- was revoked in AUTH BOUNDARY STEP 1, proven to have no consumer, and is guarded
-- by CI-AD-12a. Rolling the narrowing back must not quietly reopen it.
--
-- The column grants are dropped first. Leaving them in place would be harmless
-- arithmetic — a table grant already implies every column — but it would leave
-- the catalog describing an end state nobody chose, and the next audit would have
-- to work out which of the two was intended.
--
-- One transaction, for the same reason as the forward direction: no request
-- should be able to observe a half-restored contract.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Drop the column-level grants introduced by the narrowing.
-- ---------------------------------------------------------------------------
REVOKE ALL ON public."User"     FROM app_runtime;
REVOKE ALL ON public."Business" FROM app_runtime;
REVOKE ALL ON public."User"     FROM app_auth;
REVOKE ALL ON public."Business" FROM app_auth;

-- ---------------------------------------------------------------------------
-- 2. Restore the pre-narrowing table-level state, exactly.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON public."User"     TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON public."Business" TO app_runtime;

GRANT SELECT, INSERT ON public."User"     TO app_auth;
GRANT SELECT, INSERT ON public."Business" TO app_auth;
GRANT UPDATE ("lastLoginAt", "loginCount", "tokenVersion", "updatedAt")
  ON public."User" TO app_auth;

-- ---------------------------------------------------------------------------
-- 3. Sequences, unchanged in either direction but restated for completeness.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SEQUENCE public."User_id_seq"     TO app_auth;
GRANT USAGE ON SEQUENCE public."Business_id_seq" TO app_auth;

COMMIT;

-- ---------------------------------------------------------------------------
-- Post-rollback verification. Expect exactly:
--   app_auth    | Business | INSERT,SELECT
--   app_auth    | User     | INSERT,SELECT,UPDATE
--   app_runtime | Business | INSERT,SELECT,UPDATE
--   app_runtime | User     | INSERT,SELECT,UPDATE
-- and DELETE absent from all four.
-- ---------------------------------------------------------------------------
-- SELECT grantee, table_name,
--        string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type) AS privs
--   FROM information_schema.role_table_grants
--  WHERE table_schema = 'public'
--    AND table_name IN ('User', 'Business')
--    AND grantee IN ('app_runtime', 'app_auth')
--  GROUP BY grantee, table_name
--  ORDER BY grantee, table_name;
