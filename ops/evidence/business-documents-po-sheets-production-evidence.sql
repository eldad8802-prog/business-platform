-- ============================================================================
-- business-documents-po-sheets-production-evidence.sql
--
-- Read-only EVIDENCE after migration
--   20261121090000_business_documents_po_sheets   (applied)
--
-- Proves the release landed whole and nothing else moved:
--   * the ledger row is finished; nothing is pending or rolled back; the checksum is the reviewed migration.sql;
--   * the PurchaseOrderSheet table, RLS enabled + forced; two policies (read, add), none for change, removal or ALL;
--   * app_runtime privileges from the ACL letters: ar on the table, rU on its sequence; no other role holds anything;
--   * PURCHASE_ORDER_SHEET on both enum types;
--   * the link guard is an invoker, pg_temp last, not executable by PUBLIC;
--   * business_documents_erase now covers the table, is still SECURITY DEFINER, pg_temp last, executable by
--     app_runtime and not by PUBLIC; business_documents_file_guard counts a saved sheet's file as referenced and keeps
--     the quote-share and letter conditions, invoker, pg_temp last, not executable by PUBLIC;
--   * five triggers on the table, all enabled; three foreign keys (Business, BusinessDocumentFile, User) and none to
--     SupplierPurchaseDraft; no trigger on a billing or inventory table calls the link guard;
--   * no row in the table (nothing writes it before the application release);
--   * the business_documents flag is still off; the override count, the billing catalog fingerprint and the
--     inventory fingerprint equal checks 19, 20 and 21 of the preflight run.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== purchase-order sheet evidence: legend (n -> check) =='
\echo ' 1 20261121090000_business_documents_po_sheets is recorded and finished'
\echo ' 2 ledger: no unfinished and no rolled-back row'
\echo ' 3 the ledger checksum is the reviewed migration.sql (sha256 pinned below)'
\echo ' 4 PurchaseOrderSheet exists with RLS enabled and forced'
\echo ' 5 two policies on it: one for reading, one for adding'
\echo ' 6 none of its policies is for change, removal or ALL'
\echo ' 7 app_runtime holds exactly ar on the table and rU on its sequence (of 2)'
\echo ' 8 no other role holds anything on the table or its sequence'
\echo ' 9 PURCHASE_ORDER_SHEET on both enum types (of 2)'
\echo '10 the link guard: invoker, pg_temp last, not executable by PUBLIC'
\echo '11 business_documents_erase covers the table: definer, pg_temp last, app_runtime yes, PUBLIC no'
\echo '12 five triggers on the table, all enabled'
\echo '13 three foreign keys on the table'
\echo '14 foreign keys from the table to SupplierPurchaseDraft (want 0)'
\echo '15 triggers on billing or inventory tables that invoke the link guard (want 0)'
\echo '16 rows in PurchaseOrderSheet (want 0 until the application release)'
\echo '17 flag business_documents: definition off and policy off'
\echo '18 business overrides of business_documents (INFO: must equal check 19 of the preflight run)'
\echo '19 billing catalog fingerprint (INFO: must equal check 20 of the preflight run)'
\echo '20 inventory fingerprint, SupplierPurchaseDraft + PurchaseOrder (INFO: must equal check 21 of the preflight run)'
\echo '21 business_documents_file_guard counts sheets, quote copies and letters: invoker, pg_temp last, PUBLIC no'

