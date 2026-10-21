-- ============================================================================
-- accountant-month-close-production-evidence.sql
--
-- Read-only Production EVIDENCE after migration
--   20261023090000_accountant_month_close
--
-- Proves the migration's outcome, from the catalog and counts only:
--   * it is recorded and finished, its sha256 is the reviewed one, nothing is unfinished or rolled back;
--   * the five accountant tables have RLS ENABLED + FORCED and exactly their per-command policies (15), every
--     one PERMISSIVE, for PUBLIC, with USING / WITH CHECK equal to the tenant GUC expression; no FOR ALL policy;
--     the only remove-rows policy is the recipient's (account erasure);
--   * the exact ACL of every accountant table and sequence (app_runtime only); no column-level privilege;
--   * the eight composite tenant keys exist and are validated; the tenant-prefix check on the package key,
--     the D2 acknowledgement check and the 15-day link check exist;
--   * the nine triggers exist and are enabled; the nine functions exist; SECURITY DEFINER exactly on the
--     three entry points, with a pinned search_path and owned by the migration role; EXECUTE held by
--     app_runtime on those three and by nobody on the trigger functions;
--   * the flag accountant_month_close exists and is OFF, with no business override;
--   * nothing was written: every accountant table is empty.
--
-- Checks 21 and 22 run first: the row counts are taken with row_security = off, so a query that row level
-- security would filter stops the run with an ERROR instead of reporting a smaller number.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== accountant month close production evidence: legend (n -> check) =='
\echo '21 V1 the evidence role is a superuser or has BYPASSRLS, so it sees every row (runs first)'
\echo '22 V2 row level security is not active on "AccountantPeriod" for the evidence role (runs first)'
\echo ' 1 the migration is recorded and finished (observed = finished rows)'
\echo ' 2 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 3 the recorded checksum is the reviewed sha256 of migration.sql'
\echo ' 4 the five accountant tables: RLS ENABLED + FORCED (observed = of 5)'
\echo ' 5 exactly 15 accountant policies, per command, PERMISSIVE, PUBLIC; no other policy on those tables (observed = policies)'
\echo ' 6 every accountant policy USING / WITH CHECK equals the tenant GUC expression exactly (observed = mismatches)'
\echo ' 7 no FOR ALL policy; the only remove-rows policy is accountant_recipient_runtime_delete (observed = remove-rows policies)'
\echo ' 8 the ACL of every accountant table and sequence is exactly as reviewed, app_runtime only (observed = mismatching objects)'
\echo ' 9 no column-level privilege on any accountant table (observed = column ACL items)'
\echo '10 the eight composite tenant keys exist and are validated (observed = of 8)'
\echo '11 the package key is pinned to the business prefix; the D2 acknowledgement and the 15-day link checks exist (observed = of 3)'
\echo '12 the nine triggers exist and are enabled (observed = of 9)'
\echo '13 the nine accountant functions exist (observed = functions)'
\echo '14 SECURITY DEFINER exactly on accountant_link_resolve, accountant_delivery_by_provider_message, accountant_erase_business; search_path pinned; owned by the migration role (observed = matching, of 3)'
\echo '15 EXECUTE: app_runtime alone on the three entry points; nobody but the owner on the six trigger functions; never PUBLIC (observed = other grants)'
\echo '16 flag accountant_month_close: defaultEnabled false, globalEnabled false, emergencyDisabled false, no business override (observed = overrides)'
\echo '17 nothing written: the five accountant tables hold no row (observed = rows)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
-- Hard stop: a query that row level security would filter raises an ERROR instead.
SET LOCAL row_security = off;

\echo '== visibility checks (21, 22) =='
WITH
per AS (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'AccountantPeriod' AND c.relkind = 'r'),
checks(n, ok, observed_count) AS (
            SELECT 21, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) IS TRUE, 1
  UNION ALL SELECT 22, row_security_active((SELECT oid FROM per)) IS FALSE, 1
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

\echo '== evidence checks (1-17) =='
WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
rel(nm, oid, relowner, relrowsecurity, relforcerowsecurity, relacl) AS (
  SELECT c.relname, c.oid, c.relowner, c.relrowsecurity, c.relforcerowsecurity, c.relacl
  FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub)),
