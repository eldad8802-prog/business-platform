-- ============================================================================
-- business-documents-records-production-evidence.sql
--
-- Read-only EVIDENCE after migration
--   20261114090000_business_documents_records   (applied)
--
-- Proves the release landed whole and nothing else moved:
--   * the ledger row is finished; nothing is pending or rolled back; the checksum is the reviewed migration.sql;
--   * six tables, RLS enabled + forced; fourteen per-operation policies, none for removal or ALL;
--   * app_runtime privileges from the ACL letters: ar on five tables, r on the erasure job; column-level w on exactly
--     sixteen columns (file 7, request 7, letter 2); no other role holds anything on the six tables;
--   * three SECURITY DEFINER functions (erase, erasure complete, purge letter): search_path ending in pg_temp,
--     executable by app_runtime, not by PUBLIC; the nine guard functions are invokers, not executable by PUBLIC;
--   * nineteen triggers on the six tables, all enabled; no trigger on a billing table calls any of these functions;
--   * no row in the six tables (nothing writes them before the application release);
--   * the business_documents flag: defaultEnabled false, globalEnabled false, no business override;
--   * the billing catalog fingerprint equals check 15 of the preflight run (nothing of billing moved).
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== business documents records evidence: legend (n -> check) =='
\echo ' 1 20261114090000_business_documents_records is recorded and finished'
\echo ' 2 ledger: no unfinished and no rolled-back row'
\echo ' 3 six tables with RLS enabled and forced'
\echo ' 4 fourteen policies on them'
\echo ' 5 none of those policies is for removal or ALL'
\echo ' 6 app_runtime holds exactly ar on five tables and exactly r on the erasure job (of 6)'
\echo ' 7 no other role holds anything on the six tables'
\echo ' 8 column-level w for app_runtime on exactly sixteen columns'
\echo ' 9 three SECURITY DEFINER functions, pg_temp last, executable by app_runtime, not by PUBLIC'
\echo '10 nine invoker guard functions, none executable by PUBLIC, none a definer'
\echo '11 nineteen triggers on the six tables, all enabled'
\echo '12 triggers on BillingDocument or BillingDocumentLine that invoke a business documents function (want 0)'
\echo '13 rows in the six tables (want 0 until the application release)'
\echo '14 flag business_documents: definition off, policy off, no business override'
\echo '15 the ledger checksum is the reviewed migration.sql (sha256 pinned below)'
\echo '16 billing catalog fingerprint (INFO: must equal check 15 of the preflight run)'

WITH t AS (
  SELECT c.oid, c.relname, c.relacl, c.relowner FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relname IN ('BusinessDocumentFile', 'BusinessDocumentRequest', 'QuoteShareCopy', 'QuoteShareEvent', 'BusinessLetter', 'BusinessDocumentErasure')
), f AS (
  SELECT p.oid, p.proname, p.prosecdef, p.proconfig FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'business\_documents\_%' OR p.proname LIKE 'business\_letter\_%')
), c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261114090000_business_documents_records' AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS observed, 1 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM t JOIN pg_class k ON k.oid = t.oid WHERE k.relrowsecurity AND k.relforcerowsecurity), 6
  UNION ALL SELECT 4, (SELECT count(*) FROM pg_policy p JOIN t ON t.oid = p.polrelid), 14
  UNION ALL SELECT 5, (SELECT count(*) FROM pg_policy p JOIN t ON t.oid = p.polrelid WHERE p.polcmd IN ('d', '*')), 0
  UNION ALL SELECT 6, (SELECT count(*) FROM t WHERE (t.relname <> 'BusinessDocumentErasure' AND t.relacl::text LIKE '%app_runtime=ar/%')
                                              OR (t.relname = 'BusinessDocumentErasure' AND t.relacl::text LIKE '%app_runtime=r/%')), 6
  UNION ALL SELECT 7, (SELECT count(*) FROM t CROSS JOIN LATERAL aclexplode(t.relacl) x
      WHERE x.grantee <> t.relowner AND pg_get_userbyid(x.grantee) <> 'app_runtime'), 0
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_attribute a JOIN t ON t.oid = a.attrelid
      WHERE a.attnum > 0 AND a.attacl::text LIKE '%app_runtime=w/%'), 16
  UNION ALL SELECT 9, (SELECT count(*) FROM f WHERE f.prosecdef
      AND f.proname IN ('business_documents_erase', 'business_documents_erasure_complete', 'business_documents_purge_letter')
      AND array_to_string(f.proconfig, ',') LIKE '%search_path=pg_catalog, public, pg_temp'
      AND has_function_privilege('app_runtime', f.oid, 'EXECUTE') AND NOT has_function_privilege('public', f.oid, 'EXECUTE')), 3
  UNION ALL SELECT 10, (SELECT count(*) FROM f WHERE NOT f.prosecdef AND NOT has_function_privilege('public', f.oid, 'EXECUTE')
      AND array_to_string(f.proconfig, ',') LIKE '%search_path=pg_catalog, public, pg_temp'), 9
  UNION ALL SELECT 11, (SELECT count(*) FROM pg_trigger tr JOIN t ON t.oid = tr.tgrelid WHERE NOT tr.tgisinternal AND tr.tgenabled <> 'D'), 19
  UNION ALL SELECT 12, (SELECT count(*) FROM pg_trigger tr JOIN f ON f.oid = tr.tgfoid
      WHERE tr.tgrelid IN ('public."BillingDocument"'::regclass, 'public."BillingDocumentLine"'::regclass)), 0
  UNION ALL SELECT 13, (SELECT (SELECT count(*) FROM "BusinessDocumentFile") + (SELECT count(*) FROM "BusinessDocumentRequest")
                             + (SELECT count(*) FROM "QuoteShareCopy") + (SELECT count(*) FROM "QuoteShareEvent")
                             + (SELECT count(*) FROM "BusinessLetter") + (SELECT count(*) FROM "BusinessDocumentErasure")), 0
  UNION ALL SELECT 14, (SELECT CASE WHEN
        (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE "key" = 'business_documents' AND NOT "defaultEnabled") = 1
    AND (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'business_documents' AND NOT "globalEnabled") = 1
    AND (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'business_documents') = 0
    THEN 1 ELSE 0 END), 1
  UNION ALL SELECT 15, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261114090000_business_documents_records'
                         AND checksum = '6129e01e20cff227b96b15227308297c58b7d329ec4d5f96c8dcb5827e2c835f'), 1
  UNION ALL SELECT 16, (SELECT hashtext(
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
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
