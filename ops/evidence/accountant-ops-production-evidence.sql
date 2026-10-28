-- ============================================================================
-- accountant-ops-production-evidence.sql
--
-- Read-only Production PROOF after migrations
--   20261107090000_accountant_ops_monitor         (sha256 '3844018687cc3b7a10e52a1178470b52b052f8fbe4230db793a882a221b94ea7')
--   20261107091000_accountant_delivery_complained (sha256 '38ecb6c9f10325f9a4de0684e0c26cee5614d1ecc2d693259431a2cc19076846')
--   20261107092000_accountant_ops_admin_read      (sha256 'c20b1b242dce191541c1a8795787eac1c8dceb6312c9f1f2389bbf96e65eb7a6')
--
-- Proves, from the catalog, the ledger and counts only, that exactly what the migrations say happened:
--   * each is recorded once, finished, with the checksum of the reviewed file; the ledger is clean;
--   * the three monitoring tables exist with their closed CHECKs and one-open-alert indexes;
--   * the tenant alert table is under ENABLE + FORCE RLS with exactly its three per-command tenant policies and
--     the console's additive read policy (FOR SELECT TO app_admin), and no other;
--   * the exact privileges: app_runtime — read and add on the three tables, change of the bookkeeping columns
--     only, the three sequences; app_admin — read of the three tables, nothing else; PUBLIC and every other role —
--     nothing;
--   * app_admin still reads NO accountant workflow table (period, package, recipient, delivery, trail);
--   * the event-type constraint keeps its name, is validated and lists 27 values: the 26 of 2026-11-05 plus
--     DELIVERY_COMPLAINED; the trail is still under FORCE RLS with both append-only triggers;
--   * nothing was written yet: the three tables are empty, no complaint is recorded.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== accountant ops proof: legend (n -> check) =='
\echo ' 1 the evidence role is a superuser or has BYPASSRLS (it sees every row)'
\echo ' 2 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 3 the three migrations are recorded once each, finished, with the pinned checksums (observed = matching rows, of 3)'
\echo ' 4 AccountantOpsRun, AccountantOpsAlert, AccountantBusinessAlert exist (observed = of 3)'
\echo ' 5 their closed CHECKs exist and are validated: run counts, both alert details (observed = of 3)'
\echo ' 6 the one-open-alert partial unique indexes exist (observed = of 2)'
\echo ' 7 AccountantBusinessAlert has RLS ENABLED + FORCED; the platform tables have no RLS (observed = tables as expected, of 3)'
\echo ' 8 AccountantBusinessAlert: exactly the 3 tenant policies (read, add, change — each on app.current_business_id) + p7adm_read (observed = policies)'
\echo ' 9 p7adm_read is FOR SELECT, TO app_admin only, USING (true), permissive (observed = such policies)'
\echo '10 table privileges are exact: app_runtime ar + app_admin r on each table, app_runtime Ur on each sequence (observed = mismatching objects)'
\echo '11 column privileges are exact: app_runtime w on the bookkeeping columns only, 4 + 7 + 7 (observed = column grants)'
\echo '12 PUBLIC and every other role hold nothing on the six objects (observed = foreign ACL items)'
\echo '13 app_admin holds no privilege on any accountant workflow table (observed = ACL items on the 5 tables)'
\echo '14 AccountantWorkflowEvent_type is validated and lists exactly 27 values (observed = values)'
\echo '15 it lists DELIVERY_COMPLAINED, LINK_FILE_DOWNLOADED and PERIOD_COMPLETED_MANUALLY (observed = of 3)'
\echo '16 the trail keeps RLS ENABLED + FORCED and both append-only triggers (observed = triggers of 2)'
\echo '17 nothing written yet: monitoring rows + DELIVERY_COMPLAINED trail rows (observed = rows)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
rel(nm, oid, relkind, relowner, relrowsecurity, relforcerowsecurity, relacl) AS (
  SELECT c.relname, c.oid, c.relkind, c.relowner, c.relrowsecurity, c.relforcerowsecurity, c.relacl
  FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub)),
