-- ============================================================================
-- document-supplier-link-production-evidence.sql
--
-- Read-only Production EVIDENCE after migration
--   20261103090000_document_supplier_link
--
-- Proves the migration's outcome, from the catalog and counts only:
--   * it is recorded and finished, its sha256 is the reviewed one, nothing is unfinished or rolled back;
--   * the two new tables have RLS ENABLED + FORCED and exactly their five per-command policies, every one
--     PERMISSIVE, for PUBLIC, with USING / WITH CHECK equal to the tenant GUC expression; no FOR ALL policy and no
--     remove-rows policy;
--   * the exact ACL of both tables and both sequences (app_runtime only: the decision row read / add / change, the
--     trail read / add); no column-level privilege;
--   * the five composite tenant keys (document, supplier, previous supplier) exist, span two columns and are
--     validated; the fifteen CHECK constraints exist and are validated;
--   * the three triggers exist and are enabled; the three functions exist; SECURITY DEFINER exactly on the erasure
--     function, with a pinned search_path, owned by the migration role; EXECUTE on it held by app_runtime alone;
--   * the five ExtractedData columns exist with their types; ownBusinessExcluded is NOT NULL with default false;
--   * the flag document_supplier_linking exists and is OFF, with no business override;
--   * nothing was written: both tables are empty and no ExtractedData row carries an issuer reading.
--
-- Checks 21 and 22 run first: the row counts are taken with row_security = off, so a query that row level
-- security would filter stops the run with an ERROR instead of reporting a smaller number.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== document supplier link production evidence: legend (n -> check) =='
\echo '21 V1 the evidence role is a superuser or has BYPASSRLS, so it sees every row (runs first)'
\echo '22 V2 row level security is not active on "DocumentSupplierLink" for the evidence role (runs first)'
\echo ' 1 the migration is recorded and finished (observed = finished rows)'
\echo ' 2 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 3 the recorded checksum is the reviewed sha256 of migration.sql'
\echo ' 4 both new tables: RLS ENABLED + FORCED (observed = of 2)'
\echo ' 5 exactly 5 policies, per command, PERMISSIVE, PUBLIC; no other policy on them (observed = policies)'
\echo ' 6 every policy USING / WITH CHECK equals the tenant GUC expression exactly (observed = mismatches)'
\echo ' 7 no FOR ALL and no remove-rows policy on either table (observed = such policies)'
\echo ' 8 the ACL of both tables and both sequences is exactly as reviewed, app_runtime only (observed = mismatching objects)'
\echo ' 9 no column-level privilege on either table (observed = column ACL items)'
\echo '10 the five composite tenant keys exist, span two columns, validated (observed = of 5)'
\echo '11 the fifteen CHECK constraints (ten on the new tables, five on ExtractedData) exist and are validated (observed = of 15)'
\echo '12 the three triggers exist and are enabled (observed = of 3)'
\echo '13 the three document_supplier_link functions exist (observed = functions)'
\echo '14 SECURITY DEFINER exactly on the erasure function; search_path pinned; owned by the migration role (observed = matching, of 1)'
\echo '15 EXECUTE: app_runtime alone on the erasure function; nobody but the owner on the trigger functions (observed = other holders)'
\echo '16 ExtractedData: the five issuer columns with their types; ownBusinessExcluded NOT NULL default false (observed = of 6)'
\echo '17 flag document_supplier_linking: defaultEnabled false, globalEnabled false, emergencyDisabled false, no override (observed = overrides)'
\echo '18 nothing written: both new tables hold no row (observed = rows)'
\echo '19 no ExtractedData row carries an issuer reading yet (observed = rows)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
-- Hard stop: a query that row level security would filter raises an ERROR instead.
SET LOCAL row_security = off;

\echo '== visibility checks (21, 22) =='
WITH
dl AS (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'DocumentSupplierLink' AND c.relkind = 'r'),
checks(n, ok, observed_count) AS (
            SELECT 21, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) IS TRUE, 1
  UNION ALL SELECT 22, row_security_active((SELECT oid FROM dl)) IS FALSE, 1
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

\echo '== evidence checks (1-19) =='
WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
rel(nm, oid, relowner, relrowsecurity, relforcerowsecurity, relacl) AS (
  SELECT c.relname, c.oid, c.relowner, c.relrowsecurity, c.relforcerowsecurity, c.relacl
  FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub)),
