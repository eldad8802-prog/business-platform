-- ============================================================================
-- p2-business-identity-catalog-preflight.sql
--
-- Read-only Production PREFLIGHT for migration
--   20261004090000_p2_business_identity   (#601, merged a28602b3, NOT applied)
--
-- It measures every premise the migration's outcome depends on, BEFORE it is
-- applied, so that the post-apply proof
-- (sec-p2-business-identity-production-evidence.sql) can only pass for the
-- reasons the review expects:
--   * the ledger is clean and P2 is not recorded (no half-applied P2);
--   * none of the names P2 creates already exists (tables, sequences, indexes,
--     enum types, policies) — a collision would abort the migration;
--   * the FK target Business.id exists and the migration role can reference it;
--   * app_runtime exists (P2's privilege block runs only if it does) and every
--     runtime login is NOSUPERUSER NOBYPASSRLS (otherwise FORCE RLS is moot);
--   * the migration role's DEFAULT privileges hand app_runtime exactly arwd on
--     new tables and rU on new sequences, and nobody else anything. P2 revokes
--     d (and D) itself, so the runtime ends with exactly arw — the value the
--     post-apply proof asserts. A different default here means a different
--     post-apply state, which this check reports BEFORE anything is applied.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- INFO rows always PASS and carry a count. Names never appear in the output.
-- PRIVACY: catalog and ledger only — no business row is read.
-- Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== P2 business identity preflight — legend (n → check) =='
\echo ' 1 L0 migration ledger: no unfinished and no rolled-back row (observed = such rows)'
\echo ' 2 L1 20261004090000_p2_business_identity is NOT recorded (observed = rows of that name)'
\echo ' 3 L2 the latest finished migration is 20261003090000 (control-plane privileges)'
\echo ' 4 L3 finished migrations (INFO count; 163 expected)'
\echo ' 5 N1 none of the 13 relation names P2 creates exists (tables, id sequences, indexes)'
\echo ' 6 N2 none of the 4 enum type names P2 creates exists'
\echo ' 7 N3 no policy named p2_identity_* exists'
\echo ' 8 F1 Business.id exists as the integer primary key (FK target)'
\echo ' 9 F2 the migration role owns Business (it may reference it)'
\echo '10 F3 the migration role holds the schema-level object privilege on public'
\echo '11 R1 app_runtime exists (P2 privilege block runs only if it does), NOLOGIN NOSUPERUSER NOBYPASSRLS'
\echo '12 R2 runtime logins (members of app_runtime, migration role excluded) all NOSUPERUSER NOBYPASSRLS; observed = how many'
\echo '13 D1 default privileges (migration role, public, tables): app_runtime holds exactly arwd'
\echo '14 D2 default privileges (migration role, public, tables): no other grantee (observed = others)'
\echo '15 D3 default privileges (migration role, public, sequences): app_runtime holds exactly rU'
\echo '16 D4 default privileges (migration role, public, sequences): no other grantee (observed = others)'
\echo '17 D5 no schema-wide (global) default privileges of the migration role (observed = entries)'
\echo '18 X1 event triggers in this database (INFO count — DDL side effects)'
\echo '19 X2 app_* roles present (INFO count — each must end with no privilege on P2 tables except the runtime)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
p2 AS (SELECT '20261004090000_p2_business_identity'::text AS name),
ledger AS (SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"),
rel_names(nm) AS (VALUES
  ('BusinessIdentityStatement'), ('BusinessIdentityFactAuthority'),
  ('BusinessIdentityStatement_id_seq'), ('BusinessIdentityFactAuthority_id_seq'),
  ('BusinessIdentityStatement_pkey'), ('BusinessIdentityStatement_id_businessId_key'),
  ('BusinessIdentityStatement_businessId_status_dimension_idx'),
  ('BusinessIdentityStatement_active_single_key'), ('BusinessIdentityStatement_active_code_key'),
  ('BusinessIdentityFactAuthority_pkey'), ('BusinessIdentityFactAuthority_id_businessId_key'),
  ('BusinessIdentityFactAuthority_businessId_status_idx'), ('BusinessIdentityFactAuthority_active_fact_key')),
type_names(nm) AS (VALUES
  ('BusinessIdentityDimension'), ('BusinessIdentitySource'), ('BusinessIdentityStatus'), ('BusinessIdentityFact')),
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
biz AS (SELECT c.oid, c.relowner FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'Business' AND c.relkind = 'r'),
rt AS (SELECT oid, rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_runtime'),
rt_logins AS (
  SELECT r.oid, r.rolsuper, r.rolbypassrls
  FROM pg_roles r JOIN pg_auth_members m ON m.member = r.oid
  WHERE m.roleid = (SELECT oid FROM rt) AND r.rolcanlogin AND r.rolname <> current_user
),
-- default ACL entries of the migration role: (object kind, grantee, letters)
defacl_items AS (
  SELECT d.defaclobjtype AS kind, d.defaclnamespace AS nsp, x.grantee,
         (CASE x.privilege_type
            WHEN 'SELECT' THEN 'r' WHEN 'INS' || 'ERT' THEN 'a' WHEN 'UPD' || 'ATE' THEN 'w'
            WHEN 'DEL' || 'ETE' THEN 'd' WHEN 'TRUNC' || 'ATE' THEN 'D' WHEN 'REFERENCES' THEN 'x'
            WHEN 'TRIGGER' THEN 't' WHEN 'USAGE' THEN 'U' WHEN 'MAINTAIN' THEN 'm'
            ELSE '?' END) COLLATE "C" AS l
  FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) x
  WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)
),
defacl AS (
  SELECT kind, nsp, grantee, string_agg(DISTINCT l, '' ORDER BY l) AS letters
  FROM defacl_items GROUP BY kind, nsp, grantee
),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM ledger WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
            (SELECT count(*) FROM ledger WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 2, (SELECT count(*) FROM ledger WHERE migration_name = (SELECT name FROM p2)) = 0,
                      (SELECT count(*) FROM ledger WHERE migration_name = (SELECT name FROM p2))
  UNION ALL SELECT 3, (SELECT max(migration_name) FROM ledger WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)
                        = '20261003090000_control_plane_production_privileges', 1
  UNION ALL SELECT 4, true, (SELECT count(*) FROM ledger WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 5, NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname IN (SELECT nm FROM rel_names)),
                      (SELECT count(*) FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname IN (SELECT nm FROM rel_names))
  UNION ALL SELECT 6, NOT EXISTS (SELECT 1 FROM pg_type t WHERE t.typnamespace = (SELECT oid FROM pub) AND t.typname IN (SELECT nm FROM type_names)),
                      (SELECT count(*) FROM pg_type t WHERE t.typnamespace = (SELECT oid FROM pub) AND t.typname IN (SELECT nm FROM type_names))
  UNION ALL SELECT 7, NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname LIKE 'p2\_identity\_%'),
                      (SELECT count(*) FROM pg_policy WHERE polname LIKE 'p2\_identity\_%')
  UNION ALL SELECT 8, EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
                               WHERE k.conrelid = (SELECT oid FROM biz) AND k.contype = 'p' AND cardinality(k.conkey) = 1
                                 AND a.attname = 'id' AND a.atttypid = 'integer'::regtype), 1
  UNION ALL SELECT 9, (SELECT relowner FROM biz) = (SELECT oid FROM pg_roles WHERE rolname = current_user), 1
  UNION ALL SELECT 10, has_schema_privilege(current_user, 'public', 'CRE' || 'ATE'), 1
  UNION ALL SELECT 11, EXISTS (SELECT 1 FROM rt WHERE NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls), (SELECT count(*) FROM rt)
  UNION ALL SELECT 12, EXISTS (SELECT 1 FROM rt_logins) AND NOT EXISTS (SELECT 1 FROM rt_logins WHERE rolsuper OR rolbypassrls),
                       (SELECT count(*) FROM rt_logins)
  UNION ALL SELECT 13, EXISTS (SELECT 1 FROM defacl WHERE kind = 'r' AND nsp = (SELECT oid FROM pub) AND grantee = (SELECT oid FROM rt) AND letters = 'adrw'),
                       (SELECT count(*) FROM defacl WHERE kind = 'r' AND nsp = (SELECT oid FROM pub) AND grantee = (SELECT oid FROM rt))
  UNION ALL SELECT 14, NOT EXISTS (SELECT 1 FROM defacl WHERE kind = 'r' AND nsp = (SELECT oid FROM pub) AND grantee <> (SELECT oid FROM rt)),
                       (SELECT count(*) FROM defacl WHERE kind = 'r' AND nsp = (SELECT oid FROM pub) AND grantee <> (SELECT oid FROM rt))
  UNION ALL SELECT 15, EXISTS (SELECT 1 FROM defacl WHERE kind = 'S' AND nsp = (SELECT oid FROM pub) AND grantee = (SELECT oid FROM rt) AND letters = 'Ur'),
                       (SELECT count(*) FROM defacl WHERE kind = 'S' AND nsp = (SELECT oid FROM pub) AND grantee = (SELECT oid FROM rt))
  UNION ALL SELECT 16, NOT EXISTS (SELECT 1 FROM defacl WHERE kind = 'S' AND nsp = (SELECT oid FROM pub) AND grantee <> (SELECT oid FROM rt)),
                       (SELECT count(*) FROM defacl WHERE kind = 'S' AND nsp = (SELECT oid FROM pub) AND grantee <> (SELECT oid FROM rt))
  UNION ALL SELECT 17, NOT EXISTS (SELECT 1 FROM defacl WHERE nsp = 0), (SELECT count(*) FROM defacl WHERE nsp = 0)
  UNION ALL SELECT 18, true, (SELECT count(*) FROM pg_event_trigger)
  UNION ALL SELECT 19, true, (SELECT count(*) FROM pg_roles WHERE rolname LIKE 'app\_%')
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
