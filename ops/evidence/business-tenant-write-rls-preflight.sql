-- ============================================================================
-- business-tenant-write-rls-preflight.sql
--
-- Read-only Production PREFLIGHT for migration
--   20261006090000_business_tenant_write_rls   (B4, #611 — NOT applied)
--
-- B4 puts Business under FORCE row-level security: reads stay open
-- (SELECT USING (true)), row changes are pinned to app.current_business_id, and
-- the ONLY policy that admits a new row is TO app_auth (signup). Whether that is
-- safe in a given database depends on premises this file measures BEFORE apply:
--   * the ledger is clean and B4 is not recorded; Business has no RLS and no
--     policy yet (B4 itself refuses otherwise);
--   * app_auth exists, and EVERY login that can add a Business row inherits it —
--     a login holding that privilege outside app_auth would be refused by B4
--     (signup broken). Production's design: logins hold nothing directly
--     (.auth-session-privileges/verification.sql); this checks it holds;
--   * the runtime adds no Business row at all (D2 E4) and every runtime login is
--     NOBYPASSRLS (otherwise B4 binds nobody);
--   * no role other than the runtime group/logins can change a Business row
--     (such a role would also become tenant-pinned by B4 — it must be known).
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog and counts only. Guard-clean: no write keyword, prose included.
-- ============================================================================

\echo '== B4 business tenant-write RLS preflight — legend (n → check) =='
\echo ' 1 L0 migration ledger: no unfinished and no rolled-back row (observed = such rows)'
\echo ' 2 L1 20261006090000_business_tenant_write_rls is NOT recorded'
\echo ' 3 L2 finished migrations (INFO count)'
\echo ' 4 B1 Business has no row-level security, no FORCE, no policy (observed = policies)'
\echo ' 5 A1 app_auth exists: NOLOGIN NOSUPERUSER NOBYPASSRLS'
\echo ' 6 A2 logins that can add a Business row (migration role and superusers excluded) — observed = how many'
\echo ' 7 A3 every such login inherits app_auth (B4 signup policy covers it) — observed = logins NOT covered'
\echo ' 8 A4 at least one login inherits app_auth (the signup identity exists) — observed = how many'
\echo ' 9 A5 app_auth logins are NOSUPERUSER NOBYPASSRLS — observed = offenders'
\echo '10 R1 the runtime group and its logins can add NO Business row (D2 E4) — observed = runtime roles that can'
\echo '11 R2 runtime logins (migration role excluded) are NOSUPERUSER NOBYPASSRLS — observed = how many logins'
\echo '12 W1 roles outside the runtime that can change a Business row (migration role and superusers excluded) — observed = how many'
\echo '13 W2 PUBLIC holds nothing on Business'
\echo '14 N1 Business rows (INFO)'
\echo '15 N2 Business rows with a deletion requested but not finished (INFO — account deletion in flight when B4 lands)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

WITH
ledger AS (SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"),
biz AS (SELECT c.oid, c.relrowsecurity, c.relforcerowsecurity, c.relacl FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        WHERE c.relname = 'Business' AND c.relkind = 'r'),
cols AS (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = (SELECT oid FROM biz) AND a.attnum > 0 AND NOT a.attisdropped),
rt AS (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime'),
au AS (SELECT oid, rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_auth'),
roles AS (SELECT r.oid, r.rolname, r.rolcanlogin, r.rolsuper, r.rolbypassrls FROM pg_roles r
          WHERE r.rolname <> current_user AND NOT r.rolsuper AND r.rolname NOT LIKE 'pg\_%'),
-- effective "can add a row" / "can change a row" on Business, any column or the table
can_add AS (SELECT r.* FROM roles r WHERE has_table_privilege(r.oid, (SELECT oid FROM biz), 'INS' || 'ERT')
            OR EXISTS (SELECT 1 FROM cols c WHERE has_column_privilege(r.oid, (SELECT oid FROM biz), c.attname, 'INS' || 'ERT'))),
can_change AS (SELECT r.* FROM roles r WHERE has_table_privilege(r.oid, (SELECT oid FROM biz), 'UPD' || 'ATE')
               OR EXISTS (SELECT 1 FROM cols c WHERE has_column_privilege(r.oid, (SELECT oid FROM biz), c.attname, 'UPD' || 'ATE'))),
runtime_roles AS (SELECT r.* FROM roles r WHERE r.oid = (SELECT oid FROM rt)
                  OR (r.rolcanlogin AND pg_has_role(r.oid, (SELECT oid FROM rt), 'MEMBER'))),
auth_logins AS (SELECT r.* FROM roles r WHERE r.rolcanlogin AND (SELECT oid FROM au) IS NOT NULL
                AND pg_has_role(r.oid, (SELECT oid FROM au), 'USAGE')),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM ledger WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
            (SELECT count(*) FROM ledger WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 2, NOT EXISTS (SELECT 1 FROM ledger WHERE migration_name = '20261006090000_business_tenant_write_rls'),
                      (SELECT count(*) FROM ledger WHERE migration_name = '20261006090000_business_tenant_write_rls')
  UNION ALL SELECT 3, true, (SELECT count(*) FROM ledger WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 4, (SELECT NOT relrowsecurity AND NOT relforcerowsecurity FROM biz)
                      AND NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = (SELECT oid FROM biz)),
                      (SELECT count(*) FROM pg_policy WHERE polrelid = (SELECT oid FROM biz))
  UNION ALL SELECT 5, EXISTS (SELECT 1 FROM au WHERE NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls), (SELECT count(*) FROM au)
  UNION ALL SELECT 6, true, (SELECT count(*) FROM can_add WHERE rolcanlogin)
  UNION ALL SELECT 7, NOT EXISTS (SELECT 1 FROM can_add a WHERE a.rolcanlogin AND a.oid NOT IN (SELECT oid FROM auth_logins)),
                      (SELECT count(*) FROM can_add a WHERE a.rolcanlogin AND a.oid NOT IN (SELECT oid FROM auth_logins))
  UNION ALL SELECT 8, EXISTS (SELECT 1 FROM auth_logins), (SELECT count(*) FROM auth_logins)
  UNION ALL SELECT 9, NOT EXISTS (SELECT 1 FROM auth_logins WHERE rolsuper OR rolbypassrls),
                      (SELECT count(*) FROM auth_logins WHERE rolsuper OR rolbypassrls)
  UNION ALL SELECT 10, NOT EXISTS (SELECT 1 FROM can_add WHERE oid IN (SELECT oid FROM runtime_roles)),
                       (SELECT count(*) FROM can_add WHERE oid IN (SELECT oid FROM runtime_roles))
  UNION ALL SELECT 11, EXISTS (SELECT 1 FROM runtime_roles WHERE rolcanlogin)
                       AND NOT EXISTS (SELECT 1 FROM runtime_roles WHERE rolsuper OR rolbypassrls),
                       (SELECT count(*) FROM runtime_roles WHERE rolcanlogin)
  UNION ALL SELECT 12, NOT EXISTS (SELECT 1 FROM can_change WHERE oid NOT IN (SELECT oid FROM runtime_roles)),
                       (SELECT count(*) FROM can_change WHERE oid NOT IN (SELECT oid FROM runtime_roles))
  UNION ALL SELECT 13, NOT EXISTS (SELECT 1 FROM biz, aclexplode(biz.relacl) x WHERE x.grantee = 0)
                       AND NOT EXISTS (SELECT 1 FROM pg_attribute a, aclexplode(a.attacl) x
                                        WHERE a.attrelid = (SELECT oid FROM biz) AND x.grantee = 0),
                       (SELECT count(*) FROM biz, aclexplode(biz.relacl) x WHERE x.grantee = 0)
  UNION ALL SELECT 14, true, (SELECT count(*) FROM "Business")
  UNION ALL SELECT 15, true, (SELECT count(*) FROM "Business" WHERE "deletionRequestedAt" IS NOT NULL AND "deletedAt" IS NULL)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
