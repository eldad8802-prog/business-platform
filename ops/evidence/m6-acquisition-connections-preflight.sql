-- ============================================================================
-- m6-acquisition-connections-preflight.sql
--
-- Read-only Production PREFLIGHT for migration
--   20261008090000_m6_acquisition_connections   (M6 PR-A — NOT applied)
--
-- Measures every premise the migration's outcome depends on:
--   * the ledger is clean, M6 is not recorded and B4 is the latest migration;
--   * none of the names M6 creates exists (table, sequence, indexes, policies, functions) and none
--     of its three feature keys is defined yet;
--   * the FK target Business.id exists; the migration role owns Business and is BYPASSRLS — the
--     pre-tenant lookup functions run as that role and must read the FORCE-RLS table;
--   * app_runtime exists (the privilege blocks run only if it does) and every runtime login is
--     NOSUPERUSER NOBYPASSRLS;
--   * the migration role's DEFAULT privileges hand app_runtime exactly arwd on new tables and rU on
--     new sequences and nobody else anything (M6 revokes d and D itself, ending at arw);
--   * the feature tables accept the ON CONFLICT targets the migration names.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog and ledger only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== M6 acquisition connections preflight — legend (n → check) =='
\echo ' 1 L0 migration ledger: no unfinished and no rolled-back row (observed = such rows)'
\echo ' 2 L1 20261008090000_m6_acquisition_connections is NOT recorded'
\echo ' 3 L2 every finished migration sorts BEFORE M6 (M6 is next; nothing later was applied first)'
\echo ' 4 L3 finished migrations (INFO count)'
\echo ' 5 N1 none of the relation names M6 creates exists (table, sequence, 5 indexes)'
\echo ' 6 N2 no policy named m6_acquisition_* exists'
\echo ' 7 N3 no function named m6_acquisition_* exists'
\echo ' 8 N4 none of the three acquisition feature keys is defined (definitions + policies)'
\echo ' 9 F1 Business.id is the integer primary key (FK target)'
\echo '10 F2 the migration role owns Business'
\echo '11 F3 the migration role is BYPASSRLS (the SECURITY DEFINER lookups read a FORCE-RLS table)'
\echo '12 R1 app_runtime exists, NOLOGIN NOSUPERUSER NOBYPASSRLS'
\echo '13 R2 runtime logins (migration role excluded) are NOSUPERUSER NOBYPASSRLS — observed = how many'
\echo '14 D1 default privileges (migration role, public, tables): app_runtime holds exactly arwd'
\echo '15 D2 default privileges (migration role, public, tables): no other grantee (observed = others)'
\echo '16 D3 default privileges (migration role, public, sequences): app_runtime holds exactly rU'
\echo '17 D4 default privileges (migration role): nothing schema-wide (global) and no other sequence grantee'
\echo '18 P1 PlatformFeatureDefinition.key and PlatformFeaturePolicy.featureKey are unique (ON CONFLICT targets)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
ledger AS (SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"),
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
rel_names(nm) AS (VALUES ('AcquisitionConnection'), ('AcquisitionConnection_id_seq'), ('AcquisitionConnection_pkey'),
  ('AcquisitionConnection_publicId_key'), ('AcquisitionConnection_id_businessId_key'),
  ('AcquisitionConnection_businessId_sourceKey_status_idx'), ('AcquisitionConnection_live_resource_key')),
feature_keys(k) AS (VALUES ('acquisition_meta_lead_ads'), ('acquisition_google_lead_forms'), ('acquisition_web_forms')),
biz AS (SELECT c.oid, c.relowner FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'Business' AND c.relkind = 'r'),
me AS (SELECT oid, rolbypassrls FROM pg_roles WHERE rolname = current_user),
rt AS (SELECT oid, rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_runtime'),
rt_logins AS (SELECT r.oid, r.rolsuper, r.rolbypassrls FROM pg_roles r JOIN pg_auth_members m ON m.member = r.oid
              WHERE m.roleid = (SELECT oid FROM rt) AND r.rolcanlogin AND r.rolname <> current_user),
defacl_items AS (
  SELECT d.defaclobjtype AS kind, d.defaclnamespace AS nsp, x.grantee,
         (CASE x.privilege_type
            WHEN 'SELECT' THEN 'r' WHEN 'INS' || 'ERT' THEN 'a' WHEN 'UPD' || 'ATE' THEN 'w'
            WHEN 'DEL' || 'ETE' THEN 'd' WHEN 'TRUNC' || 'ATE' THEN 'D' WHEN 'REFERENCES' THEN 'x'
            WHEN 'TRIGGER' THEN 't' WHEN 'USAGE' THEN 'U' WHEN 'MAINTAIN' THEN 'm' ELSE '?' END) COLLATE "C" AS l
  FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) x
  WHERE d.defaclrole = (SELECT oid FROM me)),
defacl AS (SELECT kind, nsp, grantee, string_agg(DISTINCT l, '' ORDER BY l) AS letters FROM defacl_items GROUP BY kind, nsp, grantee),
uniq_on(tbl, col) AS (VALUES ('PlatformFeatureDefinition', 'key'), ('PlatformFeaturePolicy', 'featureKey')),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM ledger WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
            (SELECT count(*) FROM ledger WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 2, NOT EXISTS (SELECT 1 FROM ledger WHERE migration_name = '20261008090000_m6_acquisition_connections'),
                      (SELECT count(*) FROM ledger WHERE migration_name = '20261008090000_m6_acquisition_connections')
  UNION ALL SELECT 3, (SELECT max(migration_name) FROM ledger WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)
                        < '20261008090000_m6_acquisition_connections', 1
  UNION ALL SELECT 4, true, (SELECT count(*) FROM ledger WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 5, NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname IN (SELECT nm FROM rel_names)),
                      (SELECT count(*) FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname IN (SELECT nm FROM rel_names))
  UNION ALL SELECT 6, NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname LIKE 'm6\_acquisition\_%'),
                      (SELECT count(*) FROM pg_policy WHERE polname LIKE 'm6\_acquisition\_%')
  UNION ALL SELECT 7, NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pub) AND p.proname LIKE 'm6\_acquisition\_%'),
                      (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pub) AND p.proname LIKE 'm6\_acquisition\_%')
  UNION ALL SELECT 8, (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE key IN (SELECT k FROM feature_keys))
                      + (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" IN (SELECT k FROM feature_keys)) = 0,
                      (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE key IN (SELECT k FROM feature_keys))
                      + (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" IN (SELECT k FROM feature_keys))
  UNION ALL SELECT 9, EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
                               WHERE k.conrelid = (SELECT oid FROM biz) AND k.contype = 'p' AND cardinality(k.conkey) = 1
                                 AND a.attname = 'id' AND a.atttypid = 'integer'::regtype), 1
  UNION ALL SELECT 10, (SELECT relowner FROM biz) = (SELECT oid FROM me), 1
  UNION ALL SELECT 11, (SELECT rolbypassrls FROM me), 1
  UNION ALL SELECT 12, EXISTS (SELECT 1 FROM rt WHERE NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls), (SELECT count(*) FROM rt)
  UNION ALL SELECT 13, EXISTS (SELECT 1 FROM rt_logins) AND NOT EXISTS (SELECT 1 FROM rt_logins WHERE rolsuper OR rolbypassrls),
                       (SELECT count(*) FROM rt_logins)
  UNION ALL SELECT 14, EXISTS (SELECT 1 FROM defacl WHERE kind = 'r' AND nsp = (SELECT oid FROM pub) AND grantee = (SELECT oid FROM rt) AND letters = 'adrw'),
                       (SELECT count(*) FROM defacl WHERE kind = 'r' AND nsp = (SELECT oid FROM pub) AND grantee = (SELECT oid FROM rt))
  UNION ALL SELECT 15, NOT EXISTS (SELECT 1 FROM defacl WHERE kind = 'r' AND nsp = (SELECT oid FROM pub) AND grantee <> (SELECT oid FROM rt)),
                       (SELECT count(*) FROM defacl WHERE kind = 'r' AND nsp = (SELECT oid FROM pub) AND grantee <> (SELECT oid FROM rt))
  UNION ALL SELECT 16, EXISTS (SELECT 1 FROM defacl WHERE kind = 'S' AND nsp = (SELECT oid FROM pub) AND grantee = (SELECT oid FROM rt) AND letters = 'Ur'),
                       (SELECT count(*) FROM defacl WHERE kind = 'S' AND nsp = (SELECT oid FROM pub) AND grantee = (SELECT oid FROM rt))
  UNION ALL SELECT 17, NOT EXISTS (SELECT 1 FROM defacl WHERE nsp = 0)
                       AND NOT EXISTS (SELECT 1 FROM defacl WHERE kind = 'S' AND nsp = (SELECT oid FROM pub) AND grantee <> (SELECT oid FROM rt)),
                       (SELECT count(*) FROM defacl WHERE nsp = 0)
  UNION ALL SELECT 18, (SELECT count(*) FROM uniq_on u WHERE EXISTS (
                          SELECT 1 FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid AND t.relnamespace = (SELECT oid FROM pub)
                          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
                          WHERE t.relname = u.tbl AND i.indisunique AND i.indnatts = 1 AND a.attname = u.col AND i.indpred IS NULL)) = 2, 2
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
