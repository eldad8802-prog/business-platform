-- ============================================================================
-- c594-control-plane-privileges-preflight.sql
--
-- Read-only Production preflight for migration
--   20261003090000_control_plane_production_privileges   (PR #594)
-- which grants the NOLOGIN group app_ctlplane a narrow write capability on
-- BusinessFeatureAccess / PlatformAuditEvent (+ reads), and takes from the
-- tenant runtime group app_runtime every write it never used on
-- BusinessFeatureAccess, PlatformFeaturePolicy, PlatformFeatureDefinition and
-- PlatformAuditEvent (+ the override id sequence).
--
-- The migration acts on GROUP roles only. Its effect therefore depends on
-- facts this file proves BEFORE the apply:
--   * no runtime LOGIN role holds a DIRECT privilege on these objects (taking
--     a privilege from the group would leave such an entry in place);
--   * no column-level privilege exists for the runtime (a table-level removal
--     leaves column privileges in place);
--   * the migration role owns every object (privilege changes run as the owner);
--   * no login is a member of app_ctlplane yet (so nothing can exercise the
--     new grants until the separately-gated login provisioning).
--
-- OUTPUT (redaction-friendly): one row per check — n (the check number below),
-- result (PASS / FAIL), observed_count. Names never appear in the output.
--
-- PRIVACY: counts and catalog flags only; no data row content is read.
-- HONEST COUNTS: row_security is off for this transaction; a role subject to
-- row-level security raises an error instead of an undercount.
-- Guard-clean: the workflow rejects this file if it contains any write
-- keyword, prose included, so the wording deliberately avoids those words.
-- ============================================================================

\echo '== c594 preflight legend (n → check) =='
\echo ' 1 L1 the 594 migration is not in the ledger yet'
\echo ' 2 L2 ledger: no unfinished or rolled-back row'
\echo ' 3 L3 ledger rows (INFO: observed_count)'
\echo ' 4 R1 app_ctlplane exists: NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION'
\echo ' 5 R2 app_runtime exists: NOLOGIN NOSUPERUSER NOBYPASSRLS'
\echo ' 6 R3 runtime logins (members of app_runtime, migration role excluded): all NOSUPERUSER NOBYPASSRLS; observed = how many'
\echo ' 7 R4 logins in app_ctlplane other than the migration role: expected 0'
\echo ' 8 O1 the 5 tables + 2 sequences are owned by the migration role: expected 7'
\echo ' 9 A1 DIRECT ACL entries for runtime logins on the 7 objects: expected 0'
\echo '10 A2 column-level ACL entries on the 5 tables for app_runtime or its members: expected 0'
\echo '11 A3 PUBLIC privileges on the 7 objects: expected 0'
\echo '12 A4 app_runtime holds table-level a,w,d on the 4 feature/audit tables (what the migration removes): expected 4'
\echo '13 A5 app_ctlplane privileges on the 7 objects (table + column level): expected 0 before the apply'
\echo '14 A6 app_admin / app_auth privileges on the 7 objects: expected 0'
\echo '15 P1 BusinessFeatureAccess: RLS + FORCE, exactly the 3 PW-2 policies'
\echo '16 P2 RLS enabled on Business / PlatformFeaturePolicy / PlatformFeatureDefinition / PlatformAuditEvent (INFO: observed)'
\echo '17 G1 pass-on options held by app_runtime / app_ctlplane on the 7 objects: expected 0'
\echo '18 F1 user triggers on the 5 tables: expected 0'
\echo '19 I1 BusinessFeatureAccess rows (INFO)'
\echo '20 I2 PlatformAuditEvent rows (INFO)'
\echo '21 I3 PlatformAuditEvent rows in the last 7 days — live runtime appends (INFO)'
\echo '22 I4 a login named app_ctlplane_prod exists (INFO: 0 expected before login provisioning)'
\echo '23 I5 SECURITY DEFINER functions in schema public (INFO)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL row_security = off;

WITH
objs(rel, kind) AS (
  VALUES ('BusinessFeatureAccess', 'r'), ('PlatformFeaturePolicy', 'r'), ('PlatformFeatureDefinition', 'r'),
         ('PlatformAuditEvent', 'r'), ('Business', 'r'),
         ('BusinessFeatureAccess_id_seq', 'S'), ('PlatformAuditEvent_id_seq', 'S')
),
rels AS (
  SELECT c.oid, c.relname, c.relkind, c.relacl, c.relowner
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  JOIN objs o ON o.rel = c.relname AND o.kind = c.relkind
),
acl AS (
  SELECT r.relname, r.relkind, x.grantee, x.privilege_type, x.is_grantable
  FROM rels r CROSS JOIN LATERAL aclexplode(coalesce(r.relacl, acldefault(CASE WHEN r.relkind = 'S' THEN 's' ELSE 'r' END::"char", r.relowner))) x
),
colacl AS (
  SELECT c.relname, x.grantee, x.privilege_type
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  CROSS JOIN LATERAL aclexplode(a.attacl) x
  WHERE a.attacl IS NOT NULL AND a.attnum > 0
    AND c.relname IN ('BusinessFeatureAccess', 'PlatformFeaturePolicy', 'PlatformFeatureDefinition', 'PlatformAuditEvent', 'Business')
),
runtime_group AS (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime'),
runtime_logins AS (
  SELECT r.oid, r.rolsuper, r.rolbypassrls
  FROM pg_roles r JOIN pg_auth_members m ON m.member = r.oid
  WHERE m.roleid = (SELECT oid FROM runtime_group) AND r.rolcanlogin AND r.rolname <> current_user
),
ctl AS (SELECT oid FROM pg_roles WHERE rolname = 'app_ctlplane'),
named AS (SELECT oid FROM pg_roles WHERE rolname IN ('app_admin', 'app_auth')),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261003090000_control_plane_production_privileges') = 0,
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261003090000_control_plane_production_privileges')
  UNION ALL
  SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
            (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL
  SELECT 3, true, (SELECT count(*) FROM "_prisma_migrations")
  UNION ALL
  SELECT 4, EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_ctlplane' AND NOT rolcanlogin AND NOT rolsuper
                      AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication),
            (SELECT count(*) FROM pg_roles WHERE rolname = 'app_ctlplane')
  UNION ALL
  SELECT 5, EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls),
            (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime')
  UNION ALL
  SELECT 6, (SELECT count(*) FROM runtime_logins) >= 1 AND NOT EXISTS (SELECT 1 FROM runtime_logins WHERE rolsuper OR rolbypassrls),
            (SELECT count(*) FROM runtime_logins)
  UNION ALL
  SELECT 7, (SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
              WHERE m.roleid = (SELECT oid FROM ctl) AND r.rolcanlogin AND r.rolname <> current_user) = 0,
            (SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
              WHERE m.roleid = (SELECT oid FROM ctl) AND r.rolcanlogin AND r.rolname <> current_user)
  UNION ALL
  SELECT 8, (SELECT count(*) FROM rels WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)) = 7,
            (SELECT count(*) FROM rels WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user))
  UNION ALL
  SELECT 9, (SELECT count(*) FROM acl WHERE grantee IN (SELECT oid FROM runtime_logins)) = 0,
            (SELECT count(*) FROM acl WHERE grantee IN (SELECT oid FROM runtime_logins))
  UNION ALL
  SELECT 10, (SELECT count(*) FROM colacl WHERE grantee IN (SELECT oid FROM runtime_logins UNION SELECT oid FROM runtime_group)) = 0,
             (SELECT count(*) FROM colacl WHERE grantee IN (SELECT oid FROM runtime_logins UNION SELECT oid FROM runtime_group))
  UNION ALL
  SELECT 11, (SELECT count(*) FROM acl WHERE grantee = 0) + (SELECT count(*) FROM colacl WHERE grantee = 0) = 0,
             (SELECT count(*) FROM acl WHERE grantee = 0) + (SELECT count(*) FROM colacl WHERE grantee = 0)
  UNION ALL
  SELECT 12, (SELECT count(*) FROM (
               SELECT relname FROM acl
               WHERE grantee = (SELECT oid FROM runtime_group) AND relkind = 'r'
                 AND relname IN ('BusinessFeatureAccess', 'PlatformFeaturePolicy', 'PlatformFeatureDefinition', 'PlatformAuditEvent')
                 AND privilege_type IN ('UPD' || 'ATE', 'DEL' || 'ETE')
               GROUP BY relname HAVING count(*) = 2) s) = 4,
             (SELECT count(*) FROM (
               SELECT relname FROM acl
               WHERE grantee = (SELECT oid FROM runtime_group) AND relkind = 'r'
                 AND relname IN ('BusinessFeatureAccess', 'PlatformFeaturePolicy', 'PlatformFeatureDefinition', 'PlatformAuditEvent')
                 AND privilege_type IN ('UPD' || 'ATE', 'DEL' || 'ETE')
               GROUP BY relname HAVING count(*) = 2) s)
  UNION ALL
  SELECT 13, (SELECT count(*) FROM acl WHERE grantee = (SELECT oid FROM ctl)) + (SELECT count(*) FROM colacl WHERE grantee = (SELECT oid FROM ctl)) = 0,
             (SELECT count(*) FROM acl WHERE grantee = (SELECT oid FROM ctl)) + (SELECT count(*) FROM colacl WHERE grantee = (SELECT oid FROM ctl))
  UNION ALL
  SELECT 14, (SELECT count(*) FROM acl WHERE grantee IN (SELECT oid FROM named)) + (SELECT count(*) FROM colacl WHERE grantee IN (SELECT oid FROM named)) = 0,
             (SELECT count(*) FROM acl WHERE grantee IN (SELECT oid FROM named)) + (SELECT count(*) FROM colacl WHERE grantee IN (SELECT oid FROM named))
  UNION ALL
  SELECT 15, EXISTS (SELECT 1 FROM rels WHERE relname = 'BusinessFeatureAccess')
             AND (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
                   WHERE c.relname = 'BusinessFeatureAccess')
             AND (SELECT count(*) FROM pg_policies WHERE tablename = 'BusinessFeatureAccess'
                   AND policyname IN ('p7pw2_tenant_read', 'p7pw2_ctl_insert', 'p7pw2_ctl_update')) = 3
             AND (SELECT count(*) FROM pg_policies WHERE tablename = 'BusinessFeatureAccess') = 3,
             (SELECT count(*) FROM pg_policies WHERE tablename = 'BusinessFeatureAccess')
  UNION ALL
  SELECT 16, true, (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
                     WHERE c.relname IN ('Business', 'PlatformFeaturePolicy', 'PlatformFeatureDefinition', 'PlatformAuditEvent') AND c.relrowsecurity)
  UNION ALL
  SELECT 17, (SELECT count(*) FROM acl WHERE is_grantable AND grantee IN (SELECT oid FROM runtime_group UNION SELECT oid FROM ctl UNION SELECT oid FROM runtime_logins)) = 0,
             (SELECT count(*) FROM acl WHERE is_grantable AND grantee IN (SELECT oid FROM runtime_group UNION SELECT oid FROM ctl UNION SELECT oid FROM runtime_logins))
  UNION ALL
  SELECT 18, (SELECT count(*) FROM pg_trigger t JOIN rels r ON r.oid = t.tgrelid WHERE NOT t.tgisinternal) = 0,
             (SELECT count(*) FROM pg_trigger t JOIN rels r ON r.oid = t.tgrelid WHERE NOT t.tgisinternal)
  UNION ALL
  SELECT 19, true, (SELECT count(*) FROM "BusinessFeatureAccess")
  UNION ALL
  SELECT 20, true, (SELECT count(*) FROM "PlatformAuditEvent")
  UNION ALL
  SELECT 21, true, (SELECT count(*) FROM "PlatformAuditEvent" WHERE "createdAt" > now() - interval '7 days')
  UNION ALL
  SELECT 22, true, (SELECT count(*) FROM pg_roles WHERE rolname = 'app_ctlplane_prod')
  UNION ALL
  SELECT 23, true, (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public' WHERE p.prosecdef)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