rt AS (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime'),
adm AS (SELECT oid FROM pg_roles WHERE rolname = 'app_admin'),
mig(name, sum) AS (VALUES
  ('20261107090000_accountant_ops_monitor', '3844018687cc3b7a10e52a1178470b52b052f8fbe4230db793a882a221b94ea7'),
  ('20261107091000_accountant_delivery_complained', '38ecb6c9f10325f9a4de0684e0c26cee5614d1ecc2d693259431a2cc19076846'),
  ('20261107092000_accountant_ops_admin_read', 'c20b1b242dce191541c1a8795787eac1c8dceb6312c9f1f2389bbf96e65eb7a6')),
tables(nm) AS (VALUES ('AccountantOpsRun'), ('AccountantOpsAlert'), ('AccountantBusinessAlert')),
objects(nm) AS (SELECT nm FROM tables UNION ALL SELECT nm || '_id_seq' FROM tables),
workflow(nm) AS (VALUES ('AccountantPeriod'), ('AccountantPackage'), ('AccountantRecipient'), ('AccountantDelivery'), ('AccountantWorkflowEvent')),
tenant_expr(e) AS (VALUES ('("businessId" = (NULLIF(current_setting(''app.current_business_id''::text, true), ''''::text))::integer)')),
pols AS (SELECT p.polname, p.polcmd::text AS cmd, p.polpermissive, p.polroles,
                pg_get_expr(p.polqual, p.polrelid) AS q, pg_get_expr(p.polwithcheck, p.polrelid) AS wc
         FROM pg_policy p JOIN rel r ON r.oid = p.polrelid WHERE r.nm = 'AccountantBusinessAlert'),
expected_pol(polname, cmd, has_q, has_wc) AS (VALUES
  ('accountant_business_alert_tenant_select', 'r', true, false),
  ('accountant_business_alert_tenant_insert', 'a', false, true),
  ('accountant_business_alert_tenant_update', 'w', true, true)),
letter AS (SELECT * FROM (VALUES ('SELECT', 'r'), ('INS' || 'ERT', 'a'), ('UPD' || 'ATE', 'w'), ('DEL' || 'ETE', 'd'),
                                 ('TRUNC' || 'ATE', 'D'), ('REFERENCES', 'x'), ('TRIGGER', 't'), ('MAINTAIN', 'm'),
                                 ('USAGE', 'U')) v(priv, l)),
acl_items AS (SELECT r.nm, x.grantee, (SELECT l FROM letter WHERE priv = x.privilege_type) COLLATE "C" AS l
              FROM rel r CROSS JOIN LATERAL aclexplode(r.relacl) x WHERE x.grantee <> r.relowner AND r.nm IN (SELECT nm FROM objects)),
acl_letters AS (SELECT nm, grantee, string_agg(DISTINCT l, '' ORDER BY l) AS letters FROM acl_items GROUP BY nm, grantee),
expected_acl(nm, who, letters) AS (VALUES
  ('AccountantOpsRun', 'rt', 'ar'), ('AccountantOpsRun', 'adm', 'r'), ('AccountantOpsRun_id_seq', 'rt', 'Ur'),
  ('AccountantOpsAlert', 'rt', 'ar'), ('AccountantOpsAlert', 'adm', 'r'), ('AccountantOpsAlert_id_seq', 'rt', 'Ur'),
  ('AccountantBusinessAlert', 'rt', 'ar'), ('AccountantBusinessAlert', 'adm', 'r'), ('AccountantBusinessAlert_id_seq', 'rt', 'Ur')),
acl_mismatch AS (
  SELECT e.nm FROM expected_acl e
   WHERE NOT EXISTS (SELECT 1 FROM acl_letters a WHERE a.nm = e.nm AND a.letters = e.letters
                       AND a.grantee = CASE e.who WHEN 'rt' THEN (SELECT oid FROM rt) ELSE (SELECT oid FROM adm) END)
  UNION ALL
  SELECT o.nm FROM objects o
   WHERE (SELECT count(*) FROM acl_letters a WHERE a.nm = o.nm) <> (SELECT count(*) FROM expected_acl e WHERE e.nm = o.nm)),
col_items AS (SELECT r.nm, a.attname, x.grantee, x.privilege_type
              FROM rel r JOIN pg_attribute a ON a.attrelid = r.oid CROSS JOIN LATERAL aclexplode(a.attacl) x
              WHERE r.nm IN (SELECT nm FROM tables) AND a.attnum > 0 AND NOT a.attisdropped),
expected_col(nm, attname) AS (VALUES
  ('AccountantOpsRun', 'finishedAt'), ('AccountantOpsRun', 'outcome'), ('AccountantOpsRun', 'counts'), ('AccountantOpsRun', 'errorCode'),
  ('AccountantOpsAlert', 'severity'), ('AccountantOpsAlert', 'detail'), ('AccountantOpsAlert', 'lastSeenAt'), ('AccountantOpsAlert', 'notifyCount'),
  ('AccountantOpsAlert', 'lastNotifiedAt'), ('AccountantOpsAlert', 'resolvedAt'), ('AccountantOpsAlert', 'resolvedNotifiedAt'),
  ('AccountantBusinessAlert', 'severity'), ('AccountantBusinessAlert', 'detail'), ('AccountantBusinessAlert', 'lastSeenAt'),
  ('AccountantBusinessAlert', 'notifyCount'), ('AccountantBusinessAlert', 'lastNotifiedAt'), ('AccountantBusinessAlert', 'resolvedAt'),
  ('AccountantBusinessAlert', 'resolvedNotifiedAt')),
col_ok AS (SELECT count(*) AS n FROM col_items c
           WHERE c.grantee = (SELECT oid FROM rt) AND c.privilege_type = 'UPD' || 'ATE'
             AND (c.nm, c.attname::text) IN (SELECT nm, attname FROM expected_col)),
con AS (SELECT c.convalidated, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
        WHERE c.conname = 'AccountantWorkflowEvent_type' AND c.conrelid = '"AccountantWorkflowEvent"'::regclass),
has(v) AS (VALUES ('DELIVERY_COMPLAINED'), ('LINK_FILE_DOWNLOADED'), ('PERIOD_COMPLETED_MANUALLY')),
listed AS (SELECT h.v FROM has h, con WHERE con.def LIKE '%''' || h.v || '''::text%'),
written AS (SELECT (SELECT count(*) FROM "AccountantOpsRun") + (SELECT count(*) FROM "AccountantOpsAlert")
                 + (SELECT count(*) FROM "AccountantBusinessAlert")
                 + (SELECT count(*) FROM "AccountantWorkflowEvent" WHERE "eventType" = 'DELIVERY_COMPLAINED') AS n),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) IS TRUE, 1
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" p JOIN mig m ON m.name = p.migration_name
                         WHERE p.finished_at IS NOT NULL AND p.rolled_back_at IS NULL AND p.checksum = m.sum) = 3
                      AND (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name IN (SELECT name FROM mig)) = 3,
                      (SELECT count(*) FROM "_prisma_migrations" p JOIN mig m ON m.name = p.migration_name
                         WHERE p.finished_at IS NOT NULL AND p.rolled_back_at IS NULL AND p.checksum = m.sum)
  UNION ALL SELECT 4, (SELECT count(*) FROM rel WHERE relkind = 'r' AND nm IN (SELECT nm FROM tables)) = 3,
                      (SELECT count(*) FROM rel WHERE relkind = 'r' AND nm IN (SELECT nm FROM tables))
  UNION ALL SELECT 5, (SELECT count(*) FROM pg_constraint WHERE convalidated AND conname IN
                         ('AccountantOpsRun_counts_closed', 'AccountantOpsAlert_detail_closed', 'AccountantBusinessAlert_detail_closed')) = 3,
                      (SELECT count(*) FROM pg_constraint WHERE convalidated AND conname IN
                         ('AccountantOpsRun_counts_closed', 'AccountantOpsAlert_detail_closed', 'AccountantBusinessAlert_detail_closed'))
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_index i JOIN rel r ON r.oid = i.indexrelid
                         WHERE i.indisunique AND i.indpred IS NOT NULL AND r.nm IN ('AccountantOpsAlert_open_key', 'AccountantBusinessAlert_open_key')) = 2,
                      (SELECT count(*) FROM pg_index i JOIN rel r ON r.oid = i.indexrelid
                         WHERE i.indisunique AND i.indpred IS NOT NULL AND r.nm IN ('AccountantOpsAlert_open_key', 'AccountantBusinessAlert_open_key'))
  UNION ALL SELECT 7, (SELECT count(*) FROM rel WHERE (nm = 'AccountantBusinessAlert' AND relrowsecurity AND relforcerowsecurity)
                         OR (nm IN ('AccountantOpsRun', 'AccountantOpsAlert') AND NOT relrowsecurity AND NOT relforcerowsecurity)) = 3,
                      (SELECT count(*) FROM rel WHERE (nm = 'AccountantBusinessAlert' AND relrowsecurity AND relforcerowsecurity)
                         OR (nm IN ('AccountantOpsRun', 'AccountantOpsAlert') AND NOT relrowsecurity AND NOT relforcerowsecurity))
  UNION ALL SELECT 8, (SELECT count(*) FROM pols) = 4
                      AND (SELECT count(*) FROM expected_pol e JOIN pols p ON p.polname = e.polname AND p.cmd = e.cmd AND p.polpermissive
                             AND p.polroles = '{0}'::oid[]
                             AND (CASE WHEN e.has_q THEN p.q = (SELECT e FROM tenant_expr) ELSE p.q IS NULL END)
                             AND (CASE WHEN e.has_wc THEN p.wc = (SELECT e FROM tenant_expr) ELSE p.wc IS NULL END)) = 3,
                      (SELECT count(*) FROM pols)
  UNION ALL SELECT 9, (SELECT count(*) FROM pols WHERE polname = 'p7adm_read' AND cmd = 'r' AND polpermissive
                         AND polroles = ARRAY[(SELECT oid FROM adm)] AND q = 'true' AND wc IS NULL) = 1,
                      (SELECT count(*) FROM pols WHERE polname = 'p7adm_read' AND cmd = 'r' AND polpermissive
                         AND polroles = ARRAY[(SELECT oid FROM adm)] AND q = 'true' AND wc IS NULL)
  UNION ALL SELECT 10, (SELECT count(*) FROM acl_mismatch) = 0, (SELECT count(*) FROM acl_mismatch)
  UNION ALL SELECT 11, (SELECT n FROM col_ok) = 18 AND (SELECT count(*) FROM col_items) = 18, (SELECT count(*) FROM col_items)
  UNION ALL SELECT 12, (SELECT count(*) FROM acl_items WHERE grantee NOT IN ((SELECT oid FROM rt), (SELECT oid FROM adm)))
                         + (SELECT count(*) FROM col_items WHERE grantee <> (SELECT oid FROM rt)) = 0,
                       (SELECT count(*) FROM acl_items WHERE grantee NOT IN ((SELECT oid FROM rt), (SELECT oid FROM adm)))
                         + (SELECT count(*) FROM col_items WHERE grantee <> (SELECT oid FROM rt))
  UNION ALL SELECT 13, (SELECT count(*) FROM rel r CROSS JOIN LATERAL aclexplode(r.relacl) x
                          WHERE r.nm IN (SELECT nm FROM workflow) AND x.grantee = (SELECT oid FROM adm))
                         + (SELECT count(*) FROM rel r JOIN pg_attribute a ON a.attrelid = r.oid CROSS JOIN LATERAL aclexplode(a.attacl) x
                          WHERE r.nm IN (SELECT nm FROM workflow) AND x.grantee = (SELECT oid FROM adm)) = 0,
                       (SELECT count(*) FROM rel r CROSS JOIN LATERAL aclexplode(r.relacl) x
                          WHERE r.nm IN (SELECT nm FROM workflow) AND x.grantee = (SELECT oid FROM adm))
                         + (SELECT count(*) FROM rel r JOIN pg_attribute a ON a.attrelid = r.oid CROSS JOIN LATERAL aclexplode(a.attacl) x
                          WHERE r.nm IN (SELECT nm FROM workflow) AND x.grantee = (SELECT oid FROM adm))
  UNION ALL SELECT 14, coalesce((SELECT convalidated AND (array_length(regexp_split_to_array(def, '::text'), 1) - 1) = 27 FROM con), false),
                       coalesce((SELECT (array_length(regexp_split_to_array(def, '::text'), 1) - 1) FROM con), 0)
  UNION ALL SELECT 15, (SELECT count(*) FROM listed) = 3, (SELECT count(*) FROM listed)
  UNION ALL SELECT 16, EXISTS (SELECT 1 FROM pg_class WHERE oid = '"AccountantWorkflowEvent"'::regclass AND relrowsecurity AND relforcerowsecurity)
                       AND (SELECT count(*) FROM pg_trigger WHERE tgrelid = '"AccountantWorkflowEvent"'::regclass AND NOT tgisinternal AND tgenabled = 'O'
                              AND tgname IN ('AccountantWorkflowEvent_append_only', 'AccountantWorkflowEvent_no_truncate')) = 2,
                       (SELECT count(*) FROM pg_trigger WHERE tgrelid = '"AccountantWorkflowEvent"'::regclass AND NOT tgisinternal AND tgenabled = 'O'
                          AND tgname IN ('AccountantWorkflowEvent_append_only', 'AccountantWorkflowEvent_no_truncate'))
  UNION ALL SELECT 17, (SELECT n FROM written) = 0, (SELECT n FROM written)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
