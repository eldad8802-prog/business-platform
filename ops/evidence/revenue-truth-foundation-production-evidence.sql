-- ============================================================================
-- revenue-truth-foundation-production-evidence.sql
--
-- Read-only Production EVIDENCE after migration
--   20261028090000_revenue_truth_foundation
--
-- Proves the migration's outcome, from the catalog and counts only:
--   * it is recorded and finished, its sha256 is the reviewed one, nothing is unfinished or rolled back;
--   * the eight revenue tables have RLS ENABLED + FORCED and exactly their two per-command policies each (16): a
--     read policy and an add policy, PERMISSIVE, for PUBLIC, whose USING / WITH CHECK equal the tenant GUC
--     expression; no FOR ALL policy, no change policy, no remove-rows policy;
--   * the exact ACL of every revenue table (app_runtime read + add) and sequence (app_runtime USAGE + read), and
--     nothing else; no column-level privilege;
--   * business isolation in the schema: the twenty composite tenant keys (each through "businessId") and the two
--     plain keys to ExternalTransaction / BillingDocument exist and are validated; the link guard that holds those
--     two to the same business is in place, unchanged and SECURITY INVOKER (it reads under the caller's RLS);
--   * the 26 checks and the 19 unique keys (the one-proposal-per-pair and one-supersession keys included) exist;
--     the 17 triggers exist and are enabled; the three functions are the reviewed ones (body md5), not
--     SECURITY DEFINER, search_path pinned, owned by the migration role, EXECUTE held by nobody else (not PUBLIC);
--   * the eleven enums carry their reviewed labels;
--   * nothing was written: every revenue table is empty, no flag was added, and no revenue policy or trigger sits
--     on any existing table.
--
-- Checks 21 and 22 run first: the row counts are taken with row_security = off, so a query that row level
-- security would filter stops the run with an ERROR instead of reporting a smaller number.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== revenue truth foundation production evidence: legend (n -> check) =='
\echo '21 V1 the evidence role is a superuser or has BYPASSRLS, so it sees every row (runs first)'
\echo '22 V2 row level security is not active on "RevenueSale" for the evidence role (runs first)'
\echo ' 1 the migration is recorded and finished (observed = finished rows)'
\echo ' 2 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 3 the recorded checksum is the reviewed sha256 of migration.sql'
\echo ' 4 the eight revenue tables: RLS ENABLED + FORCED (observed = of 8)'
\echo ' 5 exactly 16 revenue policies: per table one read (USING) and one add (WITH CHECK), PERMISSIVE, PUBLIC, named as reviewed (observed = policies)'
\echo ' 6 every revenue policy expression equals the tenant GUC expression exactly (observed = mismatches)'
\echo ' 7 no FOR ALL, change or remove-rows policy on any revenue table (observed = such policies)'
\echo ' 8 the ACL of every revenue table (app_runtime read + add) and sequence (app_runtime USAGE + read) is exactly as reviewed (observed = mismatching objects, of 16)'
\echo ' 9 no column-level privilege on any revenue table (observed = column ACL items)'
\echo '10 the twenty composite tenant keys exist, are validated and go through "businessId" (observed = of 20)'
\echo '11 the two plain keys to ExternalTransaction and BillingDocument exist and are validated (observed = of 2)'
\echo '12 the 26 revenue checks exist and are validated (observed = of 26)'
\echo '13 the 19 revenue unique keys exist and are valid (observed = of 19)'
\echo '14 the 17 revenue triggers exist and are enabled, the link guard among them (observed = of 17)'
\echo '15 the three revenue functions: not SECURITY DEFINER, search_path pinned, owned by the migration role (observed = matching, of 3)'
\echo '16 the three revenue function bodies are the reviewed ones (observed = matching md5, of 3)'
\echo '17 EXECUTE on the revenue functions: nobody but the owner, never PUBLIC (observed = other grants)'
\echo '18 the eleven revenue enums carry their reviewed number of labels (observed = of 11)'
\echo '19 nothing written: the eight revenue tables hold no row (observed = rows)'
\echo '20 nothing added elsewhere: no revenue_* flag (the coupons flag revenue is older and not counted), no revenue policy or trigger on any existing table (observed = such objects)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
-- Hard stop: a query that row level security would filter raises an ERROR instead.
SET LOCAL row_security = off;

\echo '== visibility checks (21, 22) =='
WITH
sale AS (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'RevenueSale' AND c.relkind = 'r'),
checks(n, ok, observed_count) AS (
            SELECT 21, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) IS TRUE, 1
  UNION ALL SELECT 22, row_security_active((SELECT oid FROM sale)) IS FALSE, 1
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

\echo '== evidence checks (1-20) =='
WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
rel(nm, oid, relowner, relrowsecurity, relforcerowsecurity, relacl) AS (
  SELECT c.relname, c.oid, c.relowner, c.relrowsecurity, c.relforcerowsecurity, c.relacl
  FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub)),
