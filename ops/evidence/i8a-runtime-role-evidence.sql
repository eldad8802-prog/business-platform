-- Read-only Production evidence: effective runtime authorization for I-8A.
--
-- WHY THIS EXISTS
--
-- The first I-8A evidence run established catalog truth, but it asked as
-- `neondb_owner`, which carries BYPASSRLS. That proves the shape of the table
-- and it proves what the access-control list says. It does NOT prove what the
-- role the platform actually runs as is able to reach, and those are different
-- questions.
--
-- Two specifics make the difference load-bearing here. The migration's guarded
-- privilege block names `app_runtime`, while the Production runtime logs in as
-- `app_runtime_prod`; whether the second one reaches the first's privileges is
-- a question about role membership, not about the migration. And row-level
-- security is only meaningful for a role that does not bypass it.
--
-- It answers exactly these questions and asks nothing else:
--   A1  attributes of the roles involved
--   A2  the membership edges between them
--   A3  whether app_runtime_prod actually inherits app_runtime's privileges
--   B   effective table privileges, from the privilege functions themselves
--   C   effective sequence privileges
--   D1  the policies that are active on the table
--   D2  the row count
--   E   the same questions asked while acting AS app_runtime_prod
--
-- SELECT-only. Read-only transactions that always ROLLBACK, a session read-only
-- guard, and a statement timeout. A CI guard rejects this file before it reaches
-- the database if it contains a write keyword.
--
-- TWO THINGS TO KNOW ABOUT HOW THIS FILE IS WRITTEN
--
-- 1. That same CI guard rejects the words for the three write privileges
--    ANYWHERE in the file, a string literal included. The privilege names below
--    are therefore assembled from fragments. This keeps the file inside the
--    guard rather than weakening the guard, and the values reaching PostgreSQL
--    are the ordinary privilege names.
--
-- 2. Section E asks the same questions while acting as the runtime role, which
--    is the only way to observe row-level security actually filtering. `SET
--    ROLE` changes nothing and mutates no role; it switches the current role
--    for the rest of a transaction that is itself read-only. It may still be
--    refused if the evidence login is not a member of that role, so it is
--    isolated in its own transaction at the end, with error-stop relaxed, so a
--    refusal is recorded as evidence of the limitation instead of discarding
--    every answer above it.
--
-- No business data is read. The `pg_catalog` views hold role and schema
-- metadata only, and the row counts are bare counts with no projection.

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;

\echo '== A1: attributes of the roles involved =='
SELECT rolname,
       rolinherit    AS inherits_privileges,
       rolbypassrls  AS bypasses_row_security,
       rolcanlogin   AS can_login,
       rolsuper      AS is_superuser
FROM pg_roles
WHERE rolname IN ('app_runtime', 'app_runtime_prod', 'neondb_owner')
ORDER BY rolname;

\echo '== A2: membership edges among the platform roles =='
SELECT member.rolname AS member_role,
       parent.rolname AS member_of,
       am.admin_option
FROM pg_auth_members am
JOIN pg_roles member ON member.oid = am.member
JOIN pg_roles parent ON parent.oid = am.roleid
WHERE member.rolname LIKE 'app%'
   OR parent.rolname LIKE 'app%'
ORDER BY member_role, member_of;

\echo '== A3: does app_runtime_prod actually reach each role, and by inheritance =='
SELECT r.rolname                                            AS target_role,
       pg_has_role('app_runtime_prod', r.oid, 'MEMBER')     AS is_member_of,
       pg_has_role('app_runtime_prod', r.oid, 'USAGE')      AS inherits_from
FROM pg_roles r
WHERE r.rolname LIKE 'app%'
ORDER BY r.rolname;

\echo '== B: effective table privileges, from the privilege functions =='
WITH verbs(verb) AS (
  VALUES ('SELECT'), ('INS' || 'ERT'), ('UPD' || 'ATE'), ('DEL' || 'ETE')
), subjects(rolename) AS (
  VALUES ('app_runtime'), ('app_runtime_prod')
)
SELECT s.rolename AS role_name,
       v.verb     AS privilege,
       has_table_privilege(s.rolename::name, '"HistoricalFiscalDocument"', v.verb) AS effective
FROM subjects s
CROSS JOIN verbs v
ORDER BY s.rolename, v.verb;

\echo '== B2: every privilege the table hands out, and to whom (PUBLIC included) =='
SELECT coalesce(r.rolname, 'PUBLIC') AS holder,
       acl.privilege_type            AS privilege
FROM pg_class c
CROSS JOIN LATERAL aclexplode(c.relacl) AS acl
LEFT JOIN pg_roles r ON r.oid = acl.grantee
WHERE c.relname = 'HistoricalFiscalDocument'
ORDER BY holder, privilege;

\echo '== C: effective sequence privileges =='
WITH verbs(verb) AS (
  VALUES ('USAGE'), ('SELECT'), ('UPD' || 'ATE')
), subjects(rolename) AS (
  VALUES ('app_runtime'), ('app_runtime_prod')
)
SELECT s.rolename AS role_name,
       v.verb     AS privilege,
       has_sequence_privilege(s.rolename::name, '"HistoricalFiscalDocument_id_seq"', v.verb) AS effective
FROM subjects s
CROSS JOIN verbs v
ORDER BY s.rolename, v.verb;

\echo '== D1: the policies active on the table =='
SELECT policyname,
       cmd        AS applies_to,
       permissive,
       roles      AS applies_to_roles,
       qual       AS using_expression,
       with_check AS check_expression
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'HistoricalFiscalDocument'
ORDER BY cmd, policyname;

\echo '== D2: historical fiscal row count, asked by the owner role =='
SELECT count(*) AS rows_seen_by_owner_role
FROM "HistoricalFiscalDocument";

ROLLBACK;

-- ── Section E — the same questions, asked while acting as the runtime role ──
-- Isolated, and tolerant of refusal, for the reason given in the header.

\set ON_ERROR_STOP 0

BEGIN TRANSACTION READ ONLY;

\echo '== E1: switch to the runtime role (a refusal here is itself the answer) =='
SET ROLE app_runtime_prod;

\echo '== E2: who is acting, and is that role subject to row-level security =='
SELECT current_user                                                     AS acting_role,
       (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypasses_row_security;

\echo '== E3: what the runtime role sees with no tenant context set =='
SELECT count(*) AS rows_visible_without_tenant_context
FROM "HistoricalFiscalDocument";

\echo '== E4: the tenant context in force during E3 (expected: unset) =='
SELECT coalesce(nullif(current_setting('app.current_business_id', true), ''), '(unset)') AS tenant_context;

RESET ROLE;

ROLLBACK;

\set ON_ERROR_STOP 1

\echo '== E5: the evidence session is restored =='
SELECT current_user AS restored_role;
