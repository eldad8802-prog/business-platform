-- D2 / STAGE E4 — verification for the proposed narrowing. READ-ONLY.
--
-- Run after the narrowing. Every row returned should read `ok`; any `MISMATCH`
-- means the end state is not the reviewed one.
--
-- The two-sided shape is deliberate. A check that only looked for absent
-- privileges would pass on a database where everything had been revoked and
-- login, signup and account deletion were all broken.

-- ---------------------------------------------------------------------------
-- 1. No table-level privilege survives on either table for either role.
--    This is the one that makes the column grants meaningful; if a table-level
--    grant is still held, every column list below is decoration.
-- ---------------------------------------------------------------------------
SELECT 'table-level residue' AS check,
       COALESCE(string_agg(grantee || '/' || table_name || '/' || privilege_type, ', '), 'none') AS found,
       CASE WHEN count(*) = 0 THEN 'ok' ELSE 'MISMATCH' END AS verdict
  FROM information_schema.role_table_grants
 WHERE table_schema = 'public'
   AND table_name IN ('User', 'Business')
   AND grantee IN ('app_runtime', 'app_auth');

-- ---------------------------------------------------------------------------
-- 2. The exact column grants, per role, per table, per privilege.
-- ---------------------------------------------------------------------------
WITH expected(grantee, tbl, priv, colset) AS (
  VALUES
    ('app_runtime', 'User',     'SELECT', 'businessId,email,id,lastLoginAt,loginCount,name'),
    ('app_runtime', 'User',     'UPDATE', 'email,name,password,updatedAt'),
    ('app_runtime', 'Business', 'SELECT', 'createdAt,deletedAt,deletionRequestedAt,id,name'),
    ('app_runtime', 'Business', 'UPDATE', 'archivedAt,archivedByUserId,deletedAt,deletionRequestedAt,updatedAt'),
    ('app_auth',    'User',     'SELECT', 'businessId,email,id,loginCount,name,password,role,tokenVersion'),
    ('app_auth',    'User',     'INSERT', 'businessId,email,name,password,updatedAt'),
    ('app_auth',    'User',     'UPDATE', 'lastLoginAt,loginCount,tokenVersion,updatedAt'),
    ('app_auth',    'Business', 'SELECT', 'deletedAt,deletionRequestedAt,id,name'),
    ('app_auth',    'Business', 'INSERT', 'name,updatedAt')
),
actual AS (
  SELECT grantee, table_name AS tbl, privilege_type AS priv,
         string_agg(column_name, ',' ORDER BY column_name) AS colset
    FROM information_schema.column_privileges
   WHERE table_schema = 'public'
     AND table_name IN ('User', 'Business')
     AND grantee IN ('app_runtime', 'app_auth')
   GROUP BY grantee, table_name, privilege_type
)
SELECT COALESCE(e.grantee, a.grantee) AS grantee,
       COALESCE(e.tbl, a.tbl)         AS tbl,
       COALESCE(e.priv, a.priv)       AS priv,
       e.colset                       AS expected,
       a.colset                       AS actual,
       CASE WHEN e.colset IS NOT DISTINCT FROM a.colset THEN 'ok' ELSE 'MISMATCH' END AS verdict
  FROM expected e
  FULL OUTER JOIN actual a
    ON a.grantee = e.grantee AND a.tbl = e.tbl AND a.priv = e.priv
 ORDER BY 1, 2, 3;

-- ---------------------------------------------------------------------------
-- 3. The privileges that must be absent entirely.
-- ---------------------------------------------------------------------------
SELECT r.rolname AS grantee, t.tbl, p.priv,
       has_table_privilege(r.rolname, ('public."' || t.tbl || '"')::regclass, p.priv) AS held,
       CASE WHEN has_table_privilege(r.rolname, ('public."' || t.tbl || '"')::regclass, p.priv)
            THEN 'MISMATCH' ELSE 'ok' END AS verdict
  FROM (VALUES ('app_runtime'), ('app_auth')) AS r(rolname),
       (VALUES ('User'), ('Business'))        AS t(tbl),
       (VALUES ('DELETE'), ('TRUNCATE'))      AS p(priv)
 ORDER BY 1, 2, 3;

