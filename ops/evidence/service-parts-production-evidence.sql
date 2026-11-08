-- ============================================================================
-- service-parts-production-evidence.sql
--
-- Read-only EVIDENCE after migration
--   20261115090000_service_parts   (applied)
--
-- Proves the release landed whole and nothing else moved:
--   * the ledger row is finished; nothing is pending or rolled back;
--   * two tables, RLS enabled + forced; five per-operation policies, none for removal or ALL;
--   * app_runtime privileges from the ACL letters: arw on the part lines, ar on the journal; no other role holds anything;
--   * eleven functions with search_path ending in pg_temp, none executable by PUBLIC; exactly one SECURITY DEFINER
--     among them (service_parts_erase_business), executable by app_runtime;
--   * nine triggers on the two tables plus the two refusing deferred triggers on ServiceCase / ServiceExternalWork, all
--     enabled;
--   * the UNIQUE issue / return movement indexes; the deferred no-silent-change and split-reconcile triggers;
--   * no row in the two tables (nothing writes them before the application release);
--   * the 1.2a / 1.2b erasure functions are still SECURITY DEFINER with pg_temp last and touch no new table;
--   * the ledger checksum equals the sha256 of the reviewed migration.sql (pinned in check 15) — which also pins the
--     guard bodies, so the case-row serialisation rule proven in the lab (.sdp battery 1.6, locks A5 / A6) holds here.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== service parts evidence: legend (n -> check) =='
\echo ' 1 20261115090000_service_parts is recorded and finished'
\echo ' 2 ledger: no unfinished and no rolled-back row'
\echo ' 3 two tables with RLS enabled and forced'
\echo ' 4 five policies on them'
\echo ' 5 none of those policies is for removal or ALL'
\echo ' 6 app_runtime holds arw on the part lines and exactly ar on the journal (of 2)'
\echo ' 7 no other role holds anything on the two tables'
\echo ' 8 eleven new functions, search_path ending in pg_temp'
\echo ' 9 none of them executable by PUBLIC'
\echo '10 exactly one SECURITY DEFINER among them, executable by app_runtime'
\echo '11 nine triggers on the two tables plus the case-close and supplier-return guards, all enabled (of 11)'
\echo '12 UNIQUE issue and return movement indexes (of 2) and the deferred no-silent-change and split triggers (of 2)'
\echo '13 rows in the two tables (want 0 until the application release)'
\echo '14 the 1.2a / 1.2b erasures are unchanged: definer, pg_temp last, no ServicePart reference (of 2)'
\echo '15 the ledger checksum is the reviewed migration.sql (sha256 pinned below)'

WITH t AS (
  SELECT c.oid, c.relname, c.relacl, c.relowner FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('ServicePart', 'ServicePartEvent')
), f AS (
  SELECT p.oid, p.proname, p.prosecdef, p.proconfig FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('service_part_check_movement', 'service_part_check_order', 'service_part_insert_guard', 'service_part_guard',
                       'service_part_has_event', 'service_part_split_reconciles', 'service_part_event_matches_part',
                       'service_part_event_guard', 'service_case_parts_resolved_on_close',
                       'service_external_parts_resolved_on_return', 'service_parts_erase_business')
), c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261115090000_service_parts' AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS observed, 1 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM t JOIN pg_class k ON k.oid = t.oid WHERE k.relrowsecurity AND k.relforcerowsecurity), 2
  UNION ALL SELECT 4, (SELECT count(*) FROM pg_policy p JOIN t ON t.oid = p.polrelid), 5
  UNION ALL SELECT 5, (SELECT count(*) FROM pg_policy p JOIN t ON t.oid = p.polrelid WHERE p.polcmd IN ('d', '*')), 0
  UNION ALL SELECT 6, (SELECT count(*) FROM t WHERE (t.relname = 'ServicePart' AND t.relacl::text LIKE '%app_runtime=arw/%')
                                              OR (t.relname = 'ServicePartEvent' AND t.relacl::text LIKE '%app_runtime=ar/%')), 2
  UNION ALL SELECT 7, (SELECT count(*) FROM t CROSS JOIN LATERAL aclexplode(t.relacl) x
      WHERE x.grantee <> t.relowner AND pg_get_userbyid(x.grantee) <> 'app_runtime'), 0
  UNION ALL SELECT 8, (SELECT count(*) FROM f WHERE array_to_string(f.proconfig, ',') LIKE '%search_path=pg_catalog, public, pg_temp'), 11
  UNION ALL SELECT 9, (SELECT count(*) FROM f WHERE has_function_privilege('public', f.oid, 'EXECUTE')), 0
  UNION ALL SELECT 10, (SELECT count(*) FROM f WHERE f.prosecdef AND f.proname = 'service_parts_erase_business'
      AND has_function_privilege('app_runtime', f.oid, 'EXECUTE') AND (SELECT count(*) FROM f g WHERE g.prosecdef) = 1), 1
  UNION ALL SELECT 11, (SELECT count(*) FROM pg_trigger tr JOIN pg_class k ON k.oid = tr.tgrelid
      WHERE NOT tr.tgisinternal AND tr.tgenabled <> 'D'
        AND (k.relname IN ('ServicePart', 'ServicePartEvent')
             OR tr.tgname IN ('ServiceCase_parts_resolved_on_close', 'ServiceExternalWork_parts_resolved_on_return'))), 11
  UNION ALL SELECT 12, (SELECT CASE WHEN
        (SELECT count(*) FROM pg_indexes WHERE indexname IN ('ServicePart_issueMovementId_key', 'ServicePart_returnMovementId_key')
           AND indexdef LIKE '%UNIQUE%') = 2
    AND (SELECT count(*) FROM pg_trigger WHERE tgname IN ('ServicePart_has_event', 'ServicePart_split_reconciles')
           AND tgconstraint <> 0 AND tgdeferrable AND tginitdeferred) = 2
    THEN 1 ELSE 0 END), 1
  UNION ALL SELECT 13, (SELECT (SELECT count(*) FROM "ServicePart") + (SELECT count(*) FROM "ServicePartEvent")), 0
  UNION ALL SELECT 14, (SELECT count(*) FROM pg_proc WHERE proname IN ('service_erase_business', 'service_external_erase_business')
      AND pronamespace = 'public'::regnamespace AND prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path=pg_catalog, public, pg_temp'
      AND prosrc NOT LIKE '%ServicePart%'), 2
  UNION ALL SELECT 15, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261115090000_service_parts' AND checksum = '1714548c431d7feb94d75e2b104e21c3c293551a9b4a27ae8e93790606b556bc'), 1
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