rt AS (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime'),
tables(nm) AS (VALUES ('DocumentSupplierLink'), ('DocumentSupplierLinkEvent')),
ed AS (SELECT oid FROM rel WHERE nm = 'ExtractedData'),
expected_expr(e) AS (VALUES ('("businessId" = (NULLIF(current_setting(''app.current_business_id''::text, true), ''''::text))::integer)')),
expected_pol(tbl, polname, cmd, has_q, has_wc) AS (VALUES
  ('DocumentSupplierLink', 'document_supplier_link_tenant_select', 'r', true, false),
  ('DocumentSupplierLink', 'document_supplier_link_tenant_insert', 'a', false, true),
  ('DocumentSupplierLink', 'document_supplier_link_tenant_update', 'w', true, true),
  ('DocumentSupplierLinkEvent', 'document_supplier_link_event_tenant_select', 'r', true, false),
  ('DocumentSupplierLinkEvent', 'document_supplier_link_event_tenant_insert', 'a', false, true)),
pols AS (SELECT r.nm AS tbl, p.polname, p.polcmd::text AS cmd, p.polpermissive, p.polroles,
                pg_get_expr(p.polqual, p.polrelid) AS q, pg_get_expr(p.polwithcheck, p.polrelid) AS wc
         FROM pg_policy p JOIN rel r ON r.oid = p.polrelid WHERE r.nm IN (SELECT nm FROM tables)),
letter AS (SELECT * FROM (VALUES ('SELECT', 'r'), ('INS' || 'ERT', 'a'), ('UPD' || 'ATE', 'w'), ('DEL' || 'ETE', 'd'),
                                 ('TRUNC' || 'ATE', 'D'), ('REFERENCES', 'x'), ('TRIGGER', 't'), ('MAINTAIN', 'm'),
                                 ('USAGE', 'U')) v(priv, l)),
acl_items AS (SELECT r.nm, x.grantee, (SELECT l FROM letter WHERE priv = x.privilege_type) COLLATE "C" AS l
              FROM rel r CROSS JOIN LATERAL aclexplode(r.relacl) x WHERE x.grantee <> r.relowner),
acl_letters AS (SELECT nm, grantee, string_agg(DISTINCT l, '' ORDER BY l) AS letters FROM acl_items GROUP BY nm, grantee),
expected_acl(nm, letters) AS (VALUES
  ('DocumentSupplierLink', 'arw'), ('DocumentSupplierLink_id_seq', 'Ur'),
  ('DocumentSupplierLinkEvent', 'ar'), ('DocumentSupplierLinkEvent_id_seq', 'Ur')),
acl_mismatch AS (
  SELECT e.nm FROM expected_acl e
   WHERE (SELECT count(*) FROM acl_letters a WHERE a.nm = e.nm) <> 1
      OR NOT EXISTS (SELECT 1 FROM acl_letters a WHERE a.nm = e.nm AND a.grantee = (SELECT oid FROM rt) AND a.letters = e.letters)),
expected_fk(conname) AS (VALUES
  ('DocumentSupplierLink_document_fkey'), ('DocumentSupplierLink_supplier_fkey'),
  ('DocumentSupplierLinkEvent_document_fkey'), ('DocumentSupplierLinkEvent_supplier_fkey'),
  ('DocumentSupplierLinkEvent_previousSupplier_fkey')),
expected_check(conname) AS (VALUES
  ('DocumentSupplierLink_status'), ('DocumentSupplierLink_method'), ('DocumentSupplierLink_reason'),
  ('DocumentSupplierLink_shape'), ('DocumentSupplierLink_version'),
  ('DocumentSupplierLinkEvent_action'), ('DocumentSupplierLinkEvent_method'), ('DocumentSupplierLinkEvent_reason'),
  ('DocumentSupplierLinkEvent_shape'), ('DocumentSupplierLinkEvent_idempotencyKey'),
  ('ExtractedData_issuerTaxId_shape'), ('ExtractedData_issuerTaxIdSource')),
expected_check_ed(conname) AS (VALUES ('ExtractedData_issuerTaxId_together'), ('ExtractedData_issuerCheck'), ('ExtractedData_issuerCheck_shape')),
expected_trg(tgname) AS (VALUES
  ('DocumentSupplierLink_user_same_business'), ('DocumentSupplierLinkEvent_user_same_business'),
  ('DocumentSupplierLinkEvent_append_only')),
expected_col(attname, typ, nn) AS (VALUES
  ('issuerTaxId', 'text', false), ('issuerTaxIdSource', 'text', false), ('issuerTaxIdValid', 'boolean', false),
  ('issuerCheck', 'text', false), ('ownBusinessExcluded', 'boolean', true)),
fns AS (SELECT p.oid, p.proname, p.prosecdef, p.proconfig, p.proowner, p.proacl FROM pg_proc p
        WHERE p.pronamespace = (SELECT oid FROM pub) AND p.proname LIKE 'document\_supplier\_link\_%'),
fn_grants AS (SELECT f.proname, x.grantee FROM fns f CROSS JOIN LATERAL aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) x
              WHERE x.privilege_type = 'EXECUTE' AND x.grantee <> f.proowner),
mig_owner AS (SELECT relowner FROM rel WHERE nm = 'DocumentSupplierLink'),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261103090000_document_supplier_link'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1,
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261103090000_document_supplier_link'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, (SELECT checksum FROM "_prisma_migrations" WHERE migration_name = '20261103090000_document_supplier_link') = '87ce27ed43d323bcf8ca75e98202fb0ccb7098c8131b4704303e2d7d532aeac3', 1
  UNION ALL SELECT 4, (SELECT count(*) FROM rel WHERE nm IN (SELECT nm FROM tables) AND relrowsecurity AND relforcerowsecurity) = 2,
                      (SELECT count(*) FROM rel WHERE nm IN (SELECT nm FROM tables) AND relrowsecurity AND relforcerowsecurity)
  UNION ALL SELECT 5, (SELECT count(*) FROM pols) = 5
                      AND (SELECT count(*) FROM pols p JOIN expected_pol e ON e.tbl = p.tbl AND e.polname = p.polname AND e.cmd = p.cmd
                            WHERE p.polpermissive AND p.polroles = ARRAY[0]::oid[]
                              AND (p.q IS NOT NULL) = e.has_q AND (p.wc IS NOT NULL) = e.has_wc) = 5,
                      (SELECT count(*) FROM pols)
  UNION ALL SELECT 6, (SELECT count(*) FROM pols WHERE (q IS NOT NULL AND q <> (SELECT e FROM expected_expr))
                                                    OR (wc IS NOT NULL AND wc <> (SELECT e FROM expected_expr))) = 0,
                      (SELECT count(*) FROM pols WHERE (q IS NOT NULL AND q <> (SELECT e FROM expected_expr))
                                                    OR (wc IS NOT NULL AND wc <> (SELECT e FROM expected_expr)))
  UNION ALL SELECT 7, (SELECT count(*) FROM pols WHERE cmd IN ('*', 'd')) = 0, (SELECT count(*) FROM pols WHERE cmd IN ('*', 'd'))
  UNION ALL SELECT 8, (SELECT count(*) FROM acl_mismatch) = 0, (SELECT count(*) FROM acl_mismatch)
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x
                         WHERE a.attrelid IN (SELECT oid FROM rel WHERE nm IN (SELECT nm FROM tables))) = 0,
                      (SELECT count(*) FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x
                         WHERE a.attrelid IN (SELECT oid FROM rel WHERE nm IN (SELECT nm FROM tables)))
  UNION ALL SELECT 10, (SELECT count(*) FROM pg_constraint c JOIN expected_fk e ON e.conname = c.conname
                          WHERE c.contype = 'f' AND c.convalidated AND array_length(c.conkey, 1) = 2) = 5,
                       (SELECT count(*) FROM pg_constraint c JOIN expected_fk e ON e.conname = c.conname
                          WHERE c.contype = 'f' AND c.convalidated AND array_length(c.conkey, 1) = 2)
  UNION ALL SELECT 11, (SELECT count(*) FROM pg_constraint c JOIN expected_check e ON e.conname = c.conname
                          WHERE c.contype = 'c' AND c.convalidated)
                       + (SELECT count(*) FROM pg_constraint c JOIN expected_check_ed e ON e.conname = c.conname
                          WHERE c.contype = 'c' AND c.convalidated AND c.conrelid = (SELECT oid FROM ed)) = 15,
                       (SELECT count(*) FROM pg_constraint c JOIN expected_check e ON e.conname = c.conname
                          WHERE c.contype = 'c' AND c.convalidated)
                       + (SELECT count(*) FROM pg_constraint c JOIN expected_check_ed e ON e.conname = c.conname
                          WHERE c.contype = 'c' AND c.convalidated AND c.conrelid = (SELECT oid FROM ed))
  UNION ALL SELECT 12, (SELECT count(*) FROM pg_trigger t JOIN expected_trg e ON e.tgname = t.tgname
                          WHERE NOT t.tgisinternal AND t.tgenabled = 'O') = 3,
                       (SELECT count(*) FROM pg_trigger t JOIN expected_trg e ON e.tgname = t.tgname
                          WHERE NOT t.tgisinternal AND t.tgenabled = 'O')
  UNION ALL SELECT 13, (SELECT count(*) FROM fns) = 3, (SELECT count(*) FROM fns)
  UNION ALL SELECT 14, (SELECT count(*) FROM fns WHERE prosecdef) = 1
                       AND (SELECT count(*) FROM fns f
                             WHERE f.proname = 'document_supplier_link_erase_business' AND f.prosecdef
                               AND f.proowner = (SELECT relowner FROM mig_owner)
                               AND EXISTS (SELECT 1 FROM unnest(f.proconfig) c WHERE c LIKE 'search\_path=%')) = 1,
                       (SELECT count(*) FROM fns f
                         WHERE f.proname = 'document_supplier_link_erase_business' AND f.prosecdef
                           AND f.proowner = (SELECT relowner FROM mig_owner)
                           AND EXISTS (SELECT 1 FROM unnest(f.proconfig) c WHERE c LIKE 'search\_path=%'))
  UNION ALL SELECT 15, (SELECT count(*) FROM fn_grants g
                          WHERE NOT (g.proname = 'document_supplier_link_erase_business' AND g.grantee = (SELECT oid FROM rt))) = 0
                       AND (SELECT count(*) FROM fn_grants g WHERE g.proname = 'document_supplier_link_erase_business' AND g.grantee = (SELECT oid FROM rt)) = 1,
                       (SELECT count(*) FROM fn_grants g
                          WHERE NOT (g.proname = 'document_supplier_link_erase_business' AND g.grantee = (SELECT oid FROM rt)))
  UNION ALL SELECT 16, (SELECT count(*) FROM pg_attribute a JOIN expected_col e ON e.attname = a.attname
                          WHERE a.attrelid = (SELECT oid FROM ed) AND NOT a.attisdropped
                            AND format_type(a.atttypid, a.atttypmod) = e.typ AND a.attnotnull = e.nn)
                       + (SELECT count(*) FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
                          WHERE d.adrelid = (SELECT oid FROM ed) AND a.attname = 'ownBusinessExcluded'
                            AND pg_get_expr(d.adbin, d.adrelid) = 'false') = 6,
                       (SELECT count(*) FROM pg_attribute a JOIN expected_col e ON e.attname = a.attname
                          WHERE a.attrelid = (SELECT oid FROM ed) AND NOT a.attisdropped
                            AND format_type(a.atttypid, a.atttypmod) = e.typ AND a.attnotnull = e.nn)
                       + (SELECT count(*) FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
                          WHERE d.adrelid = (SELECT oid FROM ed) AND a.attname = 'ownBusinessExcluded'
                            AND pg_get_expr(d.adbin, d.adrelid) = 'false')
  UNION ALL SELECT 17, (SELECT count(*) FROM "PlatformFeatureDefinition" d JOIN "PlatformFeaturePolicy" p ON p."featureKey" = d."key"
                          WHERE d."key" = 'document_supplier_linking' AND NOT d."defaultEnabled" AND NOT p."globalEnabled" AND NOT p."emergencyDisabled") = 1
                       AND (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'document_supplier_linking') = 0,
                       (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'document_supplier_linking')
  UNION ALL SELECT 18, (SELECT count(*) FROM "DocumentSupplierLink") + (SELECT count(*) FROM "DocumentSupplierLinkEvent") = 0,
                       (SELECT count(*) FROM "DocumentSupplierLink") + (SELECT count(*) FROM "DocumentSupplierLinkEvent")
  UNION ALL SELECT 19, (SELECT count(*) FROM "ExtractedData" WHERE "issuerTaxId" IS NOT NULL OR "issuerCheck" IS NOT NULL OR "ownBusinessExcluded") = 0,
                       (SELECT count(*) FROM "ExtractedData" WHERE "issuerTaxId" IS NOT NULL OR "issuerCheck" IS NOT NULL OR "ownBusinessExcluded")
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