WITH t AS (
  SELECT k.oid, k.relname, k.relacl, k.relowner, k.relrowsecurity, k.relforcerowsecurity FROM pg_class k
   WHERE k.relnamespace = 'public'::regnamespace AND k.relname IN ('PurchaseOrderSheet', 'PurchaseOrderSheet_id_seq')
), c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261121090000_business_documents_po_sheets'
                   AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS observed, 1 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261121090000_business_documents_po_sheets'
                         AND checksum = 'f0bfb8ed135fec62ecefb8a1ab5e0e168bab5641ea435892b231351752504e6f'), 1
  UNION ALL SELECT 4, (SELECT count(*) FROM t WHERE t.relname = 'PurchaseOrderSheet' AND t.relrowsecurity AND t.relforcerowsecurity), 1
  UNION ALL SELECT 5, (SELECT count(*) FROM pg_policy p JOIN t ON t.oid = p.polrelid
      WHERE (p.polname = 'purchase_order_sheet_tenant_select' AND p.polcmd = 'r')
         OR (p.polname = 'purchase_order_sheet_tenant_insert' AND p.polcmd = 'a')), 2
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_policy p JOIN t ON t.oid = p.polrelid WHERE p.polcmd IN ('w', 'd', '*')), 0
  UNION ALL SELECT 7, (SELECT count(*) FROM t WHERE (t.relname = 'PurchaseOrderSheet' AND t.relacl::text LIKE '%app_runtime=ar/%')
                                              OR (t.relname = 'PurchaseOrderSheet_id_seq' AND t.relacl::text LIKE '%app_runtime=rU/%')), 2
  UNION ALL SELECT 8, (SELECT count(*) FROM t CROSS JOIN LATERAL aclexplode(t.relacl) x
      WHERE x.grantee <> t.relowner AND (x.grantee = 0 OR pg_get_userbyid(x.grantee) <> 'app_runtime')), 0
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_enum e JOIN pg_type ty ON ty.oid = e.enumtypid
      WHERE e.enumlabel = 'PURCHASE_ORDER_SHEET' AND ty.typname IN ('BusinessDocumentFilePurpose', 'BusinessDocumentOperation')), 2
  UNION ALL SELECT 10, (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'business_documents_po_sheet_link_guard'
      AND NOT p.prosecdef AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
      AND array_to_string(p.proconfig, ',') LIKE '%search_path=pg_catalog, public, pg_temp'), 1
  UNION ALL SELECT 11, (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'business_documents_erase'
      AND p.prosecdef AND p.prosrc LIKE '%"PurchaseOrderSheet"%'
      AND array_to_string(p.proconfig, ',') LIKE '%search_path=pg_catalog, public, pg_temp'
      AND has_function_privilege('app_runtime', p.oid, 'EXECUTE') AND NOT has_function_privilege('public', p.oid, 'EXECUTE')), 1
  UNION ALL SELECT 12, (SELECT count(*) FROM pg_trigger tr JOIN t ON t.oid = tr.tgrelid
      WHERE NOT tr.tgisinternal AND tr.tgenabled <> 'D' AND tr.tgname IN ('PurchaseOrderSheet_not_erasing', 'PurchaseOrderSheet_link',
        'PurchaseOrderSheet_file_ready', 'PurchaseOrderSheet_append_only', 'PurchaseOrderSheet_no_truncate')), 5
  UNION ALL SELECT 13, (SELECT count(*) FROM pg_constraint k JOIN t ON t.oid = k.conrelid WHERE k.contype = 'f'), 3
  UNION ALL SELECT 14, (SELECT count(*) FROM pg_constraint k JOIN t ON t.oid = k.conrelid WHERE k.contype = 'f'
      AND k.confrelid = 'public."SupplierPurchaseDraft"'::regclass), 0
  UNION ALL SELECT 15, (SELECT count(*) FROM pg_trigger tr JOIN pg_proc p ON p.oid = tr.tgfoid
      WHERE p.proname = 'business_documents_po_sheet_link_guard'
        AND tr.tgrelid IN ('public."BillingDocument"'::regclass, 'public."BillingDocumentLine"'::regclass,
                           'public."SupplierPurchaseDraft"'::regclass, 'public."PurchaseOrder"'::regclass)), 0
  UNION ALL SELECT 16, (SELECT count(*) FROM "PurchaseOrderSheet"), 0
  UNION ALL SELECT 17, (SELECT CASE WHEN
        (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE "key" = 'business_documents' AND NOT "defaultEnabled") = 1
    AND (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'business_documents' AND NOT "globalEnabled") = 1
    THEN 1 ELSE 0 END), 1
  UNION ALL SELECT 18, (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'business_documents'), NULL
  UNION ALL SELECT 19, (SELECT hashtext(
         coalesce((SELECT string_agg(table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, ''), ',' ORDER BY table_name, ordinal_position)
                     FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('BillingDocument', 'BillingDocumentLine')), '')
      || coalesce((SELECT string_agg(conname || pg_get_constraintdef(oid), ',' ORDER BY conname)
                     FROM pg_constraint WHERE conrelid IN ('public."BillingDocument"'::regclass, 'public."BillingDocumentLine"'::regclass)), '')
      || coalesce((SELECT string_agg(indexdef, ',' ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename IN ('BillingDocument', 'BillingDocumentLine')), '')
      || coalesce((SELECT string_agg(tgname::text || tgenabled::text || tgfoid::regproc::text, ',' ORDER BY tgname)
                     FROM pg_trigger WHERE tgrelid IN ('public."BillingDocument"'::regclass, 'public."BillingDocumentLine"'::regclass)), '')
      || coalesce((SELECT string_agg(polname || polcmd::text, ',' ORDER BY polname)
                     FROM pg_policy WHERE polrelid IN ('public."BillingDocument"'::regclass, 'public."BillingDocumentLine"'::regclass)), '')
      || coalesce((SELECT string_agg(relname || coalesce(relacl::text, '') || relrowsecurity::text || relforcerowsecurity::text, ',' ORDER BY relname)
                     FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('BillingDocument', 'BillingDocumentLine')), '')
      || coalesce((SELECT string_agg(attrelid::regclass::text || '.' || attname || coalesce(attacl::text, ''), ',' ORDER BY attrelid, attnum)
                     FROM pg_attribute WHERE attrelid IN ('public."BillingDocument"'::regclass, 'public."BillingDocumentLine"'::regclass) AND attnum > 0 AND attacl IS NOT NULL), '')
    )::bigint), NULL
  UNION ALL SELECT 20, (SELECT hashtext(
         coalesce((SELECT string_agg(table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, ''), ',' ORDER BY table_name, ordinal_position)
                     FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('SupplierPurchaseDraft', 'PurchaseOrder')), '')
      || coalesce((SELECT string_agg(conname || pg_get_constraintdef(oid), ',' ORDER BY conname)
                     FROM pg_constraint WHERE conrelid IN ('public."SupplierPurchaseDraft"'::regclass, 'public."PurchaseOrder"'::regclass)), '')
      || coalesce((SELECT string_agg(indexdef, ',' ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename IN ('SupplierPurchaseDraft', 'PurchaseOrder')), '')
      || coalesce((SELECT string_agg(tgname::text || tgenabled::text || tgfoid::regproc::text, ',' ORDER BY tgname)
                     FROM pg_trigger WHERE tgrelid IN ('public."SupplierPurchaseDraft"'::regclass, 'public."PurchaseOrder"'::regclass)), '')
      || coalesce((SELECT string_agg(polname || polcmd::text, ',' ORDER BY polname)
                     FROM pg_policy WHERE polrelid IN ('public."SupplierPurchaseDraft"'::regclass, 'public."PurchaseOrder"'::regclass)), '')
      || coalesce((SELECT string_agg(relname || coalesce(relacl::text, '') || relrowsecurity::text || relforcerowsecurity::text, ',' ORDER BY relname)
                     FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('SupplierPurchaseDraft', 'PurchaseOrder')), '')
      || coalesce((SELECT string_agg(attrelid::regclass::text || '.' || attname || coalesce(attacl::text, ''), ',' ORDER BY attrelid, attnum)
                     FROM pg_attribute WHERE attrelid IN ('public."SupplierPurchaseDraft"'::regclass, 'public."PurchaseOrder"'::regclass) AND attnum > 0 AND attacl IS NOT NULL), '')
    )::bigint), NULL
  UNION ALL SELECT 21, (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'business_documents_file_guard'
      AND NOT p.prosecdef AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
      AND array_to_string(p.proconfig, ',') LIKE '%search_path=pg_catalog, public, pg_temp'
      AND p.prosrc LIKE '%public."PurchaseOrderSheet" s%' AND p.prosrc LIKE '%public."QuoteShareCopy" c%' AND p.prosrc LIKE '%public."BusinessLetter" l%'), 1
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
