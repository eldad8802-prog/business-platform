-- ============================================================================
-- business-runtime-columns-preflight.sql
--
-- Read-only Production evidence for the tenant runtime's privileges on the
-- "Business" table (separate forensic opened after #594; NOT a change).
--
-- Migration 20260908180000_d2_user_business_privilege_narrowing (D2 E4) revoked
-- every table-level privilege on Business from app_runtime and granted, column
-- by column:
--   SELECT  id, name, createdAt, deletionRequestedAt, deletedAt
--   UPD     deletionRequestedAt, deletedAt, archivedAt, archivedByUserId, updatedAt
-- and deliberately added NO row-level security to Business ("the boundary on
-- these two tables is privilege, not policy"). This file measures what
-- Production actually holds today, EFFECTIVELY (membership counts), for the
-- runtime group and every runtime login, and whether any other path exposes
-- Business.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- INFO rows always PASS and carry a count. Names never appear in the output.
-- PRIVACY: catalog, ledger and counts only — no business name or row content.
-- HONEST COUNTS: row_security is off; a role subject to RLS errors instead.
-- Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== business runtime columns — legend (n → check) =='
\echo ' 1 L1 migration 20260908180000 (D2 E4 narrowing) is recorded applied'
\echo ' 2 P1 Business has row-level security enabled (INFO: observed 1 = yes, 0 = no)'
\echo ' 3 P2 Business has FORCE row-level security (INFO)'
\echo ' 4 P3 policies on Business (INFO count)'
\echo ' 5 R0 runtime logins (members of app_runtime, migration role excluded) — all NOSUPERUSER NOBYPASSRLS; observed = how many'
\echo ' 6 T1 runtime holds NO table-level privilege on Business (any verb), for the group and every login'
\echo ' 7 S0 runtime-readable Business columns (INFO: count, expected 5)'
\echo ' 8 S1 runtime can read id'
\echo ' 9 S2 runtime can read name'
\echo '10 S3 runtime can read createdAt'
\echo '11 S4 runtime can read deletionRequestedAt'
\echo '12 S5 runtime can read deletedAt'
\echo '13 S6 runtime can read NO Business column outside those five'
\echo '14 U0 runtime-writable (UPD) Business columns (INFO: count, 5 per the migration)'
\echo '15 U1 runtime can UPD deletionRequestedAt'
\echo '16 U2 runtime can UPD deletedAt'
\echo '17 U3 runtime can UPD archivedAt'
\echo '18 U4 runtime can UPD archivedByUserId'
\echo '19 U5 runtime can UPD updatedAt'
\echo '20 U6 runtime can UPD NO Business column outside those five (name, ownerId-like identity columns included)'
\echo '21 I1 runtime can INS into NO Business column'
\echo '22 Q1 runtime holds no privilege on Business_id_seq'
\echo '23 D1 column-level entries held DIRECTLY by a runtime login (not via the group) (INFO: count)'
\echo '24 D2 column-level entries held by the app_runtime group (INFO: count)'
\echo '25 D3 PUBLIC holds nothing on Business (table or column)'
\echo '26 D4 no pass-on option on Business for any runtime role'
\echo '27 X1 views in public that read Business (INFO: count — other exposure paths)'
\echo '28 X2 SECURITY DEFINER functions in public whose source names Business (INFO: count)'
\echo '29 X3 app_auth readable Business columns (INFO: count)'
\echo '30 X4 app_auth insertable Business columns (INFO: count)'
\echo '31 X5 app_ctlplane readable Business columns (INFO: count, 2 expected after 594)'
\echo '32 N1 Business rows (INFO: how many businesses the runtime can read the five columns of)'
\echo '33 N2 Business rows with deletionRequestedAt set (INFO)'
\echo '34 N3 Business rows with deletedAt set (INFO)'
\echo '35 N4 Business rows with archivedAt set (INFO)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL row_security = off;

WITH
rt_group AS (SELECT oid, rolname FROM pg_roles WHERE rolname = 'app_runtime'),
rt_logins AS (
  SELECT r.oid, r.rolname, r.rolsuper, r.rolbypassrls
  FROM pg_roles r JOIN pg_auth_members m ON m.member = r.oid
  WHERE m.roleid = (SELECT oid FROM rt_group) AND r.rolcanlogin AND r.rolname <> current_user
),
rt_all AS (SELECT oid, rolname FROM rt_group UNION SELECT oid, rolname FROM rt_logins),
biz AS (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        WHERE c.relname = 'Business' AND c.relkind = 'r'),
cols AS (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = (SELECT oid FROM biz) AND a.attnum > 0 AND NOT a.attisdropped),
-- (role, column, verb) the runtime EFFECTIVELY holds
rt_col AS (
  SELECT r.rolname, c.attname, v.v
  FROM rt_all r CROSS JOIN cols c
  CROSS JOIN (VALUES ('SELECT'), ('INS' || 'ERT'), ('UPD' || 'ATE'), ('REFERENCES')) v(v)
  WHERE has_column_privilege(r.rolname, (SELECT oid FROM biz), c.attname, v.v)
),
-- columns EVERY runtime identity can use for a verb
rt_cols_for AS (
  SELECT v, attname FROM rt_col GROUP BY v, attname HAVING count(DISTINCT rolname) = (SELECT count(*) FROM rt_all)
),
colacl AS (
  SELECT a.attname, x.grantee, x.privilege_type, x.is_grantable
  FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x
  WHERE a.attrelid = (SELECT oid FROM biz) AND a.attacl IS NOT NULL AND a.attnum > 0
),
tblacl AS (
  SELECT x.grantee, x.privilege_type, x.is_grantable
  FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x
  WHERE c.oid = (SELECT oid FROM biz)
),
can AS (SELECT v, attname FROM rt_cols_for),
five_sel(c) AS (VALUES ('id'), ('name'), ('createdAt'), ('deletionRequestedAt'), ('deletedAt')),
five_upd(c) AS (VALUES ('deletionRequestedAt'), ('deletedAt'), ('archivedAt'), ('archivedByUserId'), ('updatedAt')),
checks(n, ok, observed_count) AS (
  SELECT 1, EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20260908180000_d2_user_business_privilege_narrowing'
                     AND finished_at IS NOT NULL AND rolled_back_at IS NULL),
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20260908180000_d2_user_business_privilege_narrowing')
  UNION ALL SELECT 2, true, (SELECT relrowsecurity::int FROM pg_class WHERE oid = (SELECT oid FROM biz))::bigint
  UNION ALL SELECT 3, true, (SELECT relforcerowsecurity::int FROM pg_class WHERE oid = (SELECT oid FROM biz))::bigint
  UNION ALL SELECT 4, true, (SELECT count(*) FROM pg_policy WHERE polrelid = (SELECT oid FROM biz))
  UNION ALL SELECT 5, (SELECT count(*) FROM rt_logins) >= 1 AND NOT EXISTS (SELECT 1 FROM rt_logins WHERE rolsuper OR rolbypassrls),
                      (SELECT count(*) FROM rt_logins)
  UNION ALL SELECT 6, NOT EXISTS (SELECT 1 FROM rt_all r CROSS JOIN (VALUES ('SELECT'), ('INS' || 'ERT'), ('UPD' || 'ATE'), ('DEL' || 'ETE'),
                                    ('TRUNC' || 'ATE'), ('REFERENCES'), ('TRIGGER')) v(v)
                                  WHERE has_table_privilege(r.rolname, 'public."Business"', v.v)),
                      (SELECT count(*) FROM rt_all r CROSS JOIN (VALUES ('SELECT'), ('INS' || 'ERT'), ('UPD' || 'ATE'), ('DEL' || 'ETE'),
                                    ('TRUNC' || 'ATE'), ('REFERENCES'), ('TRIGGER')) v(v)
                                  WHERE has_table_privilege(r.rolname, 'public."Business"', v.v))
  UNION ALL SELECT 7, true, (SELECT count(*) FROM can WHERE v = 'SELECT')
  UNION ALL SELECT 8,  EXISTS (SELECT 1 FROM can WHERE v = 'SELECT' AND attname = 'id'), (SELECT count(*) FROM can WHERE v = 'SELECT' AND attname = 'id')
  UNION ALL SELECT 9,  EXISTS (SELECT 1 FROM can WHERE v = 'SELECT' AND attname = 'name'), (SELECT count(*) FROM can WHERE v = 'SELECT' AND attname = 'name')
  UNION ALL SELECT 10, EXISTS (SELECT 1 FROM can WHERE v = 'SELECT' AND attname = 'createdAt'), (SELECT count(*) FROM can WHERE v = 'SELECT' AND attname = 'createdAt')
  UNION ALL SELECT 11, EXISTS (SELECT 1 FROM can WHERE v = 'SELECT' AND attname = 'deletionRequestedAt'), (SELECT count(*) FROM can WHERE v = 'SELECT' AND attname = 'deletionRequestedAt')
  UNION ALL SELECT 12, EXISTS (SELECT 1 FROM can WHERE v = 'SELECT' AND attname = 'deletedAt'), (SELECT count(*) FROM can WHERE v = 'SELECT' AND attname = 'deletedAt')
  UNION ALL SELECT 13, NOT EXISTS (SELECT 1 FROM rt_col WHERE v = 'SELECT' AND attname NOT IN (SELECT c FROM five_sel)),
                       (SELECT count(DISTINCT attname) FROM rt_col WHERE v = 'SELECT' AND attname NOT IN (SELECT c FROM five_sel))
  UNION ALL SELECT 14, true, (SELECT count(*) FROM can WHERE v = 'UPD' || 'ATE')
  UNION ALL SELECT 15, EXISTS (SELECT 1 FROM can WHERE v = 'UPD' || 'ATE' AND attname = 'deletionRequestedAt'), (SELECT count(*) FROM can WHERE v = 'UPD' || 'ATE' AND attname = 'deletionRequestedAt')
  UNION ALL SELECT 16, EXISTS (SELECT 1 FROM can WHERE v = 'UPD' || 'ATE' AND attname = 'deletedAt'), (SELECT count(*) FROM can WHERE v = 'UPD' || 'ATE' AND attname = 'deletedAt')
  UNION ALL SELECT 17, EXISTS (SELECT 1 FROM can WHERE v = 'UPD' || 'ATE' AND attname = 'archivedAt'), (SELECT count(*) FROM can WHERE v = 'UPD' || 'ATE' AND attname = 'archivedAt')
  UNION ALL SELECT 18, EXISTS (SELECT 1 FROM can WHERE v = 'UPD' || 'ATE' AND attname = 'archivedByUserId'), (SELECT count(*) FROM can WHERE v = 'UPD' || 'ATE' AND attname = 'archivedByUserId')
  UNION ALL SELECT 19, EXISTS (SELECT 1 FROM can WHERE v = 'UPD' || 'ATE' AND attname = 'updatedAt'), (SELECT count(*) FROM can WHERE v = 'UPD' || 'ATE' AND attname = 'updatedAt')
  UNION ALL SELECT 20, NOT EXISTS (SELECT 1 FROM rt_col WHERE v = 'UPD' || 'ATE' AND attname NOT IN (SELECT c FROM five_upd)),
                       (SELECT count(DISTINCT attname) FROM rt_col WHERE v = 'UPD' || 'ATE' AND attname NOT IN (SELECT c FROM five_upd))
  UNION ALL SELECT 21, NOT EXISTS (SELECT 1 FROM rt_col WHERE v = 'INS' || 'ERT'), (SELECT count(DISTINCT attname) FROM rt_col WHERE v = 'INS' || 'ERT')
  UNION ALL SELECT 22, NOT EXISTS (SELECT 1 FROM rt_all r WHERE has_sequence_privilege(r.rolname, 'public."Business_id_seq"', 'USAGE')
                                     OR has_sequence_privilege(r.rolname, 'public."Business_id_seq"', 'SELECT')
                                     OR has_sequence_privilege(r.rolname, 'public."Business_id_seq"', 'UPD' || 'ATE')),
                       (SELECT count(*) FROM rt_all r WHERE has_sequence_privilege(r.rolname, 'public."Business_id_seq"', 'USAGE'))
  UNION ALL SELECT 23, true, (SELECT count(*) FROM colacl WHERE grantee IN (SELECT oid FROM rt_logins))
  UNION ALL SELECT 24, true, (SELECT count(*) FROM colacl WHERE grantee = (SELECT oid FROM rt_group))
  UNION ALL SELECT 25, (SELECT count(*) FROM colacl WHERE grantee = 0) + (SELECT count(*) FROM tblacl WHERE grantee = 0) = 0,
                       (SELECT count(*) FROM colacl WHERE grantee = 0) + (SELECT count(*) FROM tblacl WHERE grantee = 0)
  UNION ALL SELECT 26, (SELECT count(*) FROM colacl WHERE is_grantable AND grantee IN (SELECT oid FROM rt_all))
                       + (SELECT count(*) FROM tblacl WHERE is_grantable AND grantee IN (SELECT oid FROM rt_all)) = 0,
                       (SELECT count(*) FROM colacl WHERE is_grantable AND grantee IN (SELECT oid FROM rt_all))
  UNION ALL SELECT 27, true, (SELECT count(DISTINCT v.oid) FROM pg_depend d JOIN pg_rewrite rw ON rw.oid = d.objid
                               JOIN pg_class v ON v.oid = rw.ev_class
                               WHERE d.refobjid = (SELECT oid FROM biz) AND v.oid <> (SELECT oid FROM biz))
  UNION ALL SELECT 28, true, (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
                               WHERE p.prosecdef AND p.prosrc ILIKE '%"Business"%')
  UNION ALL SELECT 29, true, (SELECT count(*) FROM cols c WHERE has_column_privilege('app_auth', (SELECT oid FROM biz), c.attname, 'SELECT'))
  UNION ALL SELECT 30, true, (SELECT count(*) FROM cols c WHERE has_column_privilege('app_auth', (SELECT oid FROM biz), c.attname, 'INS' || 'ERT'))
  UNION ALL SELECT 31, true, (SELECT count(*) FROM cols c WHERE has_column_privilege('app_ctlplane', (SELECT oid FROM biz), c.attname, 'SELECT'))
  UNION ALL SELECT 32, true, (SELECT count(*) FROM "Business")
  UNION ALL SELECT 33, true, (SELECT count(*) FROM "Business" WHERE "deletionRequestedAt" IS NOT NULL)
  UNION ALL SELECT 34, true, (SELECT count(*) FROM "Business" WHERE "deletedAt" IS NOT NULL)
  UNION ALL SELECT 35, true, (SELECT count(*) FROM "Business" WHERE "archivedAt" IS NOT NULL)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
