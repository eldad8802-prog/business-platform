-- sec(C) / M-14(b) — DEFAULT-DENY for new tables (owner runbook; NOT a migration).
--
-- PROBLEM. The project's databases carry ALTER DEFAULT PRIVILEGES entries (created
-- outside the repository) that hand the tenant runtime a,r,w,d (and sequence
-- usage) on EVERY new table the migration owner creates — see the notes in
-- 20260907120000_i8a_historical_fiscal_documents (:150-153) and
-- 20260924180000_m5_collection_action_append_only (:5-10). So a new table is fully
-- writable by the runtime before anyone decides it should be, and an append-only
-- table has to REVOKE what it never asked for.
--
-- EFFECT. Removes every default ACL entry, owned by :OWNER_ROLE, that grants
-- anything on tables or sequences to the runtime group `app_runtime` or to any of
-- its members (e.g. app_runtime_prod / app_runtime_preview), in the public schema
-- and globally. Existing tables keep exactly the grants they have today — default
-- privileges only act at CREATE time. From now on each migration grants its new
-- table explicitly (the convention m3/m5/i8a already follow).
--
-- RUN (per environment, as the migration owner or a member of it):
--   psql "$OWNER_URL" -v ON_ERROR_STOP=1 -v OWNER_ROLE=neondb_owner \
--        -f ops/security/sec-c-default-privileges.sql
-- VERIFY: the script prints before/after counts; afterwards
--   ops/evidence/security-catalog-assert.sql A6 must be PASS.
-- ROLLBACK (restores the old behaviour — not recommended):
--   ALTER DEFAULT PRIVILEGES FOR ROLE <owner> IN SCHEMA public
--     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
--   ALTER DEFAULT PRIVILEGES FOR ROLE <owner> IN SCHEMA public
--     GRANT USAGE, SELECT ON SEQUENCES TO app_runtime;
--
-- Guarded: refuses to run unless OWNER_ROLE is given, exists, and the session may
-- act for it. Prints counts only.

\set ON_ERROR_STOP on
\if :{?OWNER_ROLE}
\else
  DO $$ BEGIN RAISE EXCEPTION 'DENY: pass -v OWNER_ROLE=<the role that owns/creates the tables>'; END $$;
\endif

SELECT set_config('secc.owner_role', :'OWNER_ROLE', false) AS owner_role_set \gset

BEGIN;

DO $$
DECLARE
  o text := current_setting('secc.owner_role');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = o) THEN
    RAISE EXCEPTION 'DENY: OWNER_ROLE % does not exist', o;
  END IF;
  IF NOT pg_has_role(current_user, o, 'MEMBER') THEN
    RAISE EXCEPTION 'DENY: % may not act for %', current_user, o;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    RAISE EXCEPTION 'DENY: no app_runtime group in this database cluster';
  END IF;
END
$$;

CREATE TEMP VIEW secc_runtime_default_acl AS
  SELECT d.oid, d.defaclnamespace, d.defaclobjtype, g.grantee
    FROM pg_default_acl d
    CROSS JOIN LATERAL aclexplode(d.defaclacl) g
   WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = current_setting('secc.owner_role'))
     AND d.defaclobjtype IN ('r', 'S')
     AND (g.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime')
          OR g.grantee IN (SELECT member FROM pg_auth_members
                            WHERE roleid = (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime')));

SELECT 'before' AS phase, count(*) AS runtime_default_acl_grants FROM secc_runtime_default_acl;

DO $$
DECLARE
  r record;
  o text := current_setting('secc.owner_role');
BEGIN
  FOR r IN
    SELECT DISTINCT defaclnamespace, defaclobjtype, grantee FROM secc_runtime_default_acl
  LOOP
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I %s REVOKE ALL ON %s FROM %I',
      o,
      CASE WHEN r.defaclnamespace = 0 THEN '' ELSE 'IN SCHEMA ' || quote_ident(r.defaclnamespace::regnamespace::text) END,
      CASE r.defaclobjtype WHEN 'r' THEN 'TABLES' ELSE 'SEQUENCES' END,
      pg_get_userbyid(r.grantee));
  END LOOP;
END
$$;

SELECT 'after' AS phase, count(*) AS runtime_default_acl_grants FROM secc_runtime_default_acl;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM secc_runtime_default_acl) THEN
    RAISE EXCEPTION 'default ACL entries for the runtime remain — rolled back';
  END IF;
END
$$;

COMMIT;