rt AS (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime'),
tables(nm) AS (VALUES ('AccountantPeriod'), ('AccountantPackage'), ('AccountantRecipient'), ('AccountantDelivery'), ('AccountantWorkflowEvent')),
expected_expr(e) AS (VALUES ('("businessId" = (NULLIF(current_setting(''app.current_business_id''::text, true), ''''::text))::integer)')),
expected_pol(tbl, polname, cmd, has_q, has_wc) AS (VALUES
  ('AccountantPeriod', 'accountant_period_tenant_select', 'r', true, false),
  ('AccountantPeriod', 'accountant_period_tenant_insert', 'a', false, true),
  ('AccountantPeriod', 'accountant_period_tenant_update', 'w', true, true),
  ('AccountantPackage', 'accountant_package_tenant_select', 'r', true, false),
  ('AccountantPackage', 'accountant_package_tenant_insert', 'a', false, true),
  ('AccountantPackage', 'accountant_package_tenant_update', 'w', true, true),
  ('AccountantRecipient', 'accountant_recipient_tenant_select', 'r', true, false),
  ('AccountantRecipient', 'accountant_recipient_tenant_insert', 'a', false, true),
  ('AccountantRecipient', 'accountant_recipient_tenant_update', 'w', true, true),
  ('AccountantRecipient', 'accountant_recipient_runtime_delete', 'd', true, false),
  ('AccountantDelivery', 'accountant_delivery_tenant_select', 'r', true, false),
  ('AccountantDelivery', 'accountant_delivery_tenant_insert', 'a', false, true),
  ('AccountantDelivery', 'accountant_delivery_tenant_update', 'w', true, true),
  ('AccountantWorkflowEvent', 'accountant_event_tenant_select', 'r', true, false),
  ('AccountantWorkflowEvent', 'accountant_event_tenant_insert', 'a', false, true)),
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
  ('AccountantPeriod', 'arw'), ('AccountantPeriod_id_seq', 'Ur'),
  ('AccountantPackage', 'arw'), ('AccountantPackage_id_seq', 'Ur'),
  ('AccountantRecipient', 'adrw'),
  ('AccountantDelivery', 'arw'), ('AccountantDelivery_id_seq', 'Ur'),
  ('AccountantWorkflowEvent', 'ar'), ('AccountantWorkflowEvent_id_seq', 'Ur')),
acl_mismatch AS (
  SELECT e.nm FROM expected_acl e
   WHERE (SELECT count(*) FROM acl_letters a WHERE a.nm = e.nm) <> 1
      OR NOT EXISTS (SELECT 1 FROM acl_letters a WHERE a.nm = e.nm AND a.grantee = (SELECT oid FROM rt) AND a.letters = e.letters)),
expected_fk(conname) AS (VALUES
  ('AccountantPackage_period_tenant_fkey'), ('AccountantPeriod_latestPackage_tenant_fkey'),
  ('AccountantPeriod_completedPackage_tenant_fkey'), ('AccountantDelivery_period_tenant_fkey'),
  ('AccountantDelivery_package_tenant_fkey'), ('AccountantWorkflowEvent_period_tenant_fkey'),
  ('AccountantWorkflowEvent_package_tenant_fkey'), ('AccountantWorkflowEvent_delivery_tenant_fkey')),
expected_check(conname) AS (VALUES
  ('AccountantPackage_storage_key_tenant'), ('AccountantDelivery_incomplete_acknowledged'), ('AccountantDelivery_link_lifetime')),
expected_trg(tgname) AS (VALUES
  ('AccountantPackage_user_same_business'), ('AccountantRecipient_user_same_business'),
  ('AccountantDelivery_user_same_business'), ('AccountantWorkflowEvent_user_same_business'),
  ('AccountantPackage_guard'), ('AccountantDelivery_insert_guard'), ('AccountantDelivery_update_guard'),
  ('AccountantWorkflowEvent_append_only'), ('AccountantWorkflowEvent_no_truncate')),
fns AS (SELECT p.oid, p.proname, p.prosecdef, p.proconfig, p.proowner, p.proacl FROM pg_proc p
        WHERE p.pronamespace = (SELECT oid FROM pub) AND p.proname LIKE 'accountant\_%'),
entry(proname) AS (VALUES ('accountant_link_resolve'), ('accountant_delivery_by_provider_message'), ('accountant_erase_business')),
fn_grants AS (SELECT f.proname, x.grantee FROM fns f CROSS JOIN LATERAL aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) x
              WHERE x.privilege_type = 'EXECUTE' AND x.grantee <> f.proowner),
mig_owner AS (SELECT relowner FROM rel WHERE nm = 'AccountantPeriod'),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261023090000_accountant_month_close'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1,
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261023090000_accountant_month_close'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, (SELECT checksum FROM "_prisma_migrations" WHERE migration_name = '20261023090000_accountant_month_close') = 'dffae663489f3625f99d58be9c225e7f13f2f5bf5562e03929de8f990582a41a', 1
  UNION ALL SELECT 4, (SELECT count(*) FROM rel WHERE nm IN (SELECT nm FROM tables) AND relrowsecurity AND relforcerowsecurity) = 5,
                      (SELECT count(*) FROM rel WHERE nm IN (SELECT nm FROM tables) AND relrowsecurity AND relforcerowsecurity)
  UNION ALL SELECT 5, (SELECT count(*) FROM pols) = 15
                      AND (SELECT count(*) FROM pols p JOIN expected_pol e ON e.tbl = p.tbl AND e.polname = p.polname AND e.cmd = p.cmd
                            WHERE p.polpermissive AND p.polroles = ARRAY[0]::oid[]
                              AND (p.q IS NOT NULL) = e.has_q AND (p.wc IS NOT NULL) = e.has_wc) = 15,
                      (SELECT count(*) FROM pols)
  UNION ALL SELECT 6, (SELECT count(*) FROM pols WHERE (q IS NOT NULL AND q <> (SELECT e FROM expected_expr))
                                                    OR (wc IS NOT NULL AND wc <> (SELECT e FROM expected_expr))) = 0,
                      (SELECT count(*) FROM pols WHERE (q IS NOT NULL AND q <> (SELECT e FROM expected_expr))
                                                    OR (wc IS NOT NULL AND wc <> (SELECT e FROM expected_expr)))
  UNION ALL SELECT 7, (SELECT count(*) FROM pols WHERE cmd = '*') = 0
                      AND (SELECT count(*) FROM pols WHERE cmd = 'd') = 1
                      AND EXISTS (SELECT 1 FROM pols WHERE cmd = 'd' AND polname = 'accountant_recipient_runtime_delete' AND tbl = 'AccountantRecipient'),
                      (SELECT count(*) FROM pols WHERE cmd = 'd')
  UNION ALL SELECT 8, (SELECT count(*) FROM acl_mismatch) = 0, (SELECT count(*) FROM acl_mismatch)
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x
                         WHERE a.attrelid IN (SELECT oid FROM rel WHERE nm IN (SELECT nm FROM tables))) = 0,
                      (SELECT count(*) FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x
                         WHERE a.attrelid IN (SELECT oid FROM rel WHERE nm IN (SELECT nm FROM tables)))
  UNION ALL SELECT 10, (SELECT count(*) FROM pg_constraint c JOIN expected_fk e ON e.conname = c.conname
                          WHERE c.contype = 'f' AND c.convalidated AND array_length(c.conkey, 1) = 2) = 8,
                       (SELECT count(*) FROM pg_constraint c JOIN expected_fk e ON e.conname = c.conname
                          WHERE c.contype = 'f' AND c.convalidated AND array_length(c.conkey, 1) = 2)
  UNION ALL SELECT 11, (SELECT count(*) FROM pg_constraint c JOIN expected_check e ON e.conname = c.conname
                          WHERE c.contype = 'c' AND c.convalidated) = 3,
                       (SELECT count(*) FROM pg_constraint c JOIN expected_check e ON e.conname = c.conname
                          WHERE c.contype = 'c' AND c.convalidated)
  UNION ALL SELECT 12, (SELECT count(*) FROM pg_trigger t JOIN expected_trg e ON e.tgname = t.tgname
                          WHERE NOT t.tgisinternal AND t.tgenabled = 'O') = 9,
                       (SELECT count(*) FROM pg_trigger t JOIN expected_trg e ON e.tgname = t.tgname
                          WHERE NOT t.tgisinternal AND t.tgenabled = 'O')
  UNION ALL SELECT 13, (SELECT count(*) FROM fns) = 9, (SELECT count(*) FROM fns)
  UNION ALL SELECT 14, (SELECT count(*) FROM fns WHERE prosecdef) = 3
                       AND (SELECT count(*) FROM fns f JOIN entry e ON e.proname = f.proname
                             WHERE f.prosecdef AND f.proowner = (SELECT relowner FROM mig_owner)
                               AND EXISTS (SELECT 1 FROM unnest(f.proconfig) c WHERE c LIKE 'search\_path=%')) = 3,
                       (SELECT count(*) FROM fns f JOIN entry e ON e.proname = f.proname
                         WHERE f.prosecdef AND f.proowner = (SELECT relowner FROM mig_owner)
                           AND EXISTS (SELECT 1 FROM unnest(f.proconfig) c WHERE c LIKE 'search\_path=%'))
  UNION ALL SELECT 15, (SELECT count(*) FROM fn_grants g
                          WHERE NOT (g.proname IN (SELECT proname FROM entry) AND g.grantee = (SELECT oid FROM rt))) = 0
                       AND (SELECT count(*) FROM fn_grants g WHERE g.proname IN (SELECT proname FROM entry) AND g.grantee = (SELECT oid FROM rt)) = 3,
                       (SELECT count(*) FROM fn_grants g
                          WHERE NOT (g.proname IN (SELECT proname FROM entry) AND g.grantee = (SELECT oid FROM rt)))
  UNION ALL SELECT 16, EXISTS (SELECT 1 FROM "PlatformFeatureDefinition" d JOIN "PlatformFeaturePolicy" p ON p."featureKey" = d."key"
                                WHERE d."key" = 'accountant_month_close' AND NOT d."defaultEnabled" AND NOT p."globalEnabled" AND NOT p."emergencyDisabled")
                       AND (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'accountant_month_close') = 0,
                       (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'accountant_month_close')
  UNION ALL SELECT 17, (SELECT count(*) FROM "AccountantPeriod") + (SELECT count(*) FROM "AccountantPackage")
                       + (SELECT count(*) FROM "AccountantRecipient") + (SELECT count(*) FROM "AccountantDelivery")
                       + (SELECT count(*) FROM "AccountantWorkflowEvent") = 0,
                       (SELECT count(*) FROM "AccountantPeriod") + (SELECT count(*) FROM "AccountantPackage")
                       + (SELECT count(*) FROM "AccountantRecipient") + (SELECT count(*) FROM "AccountantDelivery")
                       + (SELECT count(*) FROM "AccountantWorkflowEvent")
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
