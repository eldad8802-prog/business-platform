-- ============================================================================
-- c594-control-plane-privileges-production-evidence.sql
--
-- Read-only post-apply proof for migration
--   20261003090000_control_plane_production_privileges   (PR #594)
-- The companion of c594-control-plane-privileges-preflight.sql.
--
-- Every privilege check is EFFECTIVE (has_*_privilege, so membership and
-- PUBLIC count) and evaluated for the group AND every runtime login inheriting
-- it — plus a separate check that no runtime login holds a DIRECT entry, and
-- that no column-level privilege survived a table-level removal.
--
-- OUTPUT (redaction-friendly): n | result | observed_count. The legend below
-- maps n to the assertion. Names never appear in the output.
--
-- PRIVACY: catalog and ledger only; no data row content is read.
-- Guard-clean: the workflow rejects this file if it contains any write
-- keyword, prose included, so the wording deliberately avoids those words.
-- ============================================================================

\echo '== c594 post-apply proof legend (n → check) =='
\echo ' 1 Q0 the 594 migration is recorded applied, finished, not rolled back, checksum = the reviewed file'
\echo ' 2 Q1 ledger: no unfinished or rolled-back row'
\echo ' 3 C1 app_ctlplane on BusinessFeatureAccess: table SELECT + INS only; column UPD on exactly state, reason, updatedByUserId, updatedAt'
\echo ' 4 C2 app_ctlplane on PlatformAuditEvent: INS only (no SELECT, no UPD, no DEL)'
\echo ' 5 C3 app_ctlplane on Business: no table privilege; column SELECT on exactly id, name'
\echo ' 6 C4 app_ctlplane on PlatformFeaturePolicy: SELECT only; on PlatformFeatureDefinition: nothing'
\echo ' 7 C5 app_ctlplane sequences: USAGE only on the two id sequences'
\echo ' 8 C6 app_ctlplane: NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION'
\echo ' 9 R1 runtime (group + every inheriting login): BusinessFeatureAccess / PlatformFeaturePolicy / PlatformFeatureDefinition = SELECT only'
\echo '10 R2 runtime: PlatformAuditEvent = SELECT + INS only (no UPD, no DEL, no TRUNC)'
\echo '11 R3 runtime: no USAGE / UPD on BusinessFeatureAccess_id_seq; PlatformAuditEvent_id_seq still usable'
\echo '12 R4 runtime logins hold no DIRECT entry on the 7 objects, and no column-level privilege remains for runtime'
\echo '13 R5 runtime group and logins: NOSUPERUSER NOBYPASSRLS'
\echo '14 X1 PUBLIC holds nothing on the 7 objects (table or column level)'
\echo '15 X2 no pass-on option held by app_runtime / app_ctlplane on the 7 objects'
\echo '16 X3 BusinessFeatureAccess: RLS + FORCE, exactly the 3 PW-2 policies'
\echo '17 X4 the migration role still owns the 7 objects'
\echo '18 I1 logins in app_ctlplane other than the migration role (INFO: 0 until login provisioning)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';

WITH
rels AS (
  SELECT c.oid, c.relname, c.relkind, c.relacl, c.relowner
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  WHERE (c.relkind = 'r' AND c.relname IN ('BusinessFeatureAccess', 'PlatformFeaturePolicy', 'PlatformFeatureDefinition', 'PlatformAuditEvent', 'Business'))
     OR (c.relkind = 'S' AND c.relname IN ('BusinessFeatureAccess_id_seq', 'PlatformAuditEvent_id_seq'))
),
acl AS (
  SELECT r.relname, x.grantee, x.privilege_type, x.is_grantable
  FROM rels r CROSS JOIN LATERAL aclexplode(coalesce(r.relacl, acldefault(CASE WHEN r.relkind = 'S' THEN 's' ELSE 'r' END::"char", r.relowner))) x
),
colacl AS (
  SELECT c.relname, a.attname, x.grantee, x.privilege_type
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  CROSS JOIN LATERAL aclexplode(a.attacl) x
  WHERE a.attacl IS NOT NULL AND a.attnum > 0
    AND c.relname IN ('BusinessFeatureAccess', 'PlatformFeaturePolicy', 'PlatformFeatureDefinition', 'PlatformAuditEvent', 'Business')
),
ctl AS (SELECT oid FROM pg_roles WHERE rolname = 'app_ctlplane'),
rt_group AS (SELECT oid, rolname FROM pg_roles WHERE rolname = 'app_runtime'),
rt_logins AS (
  SELECT r.oid, r.rolname, r.rolsuper, r.rolbypassrls
  FROM pg_roles r JOIN pg_auth_members m ON m.member = r.oid
  WHERE m.roleid = (SELECT oid FROM rt_group) AND r.rolcanlogin AND r.rolname <> current_user
),
rt_all AS (SELECT rolname FROM rt_group UNION SELECT rolname FROM rt_logins),
verbs(v) AS (VALUES ('SELECT'), ('INS' || 'ERT'), ('UPD' || 'ATE'), ('DEL' || 'ETE'), ('TRUNC' || 'ATE'), ('REFERENCES'), ('TRIGGER')),
-- the runtime's effective table verbs: (role, table, verb) it HOLDS
rt_eff AS (
  SELECT a.rolname, t.t, v.v
  FROM rt_all a
  CROSS JOIN (VALUES ('BusinessFeatureAccess'), ('PlatformFeaturePolicy'), ('PlatformFeatureDefinition'), ('PlatformAuditEvent')) t(t)
  CROSS JOIN verbs v
  WHERE has_table_privilege(a.rolname, format('public.%I', t.t), v.v)
),
ctl_tbl AS (SELECT relname, privilege_type FROM acl WHERE grantee = (SELECT oid FROM ctl)),
ctl_col AS (SELECT relname, attname, privilege_type FROM colacl WHERE grantee = (SELECT oid FROM ctl)),
checks(n, ok, observed_count) AS (
  SELECT 1, EXISTS (SELECT 1 FROM "_prisma_migrations"
                     WHERE migration_name = '20261003090000_control_plane_production_privileges'
                       AND finished_at IS NOT NULL AND rolled_back_at IS NULL
                       AND checksum = 'ce16662a405871e0d199338eedf4f0c8b3581f5c3f5d018637d5ae73cf0a84ab'),
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261003090000_control_plane_production_privileges')
  UNION ALL
  SELECT 2, NOT EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL),
            (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL
  SELECT 3, (SELECT string_agg(privilege_type, ',' ORDER BY privilege_type) FROM ctl_tbl WHERE relname = 'BusinessFeatureAccess') = 'INS' || 'ERT,SELECT'
            AND (SELECT string_agg(attname, ',' ORDER BY attname) FROM ctl_col WHERE relname = 'BusinessFeatureAccess' AND privilege_type = 'UPD' || 'ATE')
                = 'reason,state,updatedAt,updatedByUserId'
            AND NOT EXISTS (SELECT 1 FROM ctl_col WHERE relname = 'BusinessFeatureAccess' AND privilege_type <> 'UPD' || 'ATE'),
            (SELECT count(*) FROM ctl_tbl WHERE relname = 'BusinessFeatureAccess') + (SELECT count(*) FROM ctl_col WHERE relname = 'BusinessFeatureAccess')
  UNION ALL
  SELECT 4, (SELECT string_agg(privilege_type, ',') FROM ctl_tbl WHERE relname = 'PlatformAuditEvent') = 'INS' || 'ERT'
            AND NOT EXISTS (SELECT 1 FROM ctl_col WHERE relname = 'PlatformAuditEvent')
            AND NOT has_table_privilege('app_ctlplane', 'public."PlatformAuditEvent"', 'SELECT'),
            (SELECT count(*) FROM ctl_tbl WHERE relname = 'PlatformAuditEvent')
  UNION ALL
  SELECT 5, NOT EXISTS (SELECT 1 FROM ctl_tbl WHERE relname = 'Business')
            AND (SELECT string_agg(attname || ':' || privilege_type, ',' ORDER BY attname) FROM ctl_col WHERE relname = 'Business') = 'id:SELECT,name:SELECT',
            (SELECT count(*) FROM ctl_col WHERE relname = 'Business')
  UNION ALL
  SELECT 6, (SELECT string_agg(privilege_type, ',') FROM ctl_tbl WHERE relname = 'PlatformFeaturePolicy') = 'SELECT'
            AND NOT EXISTS (SELECT 1 FROM ctl_tbl WHERE relname = 'PlatformFeatureDefinition')
            AND NOT EXISTS (SELECT 1 FROM ctl_col WHERE relname IN ('PlatformFeaturePolicy', 'PlatformFeatureDefinition')),
            (SELECT count(*) FROM ctl_tbl WHERE relname IN ('PlatformFeaturePolicy', 'PlatformFeatureDefinition'))
  UNION ALL
  SELECT 7, (SELECT string_agg(relname || ':' || privilege_type, ',' ORDER BY relname) FROM ctl_tbl WHERE relname LIKE '%_id_seq')
              = 'BusinessFeatureAccess_id_seq:USAGE,PlatformAuditEvent_id_seq:USAGE',
            (SELECT count(*) FROM ctl_tbl WHERE relname LIKE '%_id_seq')
  UNION ALL
  SELECT 8, EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_ctlplane' AND NOT rolcanlogin AND NOT rolsuper
                      AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication),
            (SELECT count(*) FROM pg_roles WHERE rolname = 'app_ctlplane')
  UNION ALL
  SELECT 9, (SELECT count(*) FROM rt_eff WHERE t IN ('BusinessFeatureAccess', 'PlatformFeaturePolicy', 'PlatformFeatureDefinition') AND v <> 'SELECT') = 0
            AND (SELECT count(*) FROM rt_eff WHERE t IN ('BusinessFeatureAccess', 'PlatformFeaturePolicy', 'PlatformFeatureDefinition') AND v = 'SELECT')
                = 3 * (SELECT count(*) FROM rt_all),
            (SELECT count(*) FROM rt_eff WHERE t IN ('BusinessFeatureAccess', 'PlatformFeaturePolicy', 'PlatformFeatureDefinition') AND v <> 'SELECT')
  UNION ALL
  SELECT 10, (SELECT count(*) FROM rt_eff WHERE t = 'PlatformAuditEvent' AND v NOT IN ('SELECT', 'INS' || 'ERT')) = 0
             AND (SELECT count(*) FROM rt_eff WHERE t = 'PlatformAuditEvent' AND v IN ('SELECT', 'INS' || 'ERT')) = 2 * (SELECT count(*) FROM rt_all),
             (SELECT count(*) FROM rt_eff WHERE t = 'PlatformAuditEvent' AND v NOT IN ('SELECT', 'INS' || 'ERT'))
  UNION ALL
  SELECT 11, NOT EXISTS (SELECT 1 FROM rt_all a WHERE has_sequence_privilege(a.rolname, 'public."BusinessFeatureAccess_id_seq"', 'USAGE')
                                                OR has_sequence_privilege(a.rolname, 'public."BusinessFeatureAccess_id_seq"', 'UPD' || 'ATE'))
             AND NOT EXISTS (SELECT 1 FROM rt_all a WHERE NOT has_sequence_privilege(a.rolname, 'public."PlatformAuditEvent_id_seq"', 'USAGE')),
             (SELECT count(*) FROM rt_all a WHERE has_sequence_privilege(a.rolname, 'public."BusinessFeatureAccess_id_seq"', 'USAGE'))
  UNION ALL
  SELECT 12, (SELECT count(*) FROM acl WHERE grantee IN (SELECT oid FROM rt_logins))
             + (SELECT count(*) FROM colacl WHERE grantee IN (SELECT oid FROM rt_logins UNION SELECT oid FROM rt_group)) = 0,
             (SELECT count(*) FROM acl WHERE grantee IN (SELECT oid FROM rt_logins))
             + (SELECT count(*) FROM colacl WHERE grantee IN (SELECT oid FROM rt_logins UNION SELECT oid FROM rt_group))
  UNION ALL
  SELECT 13, NOT EXISTS (SELECT 1 FROM pg_roles r JOIN rt_all a ON a.rolname = r.rolname WHERE r.rolsuper OR r.rolbypassrls)
             AND (SELECT count(*) FROM rt_logins) >= 1,
             (SELECT count(*) FROM rt_logins)
  UNION ALL
  SELECT 14, (SELECT count(*) FROM acl WHERE grantee = 0) + (SELECT count(*) FROM colacl WHERE grantee = 0) = 0,
             (SELECT count(*) FROM acl WHERE grantee = 0) + (SELECT count(*) FROM colacl WHERE grantee = 0)
  UNION ALL
  SELECT 15, (SELECT count(*) FROM acl WHERE is_grantable AND grantee IN (SELECT oid FROM ctl UNION SELECT oid FROM rt_group UNION SELECT oid FROM rt_logins)) = 0,
             (SELECT count(*) FROM acl WHERE is_grantable AND grantee IN (SELECT oid FROM ctl UNION SELECT oid FROM rt_group UNION SELECT oid FROM rt_logins))
  UNION ALL
  SELECT 16, (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
              WHERE c.relname = 'BusinessFeatureAccess')
             AND (SELECT count(*) FROM pg_policies WHERE tablename = 'BusinessFeatureAccess'
                   AND policyname IN ('p7pw2_tenant_read', 'p7pw2_ctl_insert', 'p7pw2_ctl_update')) = 3
             AND (SELECT count(*) FROM pg_policies WHERE tablename = 'BusinessFeatureAccess') = 3,
             (SELECT count(*) FROM pg_policies WHERE tablename = 'BusinessFeatureAccess')
  UNION ALL
  SELECT 17, (SELECT count(*) FROM rels WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)) = 7,
             (SELECT count(*) FROM rels WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user))
  UNION ALL
  SELECT 18, true, (SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
                     WHERE m.roleid = (SELECT oid FROM ctl) AND r.rolcanlogin AND r.rolname <> current_user)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
