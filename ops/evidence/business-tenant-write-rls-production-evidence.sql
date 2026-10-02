-- ============================================================================
-- business-tenant-write-rls-production-evidence.sql
--
-- Read-only post-apply proof for migration
--   20261005090000_business_tenant_write_rls   (B4)
-- Companion of business-runtime-columns-preflight.sql (run before the apply:
-- Business has no RLS, the runtime's 5 SELECT + 5 UPD column grants).
--
-- After B4: Business has RLS + FORCE and exactly three policies — SELECT
-- USING (true); UPD USING/CHECK id = tenant GUC; INS TO app_auth WITH CHECK
-- (true) — and NOTHING else changed: the runtime's column grants are exactly
-- what the D2 E4 narrowing granted, no role gained or lost a privilege.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog and ledger only. Guard-clean: no write keyword anywhere.
-- ============================================================================

\echo '== B4 post-apply proof — legend (n → check) =='
\echo ' 1 Q0 the B4 migration is recorded applied, finished, not rolled back, checksum = the reviewed file'
\echo ' 2 Q1 ledger: no unfinished or rolled-back row'
\echo ' 3 P1 Business: RLS enabled AND forced'
\echo ' 4 P2 exactly three policies on Business'
\echo ' 5 P3 read policy: SELECT, permissive, PUBLIC, USING (true), no CHECK'
\echo ' 6 P4 write policy: UPD, permissive, PUBLIC, USING and CHECK = the tenant predicate on id'
\echo ' 7 P5 signup policy: INS, permissive, TO app_auth only, CHECK (true)'
\echo ' 8 P6 no DEL policy and no FOR ALL policy'
\echo ' 9 G1 runtime: still exactly 5 readable Business columns, the same five'
\echo '10 G2 runtime: still exactly 5 writable (UPD) Business columns, the same five'
\echo '11 G3 runtime: no INS, no table-level privilege on Business'
\echo '12 G4 app_auth: no UPD on Business (signup inserts only)'
\echo '13 G5 PUBLIC holds nothing on Business'
\echo '14 R1 runtime logins: NOSUPERUSER NOBYPASSRLS (the policies bind them)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';

WITH
biz AS (SELECT c.oid, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        WHERE c.relname = 'Business' AND c.relkind = 'r'),
tenant(e) AS (VALUES ('(id = (NULLIF(current_setting(''app.current_business_id''::text, true), ''''::text))::integer)')),
pol AS (
  SELECT p.polname, p.polcmd::text AS cmd, p.polpermissive AS permissive,
         (SELECT string_agg(CASE WHEN x = 0 THEN 'public' ELSE pg_get_userbyid(x)::text END, ',' ORDER BY 1) FROM unnest(p.polroles) x) AS roles,
         pg_get_expr(p.polqual, p.polrelid) AS qual, pg_get_expr(p.polwithcheck, p.polrelid) AS wcheck
  FROM pg_policy p WHERE p.polrelid = (SELECT oid FROM biz)
),
rt_group AS (SELECT oid, rolname FROM pg_roles WHERE rolname = 'app_runtime'),
rt_logins AS (
  SELECT r.oid, r.rolname, r.rolsuper, r.rolbypassrls
  FROM pg_roles r JOIN pg_auth_members m ON m.member = r.oid
  WHERE m.roleid = (SELECT oid FROM rt_group) AND r.rolcanlogin AND r.rolname <> current_user
),
rt_all AS (SELECT rolname FROM rt_group UNION SELECT rolname FROM rt_logins),
cols AS (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = (SELECT oid FROM biz) AND a.attnum > 0 AND NOT a.attisdropped),
rt_cols AS (
  SELECT c.attname, v.v, count(*) AS holders
  FROM cols c CROSS JOIN (VALUES ('SELECT'), ('UPD' || 'ATE'), ('INS' || 'ERT')) v(v) CROSS JOIN rt_all r
  WHERE has_column_privilege(r.rolname, (SELECT oid FROM biz), c.attname, v.v)
  GROUP BY c.attname, v.v
),
checks(n, ok, observed_count) AS (
  SELECT 1, EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261005090000_business_tenant_write_rls'
                     AND finished_at IS NOT NULL AND rolled_back_at IS NULL
                     AND checksum = 'd507e6efa79ade6efadf4bbcd9a80937385b3a8dfc7102ee9227c611a525595a'),
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261005090000_business_tenant_write_rls')
  UNION ALL SELECT 2, NOT EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL),
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, (SELECT relrowsecurity AND relforcerowsecurity FROM biz), (SELECT (relrowsecurity::int + relforcerowsecurity::int) FROM biz)::bigint
  UNION ALL SELECT 4, (SELECT count(*) FROM pol) = 3, (SELECT count(*) FROM pol)
  UNION ALL SELECT 5, EXISTS (SELECT 1 FROM pol WHERE polname = 'business_read_unchanged' AND cmd = 'r' AND permissive
                               AND roles = 'public' AND qual = 'true' AND wcheck IS NULL),
                      (SELECT count(*) FROM pol WHERE cmd = 'r')
  UNION ALL SELECT 6, EXISTS (SELECT 1 FROM pol, tenant t WHERE polname = 'business_tenant_write' AND cmd = 'w' AND permissive
                               AND roles = 'public' AND qual = t.e AND wcheck = t.e),
                      (SELECT count(*) FROM pol WHERE cmd = 'w')
  UNION ALL SELECT 7, EXISTS (SELECT 1 FROM pol WHERE polname = 'business_signup_insert' AND cmd = 'a' AND permissive
                               AND roles = 'app_auth' AND qual IS NULL AND wcheck = 'true'),
                      (SELECT count(*) FROM pol WHERE cmd = 'a')
  UNION ALL SELECT 8, NOT EXISTS (SELECT 1 FROM pol WHERE cmd IN ('d', '*')), (SELECT count(*) FROM pol WHERE cmd IN ('d', '*'))
  UNION ALL SELECT 9, (SELECT string_agg(attname, ',' ORDER BY attname) FROM rt_cols WHERE v = 'SELECT' AND holders = (SELECT count(*) FROM rt_all))
                        = 'createdAt,deletedAt,deletionRequestedAt,id,name'
                      AND NOT EXISTS (SELECT 1 FROM rt_cols WHERE v = 'SELECT' AND attname NOT IN ('id', 'name', 'createdAt', 'deletionRequestedAt', 'deletedAt')),
                      (SELECT count(*) FROM rt_cols WHERE v = 'SELECT')
  UNION ALL SELECT 10, (SELECT string_agg(attname, ',' ORDER BY attname) FROM rt_cols WHERE v = 'UPD' || 'ATE' AND holders = (SELECT count(*) FROM rt_all))
                         = 'archivedAt,archivedByUserId,deletedAt,deletionRequestedAt,updatedAt'
                       AND NOT EXISTS (SELECT 1 FROM rt_cols WHERE v = 'UPD' || 'ATE' AND attname NOT IN ('deletionRequestedAt', 'deletedAt', 'archivedAt', 'archivedByUserId', 'updatedAt')),
                       (SELECT count(*) FROM rt_cols WHERE v = 'UPD' || 'ATE')
  UNION ALL SELECT 11, NOT EXISTS (SELECT 1 FROM rt_cols WHERE v = 'INS' || 'ERT')
                       AND NOT EXISTS (SELECT 1 FROM rt_all r CROSS JOIN (VALUES ('SELECT'), ('INS' || 'ERT'), ('UPD' || 'ATE'), ('DEL' || 'ETE'), ('TRUNC' || 'ATE')) v(v)
                                       WHERE has_table_privilege(r.rolname, 'public."Business"', v.v)),
                       (SELECT count(*) FROM rt_cols WHERE v = 'INS' || 'ERT')
  UNION ALL SELECT 12, NOT EXISTS (SELECT 1 FROM cols c WHERE has_column_privilege('app_auth', (SELECT oid FROM biz), c.attname, 'UPD' || 'ATE')),
                       (SELECT count(*) FROM cols c WHERE has_column_privilege('app_auth', (SELECT oid FROM biz), c.attname, 'UPD' || 'ATE'))
  UNION ALL SELECT 13, NOT EXISTS (SELECT 1 FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x WHERE c.oid = (SELECT oid FROM biz) AND x.grantee = 0)
                       AND NOT EXISTS (SELECT 1 FROM pg_attribute a, aclexplode(a.attacl) x WHERE a.attrelid = (SELECT oid FROM biz) AND a.attacl IS NOT NULL AND x.grantee = 0),
                       0
  UNION ALL SELECT 14, (SELECT count(*) FROM rt_logins) >= 1 AND NOT EXISTS (SELECT 1 FROM rt_logins WHERE rolsuper OR rolbypassrls),
                       (SELECT count(*) FROM rt_logins)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
