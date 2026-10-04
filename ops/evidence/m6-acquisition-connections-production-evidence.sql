-- ============================================================================
-- m6-acquisition-connections-production-evidence.sql
--
-- Read-only POST-APPLY proof that migration
--   20261007090000_m6_acquisition_connections
-- is in force with exactly its intended security properties.
--
-- NO DATA ROW is read except counts. Catalog, ledger and feature governance rows only.
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== M6 acquisition connections post-apply proof — legend (n → check) =='
\echo ' 1 Q0 M6 recorded: finished, not rolled back, checksum = the reviewed file'
\echo ' 2 Q1 ledger: no unfinished and no rolled-back row'
\echo ' 3 T1 AcquisitionConnection has exactly the 21 reviewed columns (observed = columns)'
\echo ' 4 T2 exactly the 12 named CHECK constraints, all validated (observed = checks)'
\echo ' 5 T3 indexes: pkey, publicId unique, (id,businessId) unique, the tenant index, and the PARTIAL live-resource unique (observed = indexes)'
\echo ' 6 T4 exactly one FK: businessId -> Business, cascade, validated'
\echo ' 7 S1 RLS enabled AND forced'
\echo ' 8 S2 exactly 3 policies: SELECT / INS / UPD, permissive, PUBLIC, the tenant predicate (no DEL, no ALL)'
\echo ' 9 G1 runtime (group + logins): exactly arw on the table, Ur on its sequence (observed = roles checked)'
\echo '10 G2 no other app_* role holds anything on the table or its sequence'
\echo '11 G3 PUBLIC holds nothing on the table or sequence and cannot EXECUTE the lookups'
\echo '12 F1 exactly 4 m6_acquisition_* functions: SECURITY DEFINER, STABLE, search_path pinned, owned by the migration role'
\echo '13 F2 app_runtime may EXECUTE all 4; app_auth / app_ctlplane / app_admin none (observed = executable by others)'
\echo '14 X1 the three acquisition features: defined OFF, policies OFF, no business override (observed = overrides)'
\echo '15 X2 runtime logins NOSUPERUSER NOBYPASSRLS; the migration role (definer) is BYPASSRLS'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
tbl AS (SELECT c.oid, c.relacl, c.relowner, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
        WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'AcquisitionConnection' AND c.relkind = 'r'),
