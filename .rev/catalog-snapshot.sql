-- Every pre-existing object that a migration could change, as text, one line each — EXCLUDING the objects
-- revenue truth owns (Revenue* relations / types, revenue_* functions and policies, and the constraints,
-- indexes and triggers that live on Revenue* tables). Run before and after the migration on the same
-- database: the two outputs must be identical. Internal RI triggers are excluded: a foreign key FROM a new
-- table puts one on its parent by construction, and it changes nothing a row of the parent can do.
-- SELECT-only.
WITH rel AS (
  SELECT c.oid, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity, c.relacl
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname !~ '^Revenue' AND c.relname <> '_prisma_migrations'
)
SELECT line FROM (
  SELECT 'rel ' || relname || ' kind=' || relkind || ' rls=' || relrowsecurity || ' force=' || relforcerowsecurity
         || ' acl=' || coalesce(relacl::text, '-') AS line
    FROM rel
  UNION ALL
  SELECT 'col ' || r.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
         || ' notnull=' || a.attnotnull || ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-')
         || ' acl=' || coalesce(a.attacl::text, '-')
    FROM rel r JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE r.relkind IN ('r', 'p', 'v')
  UNION ALL
  SELECT 'con ' || r.relname || '.' || co.conname || ' ' || pg_get_constraintdef(co.oid)
    FROM rel r JOIN pg_constraint co ON co.conrelid = r.oid
  UNION ALL
  SELECT 'idx ' || pg_get_indexdef(i.indexrelid)
    FROM rel r JOIN pg_index i ON i.indrelid = r.oid
  UNION ALL
  SELECT 'pol ' || r.relname || '.' || p.polname || ' cmd=' || p.polcmd || ' roles=' || p.polroles::text
         || ' using=' || coalesce(pg_get_expr(p.polqual, p.polrelid), '-')
         || ' check=' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '-')
    FROM rel r JOIN pg_policy p ON p.polrelid = r.oid
  UNION ALL
  SELECT 'trg ' || r.relname || '.' || t.tgname || ' enabled=' || t.tgenabled || ' ' || pg_get_triggerdef(t.oid)
    FROM rel r JOIN pg_trigger t ON t.tgrelid = r.oid AND NOT t.tgisinternal
  UNION ALL
  SELECT 'fn ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') definer=' || p.prosecdef
         || ' acl=' || coalesce(p.proacl::text, '-') || ' src=' || md5(p.prosrc)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname !~ '^revenue_'
  UNION ALL
  SELECT 'type ' || t.typname || ' = ' || coalesce((SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid), '-')
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
   WHERE n.nspname = 'public' AND t.typtype = 'e' AND t.typname !~ '^Revenue'
  UNION ALL
  SELECT 'role ' || rolname || ' super=' || rolsuper || ' bypass=' || rolbypassrls || ' login=' || rolcanlogin
    FROM pg_roles WHERE rolname !~ '^pg_'
  UNION ALL
  SELECT 'defacl ' || pg_get_userbyid(defaclrole) || ' ' || defaclobjtype || ' ' || coalesce(defaclacl::text, '-')
    FROM pg_default_acl
) s
ORDER BY line;
