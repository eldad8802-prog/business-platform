-- ============================================================================
-- business-b4-role-classification.sql
--
-- Read-only Production CLASSIFICATION of the roles behind the B4 preflight failures
-- (business-tenant-write-rls-preflight.sql, run 37137133811: check 7 = 1, check 12 = 2).
--
-- The role sets are computed with EXACTLY the preflight's logic:
--   check 7  = LOGIN roles that can add a Business row that lack app_auth inheritance;
--   check 12 = roles outside the runtime (app_runtime and its logins) that can change a Business row;
-- over roles that are not the migration role (current_user), not superusers, not pg_* roles.
--
-- NAMES NEVER APPEAR. Each role is identified by role_n = its OID (stable, anonymous) and
-- described by true/false flags and counts only, so the evidence redactor passes them
-- through. Repo-public identities are tested by equality (known_* flags); an unknown name is
-- never printed. Expanded output: one labelled record per role.
--
-- Origin flags (per verb):
--   direct_*  : an ACL entry (table or column) naming the role itself;
--   group_*   : an ACL entry naming another role it inherits (not the owner, not PUBLIC);
--   owner_*   : it inherits the role that owns Business (owners hold every privilege);
--   public_*  : an ACL entry for PUBLIC.
-- Activity: sessions_n = its sessions in pg_stat_activity right now (a point-in-time signal).
--
-- Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== B4 role classification: summary =='

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
biz AS (SELECT c.oid, c.relowner, c.relacl FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        WHERE c.relname = 'Business' AND c.relkind = 'r'),
cols AS (SELECT a.attname, a.attacl FROM pg_attribute a WHERE a.attrelid = (SELECT oid FROM biz) AND a.attnum > 0 AND NOT a.attisdropped),
rt AS (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime'),
au AS (SELECT oid FROM pg_roles WHERE rolname = 'app_auth'),
roles AS (SELECT r.* FROM pg_roles r WHERE r.rolname <> current_user AND NOT r.rolsuper AND r.rolname NOT LIKE 'pg\_%'),
can_add AS (SELECT r.oid, r.rolcanlogin FROM roles r WHERE has_table_privilege(r.oid, (SELECT oid FROM biz), 'INS' || 'ERT')
            OR EXISTS (SELECT 1 FROM cols c WHERE has_column_privilege(r.oid, (SELECT oid FROM biz), c.attname, 'INS' || 'ERT'))),
can_change AS (SELECT r.oid FROM roles r WHERE has_table_privilege(r.oid, (SELECT oid FROM biz), 'UPD' || 'ATE')
               OR EXISTS (SELECT 1 FROM cols c WHERE has_column_privilege(r.oid, (SELECT oid FROM biz), c.attname, 'UPD' || 'ATE'))),
runtime_roles AS (SELECT r.oid FROM roles r WHERE r.oid = (SELECT oid FROM rt)
                  OR (r.rolcanlogin AND pg_has_role(r.oid, (SELECT oid FROM rt), 'MEMBER'))),
auth_logins AS (SELECT r.oid FROM roles r WHERE r.rolcanlogin AND (SELECT oid FROM au) IS NOT NULL
                AND pg_has_role(r.oid, (SELECT oid FROM au), 'USAGE')),
c7 AS (SELECT oid FROM can_add WHERE rolcanlogin AND oid NOT IN (SELECT oid FROM auth_logins)),
c12 AS (SELECT oid FROM can_change WHERE oid NOT IN (SELECT oid FROM runtime_roles))
SELECT (SELECT count(*) FROM c7) AS check7_count,
       (SELECT count(*) FROM c12) AS check12_count,
       (SELECT count(*) FROM c7 WHERE oid IN (SELECT oid FROM c12)) AS in_both_count,
       (SELECT count(*) FROM (SELECT oid FROM c7 UNION SELECT oid FROM c12) u) AS distinct_count;

\echo '== B4 role classification: one record per offending role (role_n = anonymous OID) =='
\x on

WITH
biz AS (SELECT c.oid, c.relowner, c.relacl FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        WHERE c.relname = 'Business' AND c.relkind = 'r'),
cols AS (SELECT a.attname, a.attacl FROM pg_attribute a WHERE a.attrelid = (SELECT oid FROM biz) AND a.attnum > 0 AND NOT a.attisdropped),
rt AS (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime'),
au AS (SELECT oid FROM pg_roles WHERE rolname = 'app_auth'),
roles AS (SELECT r.* FROM pg_roles r WHERE r.rolname <> current_user AND NOT r.rolsuper AND r.rolname NOT LIKE 'pg\_%'),
can_add AS (SELECT r.oid, r.rolcanlogin FROM roles r WHERE has_table_privilege(r.oid, (SELECT oid FROM biz), 'INS' || 'ERT')
            OR EXISTS (SELECT 1 FROM cols c WHERE has_column_privilege(r.oid, (SELECT oid FROM biz), c.attname, 'INS' || 'ERT'))),
can_change AS (SELECT r.oid FROM roles r WHERE has_table_privilege(r.oid, (SELECT oid FROM biz), 'UPD' || 'ATE')
               OR EXISTS (SELECT 1 FROM cols c WHERE has_column_privilege(r.oid, (SELECT oid FROM biz), c.attname, 'UPD' || 'ATE'))),
runtime_roles AS (SELECT r.oid FROM roles r WHERE r.oid = (SELECT oid FROM rt)
                  OR (r.rolcanlogin AND pg_has_role(r.oid, (SELECT oid FROM rt), 'MEMBER'))),
auth_logins AS (SELECT r.oid FROM roles r WHERE r.rolcanlogin AND (SELECT oid FROM au) IS NOT NULL
                AND pg_has_role(r.oid, (SELECT oid FROM au), 'USAGE')),
c7 AS (SELECT oid FROM can_add WHERE rolcanlogin AND oid NOT IN (SELECT oid FROM auth_logins)),
c12 AS (SELECT oid FROM can_change WHERE oid NOT IN (SELECT oid FROM runtime_roles)),
offenders AS (SELECT r.* FROM roles r WHERE r.oid IN (SELECT oid FROM c7) OR r.oid IN (SELECT oid FROM c12)),
-- every ACL entry on Business (table + columns): grantee, privilege
acl AS (SELECT x.grantee, x.privilege_type AS p FROM biz, aclexplode(biz.relacl) x
        UNION ALL
        SELECT x.grantee, x.privilege_type FROM cols c, aclexplode(c.attacl) x),
grp AS (SELECT oid, rolname FROM pg_roles WHERE rolname IN ('app_runtime', 'app_auth', 'app_ctlplane', 'app_admin', 'neon_superuser'))
SELECT
  o.oid::bigint                                                           AS role_n,
  o.oid IN (SELECT oid FROM c7)                                           AS in_check7,
  o.oid IN (SELECT oid FROM c12)                                          AS in_check12,
  -- attributes
  o.rolcanlogin                                                           AS can_login,
  o.rolsuper                                                              AS is_superuser,
  o.rolbypassrls                                                          AS bypassrls,
  o.rolcreaterole                                                         AS createrole,
  o.rolcreatedb                                                           AS createdb,
  o.rolreplication                                                        AS replication,
  o.rolinherit                                                            AS inherit,
  o.rolconnlimit                                                          AS connlimit_n,
  o.rolvaliduntil IS NOT NULL                                             AS has_valid_until,
  -- owner of Business
  o.oid = (SELECT relowner FROM biz)                                      AS is_business_owner,
  pg_has_role(o.oid, (SELECT relowner FROM biz), 'MEMBER')                AS member_of_owner,
  pg_has_role(o.oid, (SELECT relowner FROM biz), 'USAGE')                 AS inherits_owner,
  EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = o.oid AND m.roleid = (SELECT relowner FROM biz)) AS direct_member_of_owner,
  -- app / platform groups
  coalesce(pg_has_role(o.oid, (SELECT oid FROM grp WHERE rolname = 'app_runtime'), 'MEMBER'), false)    AS member_app_runtime,
  coalesce(pg_has_role(o.oid, (SELECT oid FROM grp WHERE rolname = 'app_runtime'), 'USAGE'), false)     AS inherits_app_runtime,
  coalesce(pg_has_role(o.oid, (SELECT oid FROM grp WHERE rolname = 'app_auth'), 'MEMBER'), false)       AS member_app_auth,
  coalesce(pg_has_role(o.oid, (SELECT oid FROM grp WHERE rolname = 'app_auth'), 'USAGE'), false)        AS inherits_app_auth,
  coalesce(pg_has_role(o.oid, (SELECT oid FROM grp WHERE rolname = 'app_ctlplane'), 'MEMBER'), false)   AS member_app_ctlplane,
  coalesce(pg_has_role(o.oid, (SELECT oid FROM grp WHERE rolname = 'app_ctlplane'), 'USAGE'), false)    AS inherits_app_ctlplane,
  coalesce(pg_has_role(o.oid, (SELECT oid FROM grp WHERE rolname = 'app_admin'), 'MEMBER'), false)      AS member_app_admin,
  coalesce(pg_has_role(o.oid, (SELECT oid FROM grp WHERE rolname = 'app_admin'), 'USAGE'), false)       AS inherits_app_admin,
  coalesce(pg_has_role(o.oid, (SELECT oid FROM grp WHERE rolname = 'neon_superuser'), 'MEMBER'), false) AS member_neon_superuser,
  (SELECT count(*) FROM pg_auth_members m WHERE m.member = o.oid)         AS groups_n,
  (SELECT count(*) FROM pg_auth_members m WHERE m.roleid = o.oid)         AS members_n,
  -- privilege origin on Business, per verb
  EXISTS (SELECT 1 FROM acl WHERE grantee = o.oid AND p = 'INS' || 'ERT') AS direct_ins,
  EXISTS (SELECT 1 FROM acl WHERE grantee = o.oid AND p = 'UPD' || 'ATE') AS direct_upd,
  EXISTS (SELECT 1 FROM acl a WHERE a.grantee NOT IN (0, o.oid, (SELECT relowner FROM biz)) AND a.p = 'INS' || 'ERT'
                               AND pg_has_role(o.oid, a.grantee, 'USAGE'))                AS group_ins,
  EXISTS (SELECT 1 FROM acl a WHERE a.grantee NOT IN (0, o.oid, (SELECT relowner FROM biz)) AND a.p = 'UPD' || 'ATE'
                               AND pg_has_role(o.oid, a.grantee, 'USAGE'))                AS group_upd,
  pg_has_role(o.oid, (SELECT relowner FROM biz), 'USAGE')                 AS owner_ins_and_upd,
  EXISTS (SELECT 1 FROM acl WHERE grantee = 0 AND p IN ('INS' || 'ERT', 'UPD' || 'ATE')) AS public_ins_or_upd,
  -- which Business columns (the 8 of schema.prisma) + anything beyond them
  has_table_privilege(o.oid, (SELECT oid FROM biz), 'INS' || 'ERT')       AS ins_table_level,
  has_table_privilege(o.oid, (SELECT oid FROM biz), 'UPD' || 'ATE')       AS upd_table_level,
  (SELECT count(*) FROM cols c WHERE has_column_privilege(o.oid, (SELECT oid FROM biz), c.attname, 'INS' || 'ERT')) AS ins_cols_n,
  (SELECT count(*) FROM cols c WHERE has_column_privilege(o.oid, (SELECT oid FROM biz), c.attname, 'UPD' || 'ATE')) AS upd_cols_n,
  (SELECT count(*) FROM cols)                                             AS business_cols_n,
  has_column_privilege(o.oid, (SELECT oid FROM biz), 'id', 'INS' || 'ERT')                   AS ins_id,
  has_column_privilege(o.oid, (SELECT oid FROM biz), 'name', 'INS' || 'ERT')                 AS ins_name,
  has_column_privilege(o.oid, (SELECT oid FROM biz), 'createdAt', 'INS' || 'ERT')            AS ins_createdat,
  has_column_privilege(o.oid, (SELECT oid FROM biz), 'updatedAt', 'INS' || 'ERT')            AS ins_updatedat,
  has_column_privilege(o.oid, (SELECT oid FROM biz), 'name', 'UPD' || 'ATE')                 AS upd_name,
  has_column_privilege(o.oid, (SELECT oid FROM biz), 'deletionRequestedAt', 'UPD' || 'ATE')  AS upd_deletionrequestedat,
  has_column_privilege(o.oid, (SELECT oid FROM biz), 'deletedAt', 'UPD' || 'ATE')            AS upd_deletedat,
  has_column_privilege(o.oid, (SELECT oid FROM biz), 'archivedAt', 'UPD' || 'ATE')           AS upd_archivedat,
  has_column_privilege(o.oid, (SELECT oid FROM biz), 'archivedByUserId', 'UPD' || 'ATE')     AS upd_archivedbyuserid,
  has_column_privilege(o.oid, (SELECT oid FROM biz), 'updatedAt', 'UPD' || 'ATE')            AS upd_updatedat,
  has_column_privilege(o.oid, (SELECT oid FROM biz), 'id', 'UPD' || 'ATE')                   AS upd_id,
  -- identity hints without the name
  o.rolname IN ('app_runtime_prod', 'app_auth_prod', 'app_ctlplane_prod', 'app_admin', 'app_admin_prod',
                'app_runtime', 'app_auth', 'app_ctlplane', 'neondb_owner')                    AS known_repo_role,
  o.rolname LIKE 'app\_%'                                                 AS name_app_prefix,
  o.rolname ILIKE 'neon%' OR o.rolname IN ('cloud_admin', 'authenticator', 'anon', 'authenticated', 'service_role') AS name_platform_like,
  o.rolname ILIKE '%owner%'                                               AS name_owner_like,
  (SELECT count(*) FROM pg_class c WHERE c.relowner = o.oid)              AS owned_relations_n,
  EXISTS (SELECT 1 FROM pg_database d WHERE d.datdba = o.oid)             AS owns_a_database,
  EXISTS (SELECT 1 FROM pg_namespace s WHERE s.nspowner = o.oid AND s.nspname = 'public') AS owns_public_schema,
  has_schema_privilege(o.oid, 'public', 'CRE' || 'ATE')                   AS can_make_objects_in_public,
  (SELECT count(*) FROM pg_stat_activity s WHERE s.usesysid = o.oid)      AS sessions_n
FROM offenders o
ORDER BY o.oid;

\x off
ROLLBACK;