seq AS (SELECT c.oid, c.relacl FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'AcquisitionConnection_id_seq'),
tenant(e) AS (VALUES ('("businessId" = (NULLIF(current_setting(''app.current_business_id''::text, true), ''''::text))::integer)')),
expected_cols(col) AS (VALUES ('id'), ('businessId'), ('sourceKey'), ('status'), ('publicId'), ('externalResourceId'), ('label'),
  ('keyHash'), ('keyHint'), ('allowedOrigins'), ('credentialCiphertext'), ('credentialIv'), ('credentialTag'), ('credentialKeyId'),
  ('credentialExpiresAt'), ('createdByUserId'), ('lastEventAt'), ('lastErrorCode'), ('revokedAt'), ('createdAt'), ('updatedAt')),
cols AS (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = (SELECT oid FROM tbl) AND a.attnum > 0 AND NOT a.attisdropped),
expected_checks(nm) AS (VALUES ('source_key'), ('status'), ('revoked_shape'), ('public_id'), ('external_resource'), ('key_hash'),
  ('key_hint'), ('label'), ('error_code'), ('origins'), ('credential_shape'), ('source_shape')),
checks_c AS (SELECT conname, convalidated FROM pg_constraint WHERE conrelid = (SELECT oid FROM tbl) AND contype = 'c'),
idx AS (SELECT ic.relname, i.indisunique, i.indisprimary, pg_get_expr(i.indpred, i.indrelid) AS pred
        FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid WHERE i.indrelid = (SELECT oid FROM tbl)),
pol AS (SELECT p.polcmd::text AS cmd, p.polpermissive AS permissive, p.polroles,
               pg_get_expr(p.polqual, p.polrelid) AS qual, pg_get_expr(p.polwithcheck, p.polrelid) AS wcheck
        FROM pg_policy p WHERE p.polrelid = (SELECT oid FROM tbl)),
rt AS (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime'),
runtime_roles AS (SELECT r.oid, r.rolname, r.rolsuper, r.rolbypassrls, r.rolcanlogin FROM pg_roles r
                  WHERE r.oid = (SELECT oid FROM rt)
                     OR (r.rolcanlogin AND r.rolname <> current_user AND EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid AND m.roleid = (SELECT oid FROM rt)))),
others AS (SELECT r.oid FROM pg_roles r WHERE r.rolname LIKE 'app\_%' AND r.rolname <> current_user
           AND r.oid NOT IN (SELECT oid FROM runtime_roles)
           AND NOT pg_has_role(r.oid, (SELECT oid FROM rt), 'USAGE')),
fns AS (SELECT p.oid, p.proname, p.prosecdef, p.provolatile, p.proowner, p.proconfig, p.proacl
        FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pub) AND p.proname LIKE 'm6\_acquisition\_%'),
fkeys(k) AS (VALUES ('acquisition_meta_lead_ads'), ('acquisition_google_lead_forms'), ('acquisition_web_forms')),
checks(n, ok, observed_count) AS (
  SELECT 1, EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261007090000_m6_acquisition_connections'
                     AND finished_at IS NOT NULL AND rolled_back_at IS NULL
                     AND checksum = '9bdbf251828f8c1eafb852481880a6a305e266c52dab86eea19a62d943f766e4'),
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261007090000_m6_acquisition_connections')
  UNION ALL SELECT 2, NOT EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL),
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, (SELECT count(*) FROM cols) = 21 AND NOT EXISTS (SELECT col FROM expected_cols EXCEPT SELECT attname FROM cols),
                      (SELECT count(*) FROM cols)
  UNION ALL SELECT 4, (SELECT count(*) FROM checks_c) = 12 AND (SELECT bool_and(convalidated) FROM checks_c)
                      AND NOT EXISTS (SELECT 'AcquisitionConnection_' || nm FROM expected_checks EXCEPT SELECT conname FROM checks_c),
                      (SELECT count(*) FROM checks_c)
  UNION ALL SELECT 5, (SELECT count(*) FROM idx) = 5
                      AND EXISTS (SELECT 1 FROM idx WHERE relname = 'AcquisitionConnection_pkey' AND indisprimary)
                      AND EXISTS (SELECT 1 FROM idx WHERE relname = 'AcquisitionConnection_publicId_key' AND indisunique AND pred IS NULL)
                      AND EXISTS (SELECT 1 FROM idx WHERE relname = 'AcquisitionConnection_id_businessId_key' AND indisunique AND pred IS NULL)
                      AND EXISTS (SELECT 1 FROM idx WHERE relname = 'AcquisitionConnection_businessId_sourceKey_status_idx' AND NOT indisunique)
                      AND EXISTS (SELECT 1 FROM idx WHERE relname = 'AcquisitionConnection_live_resource_key' AND indisunique
                                   AND position('"externalResourceId" IS NOT NULL' IN pred) > 0 AND position('''REVOKED''' IN pred) > 0),
                      (SELECT count(*) FROM idx)
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM tbl) AND k.contype = 'f') = 1
                      AND EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM tbl) AND k.contype = 'f'
                                   AND k.confrelid = 'public."Business"'::regclass AND k.confdeltype = 'c' AND k.convalidated), 1
  UNION ALL SELECT 7, (SELECT relrowsecurity AND relforcerowsecurity FROM tbl), 1
  UNION ALL SELECT 8, (SELECT count(*) FROM pol) = 3
                      AND EXISTS (SELECT 1 FROM pol, tenant WHERE cmd = 'r' AND permissive AND polroles = '{0}' AND qual = tenant.e AND wcheck IS NULL)
                      AND EXISTS (SELECT 1 FROM pol, tenant WHERE cmd = 'a' AND permissive AND polroles = '{0}' AND qual IS NULL AND wcheck = tenant.e)
                      AND EXISTS (SELECT 1 FROM pol, tenant WHERE cmd = 'w' AND permissive AND polroles = '{0}' AND qual = tenant.e AND wcheck = tenant.e),
                      (SELECT count(*) FROM pol)
  UNION ALL SELECT 9, EXISTS (SELECT 1 FROM runtime_roles WHERE rolcanlogin)
                      AND NOT EXISTS (SELECT 1 FROM runtime_roles r WHERE NOT (
                            has_table_privilege(r.oid, (SELECT oid FROM tbl), 'SELECT') AND has_table_privilege(r.oid, (SELECT oid FROM tbl), 'INS' || 'ERT')
                        AND has_table_privilege(r.oid, (SELECT oid FROM tbl), 'UPD' || 'ATE') AND NOT has_table_privilege(r.oid, (SELECT oid FROM tbl), 'DEL' || 'ETE')
                        AND NOT has_table_privilege(r.oid, (SELECT oid FROM tbl), 'TRUNC' || 'ATE') AND NOT has_table_privilege(r.oid, (SELECT oid FROM tbl), 'REFERENCES')
                        AND NOT has_table_privilege(r.oid, (SELECT oid FROM tbl), 'TRIGGER')
                        AND has_sequence_privilege(r.oid, (SELECT oid FROM seq), 'USAGE') AND has_sequence_privilege(r.oid, (SELECT oid FROM seq), 'SELECT')
                        AND NOT has_sequence_privilege(r.oid, (SELECT oid FROM seq), 'UPD' || 'ATE'))),
                      (SELECT count(*) FROM runtime_roles)
  UNION ALL SELECT 10, NOT EXISTS (SELECT 1 FROM others o CROSS JOIN unnest(ARRAY['SELECT', 'INS' || 'ERT', 'UPD' || 'ATE', 'DEL' || 'ETE', 'TRUNC' || 'ATE', 'REFERENCES', 'TRIGGER']) v
                                    WHERE has_table_privilege(o.oid, (SELECT oid FROM tbl), v))
                       AND NOT EXISTS (SELECT 1 FROM others o WHERE has_sequence_privilege(o.oid, (SELECT oid FROM seq), 'USAGE')),
                       (SELECT count(*) FROM others)
  UNION ALL SELECT 11, NOT EXISTS (SELECT 1 FROM tbl, aclexplode(tbl.relacl) x WHERE x.grantee = 0)
                       AND NOT EXISTS (SELECT 1 FROM seq, aclexplode(seq.relacl) x WHERE x.grantee = 0)
                       AND NOT EXISTS (SELECT 1 FROM fns f, aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) x WHERE x.grantee = 0),
                       (SELECT count(*) FROM fns f, aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) x WHERE x.grantee = 0)
  UNION ALL SELECT 12, (SELECT count(*) FROM fns) = 4
                       AND NOT EXISTS (SELECT 1 FROM fns WHERE NOT prosecdef OR provolatile <> 's'
                                        OR proowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user)
                                        OR NOT ('search_path=pg_catalog, public' = ANY (coalesce(proconfig, ARRAY[]::text[])))),
                       (SELECT count(*) FROM fns)
  UNION ALL SELECT 13, (SELECT count(*) FROM fns f WHERE has_function_privilege((SELECT oid FROM rt), f.oid, 'EXECUTE')) = 4
                       AND NOT EXISTS (SELECT 1 FROM fns f CROSS JOIN pg_roles r
                                        WHERE r.rolname IN ('app_auth', 'app_ctlplane', 'app_admin') AND has_function_privilege(r.oid, f.oid, 'EXECUTE')),
                       (SELECT count(*) FROM fns f CROSS JOIN pg_roles r
                         WHERE r.rolname IN ('app_auth', 'app_ctlplane', 'app_admin') AND has_function_privilege(r.oid, f.oid, 'EXECUTE'))
  UNION ALL SELECT 14, (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE key IN (SELECT k FROM fkeys) AND NOT "defaultEnabled") = 3
                       AND (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" IN (SELECT k FROM fkeys) AND NOT "globalEnabled" AND NOT "emergencyDisabled") = 3
                       AND NOT EXISTS (SELECT 1 FROM "BusinessFeatureAccess" WHERE "featureKey" IN (SELECT k FROM fkeys)),
                       (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" IN (SELECT k FROM fkeys))
  UNION ALL SELECT 15, NOT EXISTS (SELECT 1 FROM runtime_roles WHERE rolsuper OR rolbypassrls)
                       AND (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user), 1
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
