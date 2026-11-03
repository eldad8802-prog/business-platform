-- ============================================================================
-- service-desk-foundation-production-evidence.sql
--
-- Read-only EVIDENCE after migration
--   20261112090000_service_desk_foundation   (applied)
--
-- Proves the release landed whole and nothing else moved:
--   * the ledger row is finished; nothing is pending or rolled back;
--   * seven tables, each with RLS enabled + forced; nineteen per-operation policies, none for removal or ALL;
--   * app_runtime privileges, read from the ACL letters: arw (read, add, change) on five tables, ar (read, add) on
--     the journal and the handover; no other role holds anything on the seven tables;
--   * eleven service_ functions, each with search_path ending in pg_temp, none executable by PUBLIC; exactly one
--     SECURITY DEFINER (service_erase_business), executable by app_runtime;
--   * thirteen guard triggers; the one-document-one-case exclusion;
--   * no row in any of the seven tables (nothing reads or writes them before the application release) and no
--     feature-flag definition for the module (it is not switched on by this release);
--   * the ledger checksum equals the sha256 of the reviewed migration.sql (pinned in check 16).
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== service desk foundation evidence: legend (n -> check) =='
\echo ' 1 20261112090000_service_desk_foundation is recorded and finished'
\echo ' 2 ledger: no unfinished and no rolled-back row'
\echo ' 3 seven Service tables with RLS enabled and forced'
\echo ' 4 nineteen policies on them'
\echo ' 5 none of those policies is for removal or ALL'
\echo ' 6 app_runtime holds arw on the five changeable tables (of 5)'
\echo ' 7 app_runtime holds exactly ar on the journal and the handover (of 2)'
\echo ' 8 no other role holds anything on the seven tables'
\echo ' 9 eleven service_ functions, search_path ending in pg_temp'
\echo '10 none of them executable by PUBLIC'
\echo '11 exactly one SECURITY DEFINER, executable by app_runtime'
\echo '12 thirteen guard triggers on the seven tables, all enabled'
\echo '13 the one-document-one-case exclusion exists'
\echo '14 rows in the seven tables (want 0 until the application release)'
\echo '15 no feature-flag definition for the module'
\echo '16 the ledger checksum is the reviewed migration.sql (sha256 pinned below)'

WITH t AS (
  SELECT c.oid, c.relname, c.relacl, c.relowner FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relname IN ('ServiceCaseNumberSequence','ServiceDevice','ServiceCase','ServiceCaseIntake','ServiceQuote','ServiceCaseEvent','ServiceHandover')
), f AS (
  SELECT p.oid, p.proname, p.prosecdef, p.proconfig FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('service_user_same_business','service_case_guard','service_device_guard','service_intake_guard',
                       'service_quote_billing_document_guard','service_quote_guard','service_event_matches_case',
                       'service_event_append_only_guard','service_journal_truncate_guard','service_handover_guard','service_erase_business')
), c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261112090000_service_desk_foundation' AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS observed, 1 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM t JOIN pg_class k ON k.oid = t.oid WHERE k.relrowsecurity AND k.relforcerowsecurity), 7
  UNION ALL SELECT 4, (SELECT count(*) FROM pg_policy p JOIN t ON t.oid = p.polrelid), 19
  UNION ALL SELECT 5, (SELECT count(*) FROM pg_policy p JOIN t ON t.oid = p.polrelid WHERE p.polcmd IN ('d', '*')), 0
  UNION ALL SELECT 6, (SELECT count(*) FROM t WHERE t.relname IN ('ServiceCaseNumberSequence','ServiceDevice','ServiceCase','ServiceCaseIntake','ServiceQuote')
      AND t.relacl::text LIKE '%app_runtime=arw/%'), 5
  UNION ALL SELECT 7, (SELECT count(*) FROM t WHERE t.relname IN ('ServiceCaseEvent','ServiceHandover') AND t.relacl::text LIKE '%app_runtime=ar/%'), 2
  UNION ALL SELECT 8, (SELECT count(*) FROM t CROSS JOIN LATERAL aclexplode(t.relacl) x
      WHERE x.grantee <> t.relowner AND pg_get_userbyid(x.grantee) <> 'app_runtime'), 0
  UNION ALL SELECT 9, (SELECT count(*) FROM f WHERE array_to_string(f.proconfig, ',') LIKE '%search_path=pg_catalog, public, pg_temp'), 11
  UNION ALL SELECT 10, (SELECT count(*) FROM f WHERE has_function_privilege('public', f.oid, 'EXECUTE')), 0
  UNION ALL SELECT 11, (SELECT count(*) FROM f WHERE f.prosecdef AND f.proname = 'service_erase_business' AND has_function_privilege('app_runtime', f.oid, 'EXECUTE')
      AND (SELECT count(*) FROM f g WHERE g.prosecdef) = 1), 1
  UNION ALL SELECT 12, (SELECT count(*) FROM pg_trigger tr JOIN t ON t.oid = tr.tgrelid WHERE NOT tr.tgisinternal AND tr.tgenabled <> 'D'), 13
  UNION ALL SELECT 13, (SELECT count(*) FROM pg_constraint WHERE conname = 'ServiceQuote_billing_document_one_case' AND contype = 'x'), 1
  UNION ALL SELECT 14, (SELECT (SELECT count(*) FROM "ServiceCaseNumberSequence") + (SELECT count(*) FROM "ServiceDevice") + (SELECT count(*) FROM "ServiceCase")
      + (SELECT count(*) FROM "ServiceCaseIntake") + (SELECT count(*) FROM "ServiceQuote") + (SELECT count(*) FROM "ServiceCaseEvent") + (SELECT count(*) FROM "ServiceHandover")), 0
  UNION ALL SELECT 15, (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE key ILIKE '%service_desk%'), 0
  UNION ALL SELECT 16, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261112090000_service_desk_foundation' AND checksum = '86d42b4ae40f41ef9b7d4a2d3b7d6dec4282675a20011c4fb090bc3c4377d6da'), 1
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
