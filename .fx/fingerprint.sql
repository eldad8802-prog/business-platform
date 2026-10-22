-- Schema fingerprint of a lab database: one line per object, by NAME (never an OID), sorted by the caller.
-- Used to prove that .fx/rollback.sql returns the database to exactly its pre-migration shape:
--   relations (kind, owner, RLS flags, ACL), columns (type, nullability, default), constraints, indexes,
--   policies, triggers, functions (identity, security, config, ACL, body hash), types, default ACLs, the
--   migration ledger (names and state), and the roles this migration touches or builds on.
-- psql -X -At -f .fx/fingerprint.sql | sort | sha256sum
SELECT 'rel|' || c.relname || '|' || c.relkind || '|' || pg_get_userbyid(c.relowner) || '|' || c.relrowsecurity || '|'
       || c.relforcerowsecurity || '|' || coalesce(c.relacl::text, '-')
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'S', 'v', 'm', 'p', 'i', 'f')
UNION ALL
SELECT 'col|' || c.relname || '.' || a.attname || '|' || format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull || '|'
       || coalesce(pg_get_expr(d.adbin, d.adrelid), '-') || '|' || coalesce(a.attacl::text, '-')
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
 WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm') AND a.attnum > 0 AND NOT a.attisdropped
UNION ALL
SELECT 'con|' || c.relname || '|' || k.conname || '|' || pg_get_constraintdef(k.oid) || '|' || k.convalidated
  FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid WHERE c.relnamespace = 'public'::regnamespace
UNION ALL
SELECT 'idx|' || indexname || '|' || indexdef FROM pg_indexes WHERE schemaname = 'public'
UNION ALL
SELECT 'pol|' || tablename || '|' || policyname || '|' || permissive || '|' || roles::text || '|' || cmd || '|'
       || coalesce(qual, '-') || '|' || coalesce(with_check, '-')
  FROM pg_policies WHERE schemaname = 'public'
UNION ALL
SELECT 'trg|' || c.relname || '|' || t.tgname || '|' || t.tgenabled || '|' || pg_get_triggerdef(t.oid)
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
UNION ALL
SELECT 'fn|' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')|' || pg_get_userbyid(p.proowner) || '|'
       || p.prosecdef || '|' || p.provolatile || '|' || coalesce(array_to_string(p.proconfig, ','), '-') || '|'
       || coalesce(p.proacl::text, '-') || '|' || md5(p.prosrc)
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
UNION ALL
SELECT 'type|' || t.typname || '|' || t.typtype FROM pg_type t
 WHERE t.typnamespace = 'public'::regnamespace AND t.typtype IN ('e', 'd', 'c') AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.reltype = t.oid)
UNION ALL
SELECT 'enum|' || t.typname || '|' || e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
 WHERE t.typnamespace = 'public'::regnamespace
UNION ALL
SELECT 'defacl|' || pg_get_userbyid(d.defaclrole) || '|' || d.defaclobjtype || '|' || d.defaclacl::text FROM pg_default_acl d
UNION ALL
SELECT 'ledger|' || migration_name || '|' || (finished_at IS NOT NULL) || '|' || (rolled_back_at IS NOT NULL) FROM "_prisma_migrations"
UNION ALL
SELECT 'role|' || r.rolname || '|' || r.rolcanlogin || r.rolsuper || r.rolbypassrls || r.rolcreaterole || r.rolcreatedb || r.rolreplication
  FROM pg_roles r WHERE r.rolname LIKE 'fx\_%' OR r.rolname IN ('app_runtime', 'app_runtime_prod', 'app_auth', 'lab_owner')
UNION ALL
SELECT 'member|' || pg_get_userbyid(m.roleid) || '|' || pg_get_userbyid(m.member)
  FROM pg_auth_members m
 WHERE pg_get_userbyid(m.roleid) LIKE 'fx\_%' OR pg_get_userbyid(m.member) LIKE 'fx\_%'
    OR pg_get_userbyid(m.roleid) IN ('app_runtime', 'app_runtime_prod', 'app_auth', 'lab_owner');
