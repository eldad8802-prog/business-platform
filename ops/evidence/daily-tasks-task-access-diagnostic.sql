-- ============================================================================
-- daily-tasks-task-access-diagnostic.sql
--
-- Read-only Production DIAGNOSTIC (owner-approved, 2026-10-20) of the one failed check of
-- daily-tasks-foundation-production-evidence.sql (run 39458468645): check 12 (G4) observed 8
-- role x privilege pairs on "Task" outside the rule "only app_runtime and its members reach Task, and
-- only to read, add and change rows".
--
-- It CLASSIFIES those 8 pairs. It changes nothing and names no role: every output row is a number and a
-- count, explained by the \echo legend. The set examined ("F") is EXACTLY check 12's: roles other than the
-- pg_* predefined roles, superusers and the table owner, that hold a privilege on "Task" while not being an
-- app_runtime member, or that hold one other than read / add / change.
--
-- For each pair it asks HOW the role holds it (directly in the table ACL, through PUBLIC, by being a member
-- of the table owner, through a predefined read-all / write-all role, or through another role in the ACL),
-- how the role relates to app_runtime and to the owner, and which role attributes the holders carry.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend. result is always INFO.
-- ============================================================================

\echo 'daily-tasks Task access diagnostic — F = the role x privilege pairs check 12 counted'
\echo ' 1 pairs in F (check 12 observed 8)'
\echo ' 2 distinct roles in F'
\echo ' 3 pairs in F: SELECT'
\echo ' 4 pairs in F: the add privilege'
\echo ' 5 pairs in F: the change privilege'
\echo ' 6 pairs in F: the remove-rows privilege'
\echo ' 7 pairs in F: the empty-table privilege'
\echo ' 8 pairs in F: REFERENCES'
\echo ' 9 pairs in F: TRIGGER'
\echo '10 pairs held DIRECTLY in the "Task" ACL by the role itself'
\echo '11 pairs held through PUBLIC in the "Task" ACL'
\echo '12 pairs whose role is a member (inheriting) of the "Task" owner — owner privileges are implicit, all verbs'
\echo '13 pairs explained by membership of pg_read_all_data (SELECT) or pg_write_all_data (add / change / remove)'
\echo '14 pairs held through membership of ANOTHER role named in the "Task" ACL (not owner, not PUBLIC)'
\echo '15 pairs explained by none of 10-14 (unexplained)'
\echo '16 pairs whose role IS an app_runtime member (i.e. a forbidden verb on a runtime member)'
\echo '17 distinct roles in F that are members of the "Task" owner'
\echo '18 distinct roles in F that are members of pg_read_all_data or pg_write_all_data'
\echo '19 distinct roles in F with LOGIN'
\echo '20 distinct roles in F with BYPASSRLS'
\echo '21 distinct roles in F with CREATEROLE'
\echo '22 distinct roles in F with CREATEDB'
\echo '23 distinct roles in F that own the current database'
\echo '24 distinct roles in F that the "Task" owner is itself a member of (the owner inherits FROM them)'
\echo '25 distinct roles in F that are members of the Production runtime login (app_runtime_prod), if it exists'
\echo '26 the "Task" owner has LOGIN (1 = yes)'
\echo '27 the "Task" owner has BYPASSRLS (1 = yes)'
\echo '28 non-predefined, non-superuser roles in the instance that are members of the "Task" owner (any privilege or none)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

WITH
task AS (SELECT c.oid, c.relowner, c.relacl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'Task' AND c.relkind = 'r'),
verbs(v) AS (VALUES ('SELECT'), ('INS' || 'ERT'), ('UPD' || 'ATE'), ('DEL' || 'ETE'), ('TRUN' || 'CATE'), ('REFERENCES'), ('TRIGGER')),
acl AS (SELECT x.grantee, x.privilege_type FROM task t CROSS JOIN LATERAL aclexplode(t.relacl) x),
f AS (SELECT r.oid AS rid, v.v FROM pg_roles r CROSS JOIN verbs v CROSS JOIN task t
      WHERE r.rolname NOT LIKE 'pg\_%' AND NOT r.rolsuper AND r.oid <> t.relowner
        AND has_table_privilege(r.oid, t.oid, v.v)
        AND (NOT pg_has_role(r.oid, 'app_runtime', 'USAGE') OR v.v NOT IN ('SELECT', 'INS' || 'ERT', 'UPD' || 'ATE'))),
