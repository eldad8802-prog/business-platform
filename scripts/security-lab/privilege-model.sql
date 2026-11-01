-- Canonical privilege model of the public schema — one normalised line per fact, identical across environments that
-- share the same model. Used by scripts/security-lab (lab, Preview) and embedded verbatim, as the CTE `model`, in
-- ops/evidence/privilege-model-production-assert.sql (Production, which may print only PASS/FAIL and counts).
--
-- Normalisation (so lab, Preview and Production lines are comparable):
--   * the schema owner (the owner of "Business": neondb_owner / lab_owner) is written OWNER;
--   * privileges are Postgres ACL letters, parsed from the aclitem text (r read, a append, w write, d remove,
--     U usage, X execute; the letters D, x, t and m are dropped). The letters keep the write verbs themselves out
--     of this file, which the evidence workflow's static guard requires;
--   * only the group roles (app_runtime, app_auth, app_admin, app_ctlplane, task_maintenance) and PUBLIC count as
--     grantees; a privilege held DIRECTLY by any other role (an environment's LOGIN role) is a section-L line;
--   * functions owned by an extension, the migration ledger and provider objects are left out.
-- Sections: T table · P policy · G table privilege · C column privilege · S sequence privilege · F SECURITY DEFINER function ·
--           X function EXECUTE · D owner default privilege · L privilege held directly by a non-group role · B BYPASSRLS role
WITH
owner AS (
  SELECT pg_get_userbyid(c.relowner) AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'Business'
),
grp(name) AS (VALUES ('app_runtime'), ('app_auth'), ('app_admin'), ('app_ctlplane'), ('task_maintenance'), ('')),
rel AS (
  SELECT c.oid, c.relname, c.relkind, c.relacl, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname <> '_prisma_migrations'
),
fn AS (
  SELECT p.oid, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig,
         p.prosecdef, p.proconfig, p.proacl, p.proowner
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND NOT EXISTS (SELECT 1 FROM pg_depend e WHERE e.classid = 'pg_proc'::regclass AND e.objid = p.oid AND e.deptype = 'e')
     AND p.proname <> 'show_db_tree'
),
-- aclitem text is  grantee=letters/grantor  (grantee empty for PUBLIC; quoted when it needs quoting)
acl AS (
  SELECT r.relname AS obj, r.relkind, NULL::text AS col,
         btrim(split_part(a::text, '=', 1), '"') AS grantee, split_part(split_part(a::text, '=', 2), '/', 1) AS letters
    FROM rel r, unnest(r.relacl) a
  UNION ALL
  SELECT r.relname, r.relkind, att.attname,
         btrim(split_part(a::text, '=', 1), '"'), split_part(split_part(a::text, '=', 2), '/', 1)
    FROM rel r JOIN pg_attribute att ON att.attrelid = r.oid AND att.attacl IS NOT NULL AND NOT att.attisdropped,
         unnest(att.attacl) a
),
priv AS (
  SELECT obj, relkind, col, grantee, letter
    FROM acl, regexp_split_to_table(regexp_replace(letters, '\*', '', 'g'), '') letter
   WHERE letter IN ('r', 'a', 'w', 'd', 'U')
     AND grantee <> (SELECT name FROM owner)
),
model(section, line) AS (
  SELECT 'T', 'T|' || relname || '|rls=' || relrowsecurity || '|force=' || relforcerowsecurity || '|businessId='
         || EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = rel.oid AND a.attname = 'businessId' AND NOT a.attisdropped)
    FROM rel WHERE relkind IN ('r', 'p')
  UNION ALL
  SELECT 'P', 'P|' || r.relname || '|' || pol.polname || '|' || pol.polcmd::text || '|permissive=' || pol.polpermissive
         || '|roles=' || coalesce((SELECT string_agg(CASE WHEN rid = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(rid) END, ',' ORDER BY 1)
                                     FROM unnest(pol.polroles) rid), '')
         || '|using=' || coalesce(md5(pg_get_expr(pol.polqual, pol.polrelid)), '-')
         || '|check=' || coalesce(md5(pg_get_expr(pol.polwithcheck, pol.polrelid)), '-')
    FROM pg_policy pol JOIN rel r ON r.oid = pol.polrelid
  UNION ALL
  SELECT CASE WHEN relkind = 'S' THEN 'S' WHEN col IS NULL THEN 'G' ELSE 'C' END,
         CASE WHEN relkind = 'S' THEN 'S' WHEN col IS NULL THEN 'G' ELSE 'C' END || '|' || obj || coalesce('.' || col, '')
         || '|' || CASE WHEN grantee = '' THEN 'PUBLIC' ELSE grantee END || '|' || letter
    FROM priv WHERE grantee IN (SELECT name FROM grp)
  UNION ALL
  SELECT 'L', 'L|' || obj || coalesce('.' || col, '') || '|' || letter
    FROM priv WHERE grantee NOT IN (SELECT name FROM grp)
  UNION ALL
  SELECT 'F', 'F|' || sig || '|owner=' || CASE WHEN pg_get_userbyid(proowner) = (SELECT name FROM owner) THEN 'OWNER' ELSE pg_get_userbyid(proowner) END
         || '|config=' || coalesce(array_to_string(proconfig, ';'), '-')
    FROM fn WHERE prosecdef
  UNION ALL
  SELECT 'X', 'X|' || f.sig || '|' || CASE WHEN g = '' THEN 'PUBLIC' ELSE g END
    FROM fn f, unnest(coalesce(f.proacl, acldefault('f', f.proowner))) a,
         LATERAL (SELECT btrim(split_part(a::text, '=', 1), '"') AS g, split_part(split_part(a::text, '=', 2), '/', 1) AS l) x
   WHERE x.g <> pg_get_userbyid(f.proowner) AND position('X' IN x.l) > 0
  UNION ALL
  SELECT 'D', 'D|' || d.defaclobjtype::text || '|' || coalesce(dn.nspname, '*') || '|'
         || CASE WHEN btrim(split_part(a::text, '=', 1), '"') = '' THEN 'PUBLIC' ELSE btrim(split_part(a::text, '=', 1), '"') END
         || '|' || letter
    FROM pg_default_acl d LEFT JOIN pg_namespace dn ON dn.oid = d.defaclnamespace, unnest(d.defaclacl) a,
         regexp_split_to_table(split_part(split_part(a::text, '=', 2), '/', 1), '') letter
   WHERE pg_get_userbyid(d.defaclrole) = (SELECT name FROM owner) AND letter IN ('r', 'a', 'w', 'd', 'U', 'X')
  UNION ALL
  SELECT 'B', 'B|' || CASE WHEN r.rolname = (SELECT name FROM owner) THEN 'OWNER' ELSE r.rolname END
    FROM pg_roles r WHERE r.rolbypassrls AND r.rolname !~ '^(pg_|cloud_admin|neon_service|neon_superuser|postgres)'
)
