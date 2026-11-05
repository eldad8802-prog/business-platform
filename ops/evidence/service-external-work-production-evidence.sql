-- ============================================================================
-- service-external-work-production-evidence.sql
--
-- Read-only EVIDENCE after migration
--   20261113090000_service_external_work   (applied)
--
-- Proves the release landed whole and nothing else moved:
--   * the ledger row is finished; nothing is pending or rolled back;
--   * two tables, RLS enabled + forced; five per-operation policies, none for removal or ALL;
--   * app_runtime privileges from the ACL letters: arw on the work, ar on the journal; no other role holds anything;
--   * eight functions with search_path ending in pg_temp, none executable by PUBLIC; exactly one SECURITY DEFINER
--     among them (service_external_erase_business), executable by app_runtime;
--   * eight triggers on the two tables plus the two refusing triggers on ServiceHandover / ServiceCase, all enabled;
--   * the per-case and per-device one-open-work unique indexes; the deferred no-silent-change trigger;
--   * no row in the two tables (nothing writes them before the application release);
--   * the foundation's service_erase_business() is still SECURITY DEFINER with pg_temp last and touches no new table;
--   * the ledger checksum equals the sha256 of the reviewed migration.sql (pinned in check 15).
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== service external work evidence: legend (n -> check) =='
\echo ' 1 20261113090000_service_external_work is recorded and finished'
\echo ' 2 ledger: no unfinished and no rolled-back row'
\echo ' 3 two tables with RLS enabled and forced'
\echo ' 4 five policies on them'
\echo ' 5 none of those policies is for removal or ALL'
\echo ' 6 app_runtime holds arw on the work and exactly ar on the journal (of 2)'
\echo ' 7 no other role holds anything on the two tables'
\echo ' 8 eight new functions, search_path ending in pg_temp'
\echo ' 9 none of them executable by PUBLIC'
\echo '10 exactly one SECURITY DEFINER among them, executable by app_runtime'
\echo '11 eight triggers on the two tables plus the handover and case guards, all enabled (of 10)'
\echo '12 the one-open-work unique indexes per case and per device (of 2) and the deferred no-silent-change trigger'
\echo '13 rows in the two tables (want 0 until the application release)'
\echo '14 the foundation erasure is unchanged: definer, pg_temp last, no ServiceExternal reference'
\echo '15 the ledger checksum is the reviewed migration.sql (sha256 pinned below)'

WITH t AS (
  SELECT c.oid, c.relname, c.relacl, c.relowner FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('ServiceExternalWork', 'ServiceExternalWorkEvent')
), f AS (
  SELECT p.oid, p.proname, p.prosecdef, p.proconfig FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('service_external_work_insert_guard', 'service_external_work_guard', 'service_external_work_has_event',
                       'service_external_event_matches_work', 'service_external_event_guard', 'service_handover_no_open_external',
                       'service_case_external_work_closed', 'service_external_erase_business')
), c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261113090000_service_external_work' AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS observed, 1 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM t JOIN pg_class k ON k.oid = t.oid WHERE k.relrowsecurity AND k.relforcerowsecurity), 2
  UNION ALL SELECT 4, (SELECT count(*) FROM pg_policy p JOIN t ON t.oid = p.polrelid), 5
  UNION ALL SELECT 5, (SELECT count(*) FROM pg_policy p JOIN t ON t.oid = p.polrelid WHERE p.polcmd IN ('d', '*')), 0
  UNION ALL SELECT 6, (SELECT count(*) FROM t WHERE (t.relname = 'ServiceExternalWork' AND t.relacl::text LIKE '%app_runtime=arw/%')
                                              OR (t.relname = 'ServiceExternalWorkEvent' AND t.relacl::text LIKE '%app_runtime=ar/%')), 2
  UNION ALL SELECT 7, (SELECT count(*) FROM t CROSS JOIN LATERAL aclexplode(t.relacl) x
      WHERE x.grantee <> t.relowner AND pg_get_userbyid(x.grantee) <> 'app_runtime'), 0
  UNION ALL SELECT 8, (SELECT count(*) FROM f WHERE array_to_string(f.proconfig, ',') LIKE '%search_path=pg_catalog, public, pg_temp'), 8
  UNION ALL SELECT 9, (SELECT count(*) FROM f WHERE has_function_privilege('public', f.oid, 'EXECUTE')), 0
  UNION ALL SELECT 10, (SELECT count(*) FROM f WHERE f.prosecdef AND f.proname = 'service_external_erase_business'
      AND has_function_privilege('app_runtime', f.oid, 'EXECUTE') AND (SELECT count(*) FROM f g WHERE g.prosecdef) = 1), 1
  UNION ALL SELECT 11, (SELECT count(*) FROM pg_trigger tr JOIN pg_class k ON k.oid = tr.tgrelid
      WHERE NOT tr.tgisinternal AND tr.tgenabled <> 'D'
        AND (k.relname IN ('ServiceExternalWork', 'ServiceExternalWorkEvent')
             OR tr.tgname IN ('ServiceHandover_no_open_external', 'ServiceCase_external_work_closed'))), 10
  UNION ALL SELECT 12, (SELECT CASE WHEN
        (SELECT count(*) FROM pg_indexes WHERE indexname IN ('ServiceExternalWork_one_open_per_case', 'ServiceExternalWork_one_open_per_device')
           AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%AT_SUPPLIER%') = 2
    AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'ServiceExternalWork_has_event' AND tgconstraint <> 0 AND tgdeferrable AND tginitdeferred)
    THEN 1 ELSE 0 END), 1
  UNION ALL SELECT 13, (SELECT (SELECT count(*) FROM "ServiceExternalWork") + (SELECT count(*) FROM "ServiceExternalWorkEvent")), 0
  UNION ALL SELECT 14, (SELECT count(*) FROM pg_proc WHERE proname = 'service_erase_business' AND pronamespace = 'public'::regnamespace
      AND prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path=pg_catalog, public, pg_temp' AND prosrc NOT LIKE '%ServiceExternal%'), 1
  UNION ALL SELECT 15, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261113090000_service_external_work' AND checksum = '4f2f7fe56847ee93c44f4ee57ef4bcf3bc2d68a961094c663bbec459632bf4af'), 1
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