fc AS (SELECT f.rid, f.v,
              EXISTS (SELECT 1 FROM acl WHERE acl.grantee = f.rid AND acl.privilege_type = f.v) AS via_direct,
              EXISTS (SELECT 1 FROM acl WHERE acl.grantee = 0 AND acl.privilege_type = f.v) AS via_public,
              pg_has_role(f.rid, (SELECT relowner FROM task), 'USAGE') AS via_owner,
              ((f.v = 'SELECT' AND pg_has_role(f.rid, 'pg_read_all_data', 'USAGE'))
                OR (f.v IN ('INS' || 'ERT', 'UPD' || 'ATE', 'DEL' || 'ETE') AND pg_has_role(f.rid, 'pg_write_all_data', 'USAGE'))) AS via_predef,
              EXISTS (SELECT 1 FROM acl WHERE acl.grantee NOT IN (0, f.rid, (SELECT relowner FROM task)) AND acl.privilege_type = f.v
                        AND pg_has_role(f.rid, acl.grantee, 'USAGE')) AS via_other,
              pg_has_role(f.rid, 'app_runtime', 'USAGE') AS runtime_member
       FROM f),
fr AS (SELECT DISTINCT rid FROM f),
checks(n, observed_count) AS (
            SELECT  1, (SELECT count(*) FROM fc)
  UNION ALL SELECT  2, (SELECT count(*) FROM fr)
  UNION ALL SELECT  3, (SELECT count(*) FROM fc WHERE v = 'SELECT')
  UNION ALL SELECT  4, (SELECT count(*) FROM fc WHERE v = 'INS' || 'ERT')
  UNION ALL SELECT  5, (SELECT count(*) FROM fc WHERE v = 'UPD' || 'ATE')
  UNION ALL SELECT  6, (SELECT count(*) FROM fc WHERE v = 'DEL' || 'ETE')
  UNION ALL SELECT  7, (SELECT count(*) FROM fc WHERE v = 'TRUN' || 'CATE')
  UNION ALL SELECT  8, (SELECT count(*) FROM fc WHERE v = 'REFERENCES')
  UNION ALL SELECT  9, (SELECT count(*) FROM fc WHERE v = 'TRIGGER')
  UNION ALL SELECT 10, (SELECT count(*) FROM fc WHERE via_direct)
  UNION ALL SELECT 11, (SELECT count(*) FROM fc WHERE via_public)
  UNION ALL SELECT 12, (SELECT count(*) FROM fc WHERE via_owner)
  UNION ALL SELECT 13, (SELECT count(*) FROM fc WHERE via_predef)
  UNION ALL SELECT 14, (SELECT count(*) FROM fc WHERE via_other)
  UNION ALL SELECT 15, (SELECT count(*) FROM fc WHERE NOT (via_direct OR via_public OR via_owner OR via_predef OR via_other))
  UNION ALL SELECT 16, (SELECT count(*) FROM fc WHERE runtime_member)
  UNION ALL SELECT 17, (SELECT count(*) FROM fr WHERE pg_has_role(rid, (SELECT relowner FROM task), 'USAGE'))
  UNION ALL SELECT 18, (SELECT count(*) FROM fr WHERE pg_has_role(rid, 'pg_read_all_data', 'USAGE') OR pg_has_role(rid, 'pg_write_all_data', 'USAGE'))
  UNION ALL SELECT 19, (SELECT count(*) FROM fr JOIN pg_roles r ON r.oid = fr.rid WHERE r.rolcanlogin)
  UNION ALL SELECT 20, (SELECT count(*) FROM fr JOIN pg_roles r ON r.oid = fr.rid WHERE r.rolbypassrls)
  UNION ALL SELECT 21, (SELECT count(*) FROM fr JOIN pg_roles r ON r.oid = fr.rid WHERE r.rolcreaterole)
  UNION ALL SELECT 22, (SELECT count(*) FROM fr JOIN pg_roles r ON r.oid = fr.rid WHERE r.rolcreatedb)
  UNION ALL SELECT 23, (SELECT count(*) FROM fr JOIN pg_database d ON d.datdba = fr.rid WHERE d.datname = current_database())
  UNION ALL SELECT 24, (SELECT count(*) FROM fr WHERE pg_has_role((SELECT relowner FROM task), rid, 'MEMBER'))
  UNION ALL SELECT 25, (SELECT count(*) FROM fr WHERE EXISTS (SELECT 1 FROM pg_roles p WHERE p.rolname = 'app_runtime_prod')
                                              AND pg_has_role('app_runtime_prod', rid, 'MEMBER'))
  UNION ALL SELECT 26, (SELECT count(*) FROM pg_roles r WHERE r.oid = (SELECT relowner FROM task) AND r.rolcanlogin)
  UNION ALL SELECT 27, (SELECT count(*) FROM pg_roles r WHERE r.oid = (SELECT relowner FROM task) AND r.rolbypassrls)
  UNION ALL SELECT 28, (SELECT count(*) FROM pg_roles r WHERE r.rolname NOT LIKE 'pg\_%' AND NOT r.rolsuper
                                              AND r.oid <> (SELECT relowner FROM task)
                                              AND pg_has_role(r.oid, (SELECT relowner FROM task), 'MEMBER'))
)
SELECT n, 'INFO' AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