-- app_runtime must hold no INSERT on either table; app_auth must hold no UPDATE
-- on Business. These are the four that distinguish the two planes.
SELECT 'plane separation' AS check, x.what,
       CASE WHEN x.held THEN 'MISMATCH' ELSE 'ok' END AS verdict
  FROM (
    SELECT 'app_runtime INSERT User'      AS what, has_table_privilege('app_runtime','public."User"','INSERT')      AS held
    UNION ALL SELECT 'app_runtime INSERT Business', has_table_privilege('app_runtime','public."Business"','INSERT')
    UNION ALL SELECT 'app_runtime UPDATE User.role', has_column_privilege('app_runtime','public."User"','role','UPDATE')
    UNION ALL SELECT 'app_runtime UPDATE User.businessId', has_column_privilege('app_runtime','public."User"','businessId','UPDATE')
    UNION ALL SELECT 'app_runtime UPDATE User.tokenVersion', has_column_privilege('app_runtime','public."User"','tokenVersion','UPDATE')
    UNION ALL SELECT 'app_runtime SELECT User.password', has_column_privilege('app_runtime','public."User"','password','SELECT')
    UNION ALL SELECT 'app_auth UPDATE Business', has_table_privilege('app_auth','public."Business"','UPDATE')
    UNION ALL SELECT 'app_auth UPDATE User.password', has_column_privilege('app_auth','public."User"','password','UPDATE')
    UNION ALL SELECT 'app_auth UPDATE User.role', has_column_privilege('app_auth','public."User"','role','UPDATE')
  ) AS x
 ORDER BY 2;

-- ---------------------------------------------------------------------------
-- 4. The positives — what must still work, checked through the LOGIN roles that
--    actually serve traffic, since they hold these only by inheritance.
-- ---------------------------------------------------------------------------
SELECT x.what, x.held, CASE WHEN x.held THEN 'ok' ELSE 'MISMATCH' END AS verdict
  FROM (
    SELECT 'app_runtime_prod reads User.email'        AS what, has_column_privilege('app_runtime_prod','public."User"','email','SELECT') AS held
    UNION ALL SELECT 'app_runtime_prod anonymises User.password', has_column_privilege('app_runtime_prod','public."User"','password','UPDATE')
    UNION ALL SELECT 'app_runtime_prod quarantines Business',     has_column_privilege('app_runtime_prod','public."Business"','deletedAt','UPDATE')
    UNION ALL SELECT 'app_auth_prod reads User.password',         has_column_privilege('app_auth_prod','public."User"','password','SELECT')
    UNION ALL SELECT 'app_auth_prod increments loginCount',       has_column_privilege('app_auth_prod','public."User"','loginCount','UPDATE')
    UNION ALL SELECT 'app_auth_prod reads loginCount',            has_column_privilege('app_auth_prod','public."User"','loginCount','SELECT')
    UNION ALL SELECT 'app_auth_prod inserts User',                has_column_privilege('app_auth_prod','public."User"','email','INSERT')
    UNION ALL SELECT 'app_auth_prod inserts Business',            has_column_privilege('app_auth_prod','public."Business"','name','INSERT')
    UNION ALL SELECT 'app_auth_prod uses User_id_seq',            has_sequence_privilege('app_auth_prod','public."User_id_seq"','USAGE')
    UNION ALL SELECT 'app_auth_prod uses Business_id_seq',        has_sequence_privilege('app_auth_prod','public."Business_id_seq"','USAGE')
  ) AS x
 ORDER BY 1;

-- ---------------------------------------------------------------------------
-- 5. Nothing else moved.
-- ---------------------------------------------------------------------------
SELECT 'RLS unchanged on the auth-boundary tables' AS check,
       count(*) FILTER (WHERE relrowsecurity) AS with_rls,
       CASE WHEN count(*) FILTER (WHERE relrowsecurity) = 0 THEN 'ok' ELSE 'MISMATCH' END AS verdict
  FROM pg_class
 WHERE relnamespace = 'public'::regnamespace
   AND relname IN ('User', 'Business');

SELECT 'runtime memberships unchanged' AS check,
       COALESCE(string_agg(g.rolname, ',' ORDER BY g.rolname), '(none)') AS memberships,
       CASE WHEN COALESCE(string_agg(g.rolname, ',' ORDER BY g.rolname), '') = 'app_runtime'
            THEN 'ok' ELSE 'MISMATCH' END AS verdict
  FROM pg_auth_members am
  JOIN pg_roles g ON g.oid = am.roleid
  JOIN pg_roles m ON m.oid = am.member
 WHERE m.rolname = 'app_runtime_prod';