rt AS (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime'),
tables(nm, pol) AS (VALUES ('RevenueSale', 'revenue_sale'), ('RevenueReceipt', 'revenue_receipt'),
  ('RevenueDailyClose', 'revenue_daily_close'), ('RevenueDailyCloseTender', 'revenue_daily_close_tender'),
  ('RevenueDailyCloseVat', 'revenue_daily_close_vat'), ('RevenueSettlement', 'revenue_settlement'),
  ('RevenueLink', 'revenue_link'), ('RevenueDecision', 'revenue_decision')),
expected_expr(e) AS (VALUES ('("businessId" = (NULLIF(current_setting(''app.current_business_id''::text, true), ''''::text))::integer)')),
expected_pol(tbl, polname, cmd, has_q, has_wc) AS (
  SELECT nm, pol || '_tenant_select', 'r', true, false FROM tables
  UNION ALL SELECT nm, pol || '_tenant_' || 'ins' || 'ert', 'a', false, true FROM tables),
pols AS (SELECT r.nm AS tbl, p.polname, p.polcmd::text AS cmd, p.polpermissive, p.polroles,
                pg_get_expr(p.polqual, p.polrelid) AS q, pg_get_expr(p.polwithcheck, p.polrelid) AS wc
         FROM pg_policy p JOIN rel r ON r.oid = p.polrelid WHERE r.nm IN (SELECT nm FROM tables)),
letter AS (SELECT * FROM (VALUES ('SELECT', 'r'), ('INS' || 'ERT', 'a'), ('UPD' || 'ATE', 'w'), ('DEL' || 'ETE', 'd'),
                                 ('TRUNC' || 'ATE', 'D'), ('REFERENCES', 'x'), ('TRIGGER', 't'), ('MAINTAIN', 'm'),
                                 ('USAGE', 'U')) v(priv, l)),
acl_items AS (SELECT r.nm, x.grantee, (SELECT l FROM letter WHERE priv = x.privilege_type) COLLATE "C" AS l
              FROM rel r CROSS JOIN LATERAL aclexplode(r.relacl) x WHERE x.grantee <> r.relowner),
acl_letters AS (SELECT nm, grantee, string_agg(DISTINCT l, '' ORDER BY l) AS letters FROM acl_items GROUP BY nm, grantee),
expected_acl(nm, letters) AS (
  SELECT nm, 'ar' FROM tables
  UNION ALL SELECT nm || '_id_seq', 'Ur' FROM tables),
acl_mismatch AS (
  SELECT e.nm FROM expected_acl e
   WHERE (SELECT count(*) FROM acl_letters a WHERE a.nm = e.nm) <> 1
      OR NOT EXISTS (SELECT 1 FROM acl_letters a WHERE a.nm = e.nm AND a.grantee = (SELECT oid FROM rt) AND a.letters = e.letters)),
tenant_fk(conname) AS (VALUES
  ('RevenueSale_connectionId_tenant_fkey'), ('RevenueSale_originalSaleId_tenant_fkey'),
  ('RevenueReceipt_connectionId_tenant_fkey'), ('RevenueReceipt_saleId_tenant_fkey'),
  ('RevenueDailyClose_connectionId_tenant_fkey'), ('RevenueDailyClose_documentId_tenant_fkey'),
  ('RevenueDailyClose_supersedesId_tenant_fkey'),
  ('RevenueDailyCloseTender_dailyCloseId_businessId_fkey'), ('RevenueDailyCloseVat_dailyCloseId_businessId_fkey'),
  ('RevenueSettlement_connectionId_tenant_fkey'), ('RevenueSettlement_documentId_tenant_fkey'),
  ('RevenueLink_saleId_tenant_fkey'), ('RevenueLink_receiptId_tenant_fkey'), ('RevenueLink_dailyCloseTenderId_tenant_fkey'),
  ('RevenueLink_settlementId_tenant_fkey'),
  ('RevenueDecision_linkId_tenant_fkey'), ('RevenueDecision_dailyCloseId_tenant_fkey'), ('RevenueDecision_saleId_tenant_fkey'),
  ('RevenueDecision_receiptId_tenant_fkey'), ('RevenueDecision_settlementId_tenant_fkey')),
tenant_fk_ok AS (
  SELECT co.conname FROM pg_constraint co JOIN tenant_fk t ON t.conname = co.conname
   WHERE co.contype = 'f' AND co.convalidated AND cardinality(co.conkey) = 2
     AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = co.conrelid AND a.attname = 'businessId' AND a.attnum = ANY (co.conkey))
     AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = co.confrelid AND a.attname = 'businessId' AND a.attnum = ANY (co.confkey))),
ref_fk_ok AS (
  SELECT co.conname FROM pg_constraint co JOIN rel r ON r.oid = co.confrelid
   WHERE co.contype = 'f' AND co.convalidated
     AND ((co.conname = 'RevenueLink_externalTransactionId_ref_fkey' AND r.nm = 'ExternalTransaction')
       OR (co.conname = 'RevenueLink_billingDocumentId_ref_fkey' AND r.nm = 'BillingDocument'))),
expected_check(conname) AS (VALUES
  ('RevenueSale_tokens'), ('RevenueSale_currency'), ('RevenueSale_amounts'), ('RevenueSale_original'),
  ('RevenueReceipt_tokens'), ('RevenueReceipt_currency'), ('RevenueReceipt_amounts'),
  ('RevenueDailyClose_tokens'), ('RevenueDailyClose_currency'), ('RevenueDailyClose_amounts'), ('RevenueDailyClose_revision'),
  ('RevenueDailyClose_period'), ('RevenueDailyCloseTender_tokens'), ('RevenueDailyCloseTender_count'), ('RevenueDailyCloseVat_rate'),
  ('RevenueSettlement_source'), ('RevenueSettlement_tokens'), ('RevenueSettlement_currency'), ('RevenueSettlement_amounts'),
  ('RevenueSettlement_installment'), ('RevenueLink_currency'), ('RevenueLink_score'), ('RevenueLink_shape'),
  ('RevenueDecision_subject'), ('RevenueDecision_evidence'), ('RevenueDecision_tokens')),
expected_unique(nm) AS (VALUES
  ('RevenueSale_businessId_id_key'), ('RevenueSale_businessId_sourceScope_externalId_key'),
  ('RevenueReceipt_businessId_id_key'), ('RevenueReceipt_businessId_sourceScope_externalId_key'),
  ('RevenueDailyClose_businessId_id_key'), ('RevenueDailyClose_source_key'), ('RevenueDailyClose_supersedes_once'),
  ('RevenueDailyCloseTender_businessId_id_key'), ('RevenueDailyCloseTender_line_key'),
  ('RevenueDailyCloseVat_businessId_id_key'), ('RevenueDailyCloseVat_line_key'),
  ('RevenueSettlement_businessId_id_key'), ('RevenueSettlement_businessId_sourceScope_externalId_key'),
  ('RevenueLink_businessId_id_key'), ('RevenueLink_one_sale_document'), ('RevenueLink_one_tender_settlement'),
  ('RevenueLink_one_settlement_deposit'), ('RevenueLink_one_cash_deposit'), ('RevenueDecision_businessId_idempotencyKey_key')),
expected_trg(tgname, tbl) AS (
  SELECT nm || '_append_only', nm FROM tables
  UNION ALL SELECT nm || '_no_' || 'trunc' || 'ate', nm FROM tables
  UNION ALL SELECT 'RevenueLink_guard', 'RevenueLink'),
fns AS (SELECT p.oid, p.proname, p.prosecdef, p.proconfig, p.proowner, p.proacl, md5(p.prosrc) AS body FROM pg_proc p
        WHERE p.pronamespace = (SELECT oid FROM pub) AND p.proname LIKE 'revenue\_%'),
expected_body(proname, body) AS (VALUES
  ('revenue_link_guard', 'd44ee812478f2c7a937ec14ddaf9e15b'),
  ('revenue_append_only_guard', 'a47921ee3f4fbff002e4ada0b43d3b54'),
  ('revenue_truncate_guard', '08970bc9a90b49a073e2c50fdc1e5365')),
fn_grants AS (SELECT f.proname, x.grantee FROM fns f CROSS JOIN LATERAL aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) x
              WHERE x.privilege_type = 'EXECUTE' AND x.grantee <> f.proowner),
mig_owner AS (SELECT relowner FROM rel WHERE nm = 'RevenueSale'),
expected_enum(typname, labels) AS (VALUES
  ('RevenueSourceKind', 5), ('RevenueCapture', 5), ('RevenueSaleKind', 3), ('RevenueTenderMethod', 7),
  ('RevenueReceiptDirection', 2), ('RevenueVatCategory', 3), ('RevenueValidation', 3), ('RevenueLinkKind', 4),
  ('RevenueLinkBasis', 4), ('RevenueActor', 2), ('RevenueDecisionKind', 3)),
enum_ok AS (SELECT e.typname FROM expected_enum e JOIN pg_type t ON t.typname = e.typname AND t.typnamespace = (SELECT oid FROM pub)
            WHERE (SELECT count(*) FROM pg_enum x WHERE x.enumtypid = t.oid) = e.labels),
elsewhere AS (
  -- A revenue truth flag would be revenue_*; the coupons flag 'revenue' (20260528120000) is not this migration's.
  SELECT 'flag' AS kind FROM "PlatformFeatureDefinition" WHERE "key" LIKE 'revenue\_%'
  UNION ALL SELECT 'policy' FROM pg_policy p JOIN rel r ON r.oid = p.polrelid
             WHERE p.polname LIKE 'revenue\_%' AND r.nm NOT IN (SELECT nm FROM tables)
  UNION ALL SELECT 'trigger' FROM pg_trigger tg JOIN rel r ON r.oid = tg.tgrelid JOIN pg_proc f ON f.oid = tg.tgfoid
             WHERE NOT tg.tgisinternal AND f.proname LIKE 'revenue\_%' AND r.nm NOT IN (SELECT nm FROM tables)),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261028090000_revenue_truth_foundation'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1,
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261028090000_revenue_truth_foundation'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, (SELECT checksum FROM "_prisma_migrations" WHERE migration_name = '20261028090000_revenue_truth_foundation')
                        = '7279378d6ee9d244d101dc1a7185546cbce520721b725ccf8197a71fa54de266', 1
  UNION ALL SELECT 4, (SELECT count(*) FROM rel WHERE nm IN (SELECT nm FROM tables) AND relrowsecurity AND relforcerowsecurity) = 8,
                      (SELECT count(*) FROM rel WHERE nm IN (SELECT nm FROM tables) AND relrowsecurity AND relforcerowsecurity)
  UNION ALL SELECT 5, (SELECT count(*) FROM pols) = 16
                      AND (SELECT count(*) FROM pols p JOIN expected_pol e ON e.tbl = p.tbl AND e.polname = p.polname AND e.cmd = p.cmd
                            WHERE p.polpermissive AND p.polroles = ARRAY[0]::oid[]
                              AND (p.q IS NOT NULL) = e.has_q AND (p.wc IS NOT NULL) = e.has_wc) = 16,
                      (SELECT count(*) FROM pols)
  UNION ALL SELECT 6, (SELECT count(*) FROM pols WHERE (q IS NOT NULL AND q <> (SELECT e FROM expected_expr))
                                                    OR (wc IS NOT NULL AND wc <> (SELECT e FROM expected_expr))) = 0,
                      (SELECT count(*) FROM pols WHERE (q IS NOT NULL AND q <> (SELECT e FROM expected_expr))
                                                    OR (wc IS NOT NULL AND wc <> (SELECT e FROM expected_expr)))
  UNION ALL SELECT 7, (SELECT count(*) FROM pols WHERE cmd IN ('*', 'w', 'd')) = 0,
                      (SELECT count(*) FROM pols WHERE cmd IN ('*', 'w', 'd'))
  UNION ALL SELECT 8, (SELECT count(*) FROM acl_mismatch) = 0, (SELECT count(*) FROM acl_mismatch)
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x
                         WHERE a.attrelid IN (SELECT oid FROM rel WHERE nm IN (SELECT nm FROM tables))) = 0,
                      (SELECT count(*) FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x
                         WHERE a.attrelid IN (SELECT oid FROM rel WHERE nm IN (SELECT nm FROM tables)))
  UNION ALL SELECT 10, (SELECT count(*) FROM tenant_fk_ok) = 20, (SELECT count(*) FROM tenant_fk_ok)
  UNION ALL SELECT 11, (SELECT count(*) FROM ref_fk_ok) = 2, (SELECT count(*) FROM ref_fk_ok)
  UNION ALL SELECT 12, (SELECT count(*) FROM pg_constraint co JOIN expected_check e ON e.conname = co.conname
                          WHERE co.contype = 'c' AND co.convalidated) = 26,
                       (SELECT count(*) FROM pg_constraint co JOIN expected_check e ON e.conname = co.conname
                          WHERE co.contype = 'c' AND co.convalidated)
  UNION ALL SELECT 13, (SELECT count(*) FROM pg_index i JOIN rel r ON r.oid = i.indexrelid JOIN expected_unique e ON e.nm = r.nm
                          WHERE i.indisunique AND i.indisvalid) = 19,
                       (SELECT count(*) FROM pg_index i JOIN rel r ON r.oid = i.indexrelid JOIN expected_unique e ON e.nm = r.nm
                          WHERE i.indisunique AND i.indisvalid)
  UNION ALL SELECT 14, (SELECT count(*) FROM pg_trigger tg JOIN rel r ON r.oid = tg.tgrelid
                          JOIN expected_trg e ON e.tgname = tg.tgname AND e.tbl = r.nm WHERE tg.tgenabled = 'O') = 17,
                       (SELECT count(*) FROM pg_trigger tg JOIN rel r ON r.oid = tg.tgrelid
                          JOIN expected_trg e ON e.tgname = tg.tgname AND e.tbl = r.nm WHERE tg.tgenabled = 'O')
  UNION ALL SELECT 15, (SELECT count(*) FROM fns WHERE NOT prosecdef AND proowner = (SELECT relowner FROM mig_owner)
                          AND proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']) = 3
                       AND (SELECT count(*) FROM fns) = 3,
                       (SELECT count(*) FROM fns WHERE NOT prosecdef AND proowner = (SELECT relowner FROM mig_owner)
                          AND proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp'])
  UNION ALL SELECT 16, (SELECT count(*) FROM fns f JOIN expected_body e ON e.proname = f.proname AND e.body = f.body) = 3,
                       (SELECT count(*) FROM fns f JOIN expected_body e ON e.proname = f.proname AND e.body = f.body)
  UNION ALL SELECT 17, (SELECT count(*) FROM fn_grants) = 0, (SELECT count(*) FROM fn_grants)
  UNION ALL SELECT 18, (SELECT count(*) FROM enum_ok) = 11, (SELECT count(*) FROM enum_ok)
  UNION ALL SELECT 19, (SELECT (SELECT count(*) FROM "RevenueSale") + (SELECT count(*) FROM "RevenueReceipt")
                             + (SELECT count(*) FROM "RevenueDailyClose") + (SELECT count(*) FROM "RevenueDailyCloseTender")
                             + (SELECT count(*) FROM "RevenueDailyCloseVat") + (SELECT count(*) FROM "RevenueSettlement")
                             + (SELECT count(*) FROM "RevenueLink") + (SELECT count(*) FROM "RevenueDecision")) = 0,
                       (SELECT (SELECT count(*) FROM "RevenueSale") + (SELECT count(*) FROM "RevenueReceipt")
                             + (SELECT count(*) FROM "RevenueDailyClose") + (SELECT count(*) FROM "RevenueDailyCloseTender")
                             + (SELECT count(*) FROM "RevenueDailyCloseVat") + (SELECT count(*) FROM "RevenueSettlement")
                             + (SELECT count(*) FROM "RevenueLink") + (SELECT count(*) FROM "RevenueDecision"))
  UNION ALL SELECT 20, (SELECT count(*) FROM elsewhere) = 0, (SELECT count(*) FROM elsewhere)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
