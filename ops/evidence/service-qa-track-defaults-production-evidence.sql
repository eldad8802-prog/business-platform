-- ============================================================================
-- service-qa-track-defaults-production-evidence.sql
--
-- Read-only EVIDENCE after migration 20261130100000_service_qa_track_defaults was applied.
--
-- Proves:
--   * the migration is recorded once, finished, not rolled back; the ledger is clean;
--   * the table ServiceQaTrackDefault: ENABLE + FORCE RLS, exactly three tenant policies (read, append, change for the
--     owner-run erasure; never a removal policy, never an all-commands policy), the runtime table ACL exactly "ar"
--     (append + read), nothing for PUBLIC; its three triggers; its six CHECKs / keys of note;
--   * the two functions: search_path ending in pg_temp, exactly one SECURITY DEFINER (the erase), none executable by
--     PUBLIC, the erase executable by app_runtime;
--   * informational counts: defaults rows (0 until the code ships), businesses with a default.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== service desk QA track defaults evidence: legend (n -> check) =='
\echo ' 1 the migration is recorded once, finished, not rolled back'
\echo ' 2 ledger: no unfinished and no rolled-back row'
\echo ' 3 the table has ENABLE and FORCE row level security'
\echo ' 4 it has exactly three tenant policies: read, append, change'
\echo ' 5 the table ACL gives app_runtime exactly ar'
\echo ' 6 the table ACL gives PUBLIC nothing (expected 0)'
\echo ' 7 its three triggers exist (of 3)'
\echo ' 8 its named constraints exist (of 6)'
\echo ' 9 its three unique keys lead with businessId (of 3)'
\echo '10 the two functions with search_path ending in pg_temp (of 2)'
\echo '11 exactly one of them is SECURITY DEFINER: the erase (1)'
\echo '12 none of them executable by PUBLIC (expected 0)'
\echo '13 the erase function is executable by app_runtime'
\echo '14 default rows (informational; 0 until the code ships)'
\echo '15 businesses with a default row (informational)'

WITH k AS (SELECT c.oid, c.relrowsecurity, c.relforcerowsecurity, coalesce(c.relacl::text, '') AS acl FROM pg_class c
            WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'ServiceQaTrackDefault'),
     f AS (SELECT p.oid, p.proname, p.prosecdef, p.proconfig FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN
      ('service_qa_track_default_guard', 'service_qa_track_defaults_erase_business')),
c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261130100000_service_qa_track_defaults'
                    AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS observed, 1 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM k WHERE relrowsecurity AND relforcerowsecurity), 1
  UNION ALL SELECT 4, (SELECT count(*) FROM k
                        WHERE (SELECT string_agg(p.polcmd::text, '' ORDER BY p.polcmd::text) FROM pg_policy p WHERE p.polrelid = k.oid) = 'arw'
                          AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = k.oid
                                           AND position('current_business_id' IN coalesce(pg_get_expr(p.polqual, p.polrelid), '') || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) = 0)), 1
  UNION ALL SELECT 5, (SELECT count(*) FROM k WHERE position('app_runtime=ar/' IN acl) > 0), 1
  UNION ALL SELECT 6, (SELECT count(*) FROM k WHERE acl ~ '(^|[{,])=[a-zA-Z]'), 0
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_trigger g JOIN k ON k.oid = g.tgrelid WHERE NOT g.tgisinternal AND g.tgname IN
      ('ServiceQaTrackDefault_user_same_business', 'ServiceQaTrackDefault_guard', 'ServiceQaTrackDefault_no_truncate')), 3
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_constraint WHERE convalidated AND conname IN
      ('ServiceQaTrackDefault_track', 'ServiceQaTrackDefault_revision', 'ServiceQaTrackDefault_first_names_list',
       'ServiceQaTrackDefault_by_owner', 'ServiceQaTrackDefault_tokens', 'ServiceQaTrackDefault_list_tenant_fkey')), 6
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname IN
      ('ServiceQaTrackDefault_businessId_id_key', 'ServiceQaTrackDefault_businessId_track_revision_key', 'ServiceQaTrackDefault_businessId_idempotencyKey_key')
       AND indexdef LIKE '%UNIQUE%("businessId",%'), 3
  UNION ALL SELECT 10, (SELECT count(*) FROM f WHERE EXISTS (SELECT 1 FROM unnest(proconfig) s WHERE s LIKE 'search_path=%pg_temp')), 2
  UNION ALL SELECT 11, (SELECT count(*) FROM f WHERE prosecdef AND proname = 'service_qa_track_defaults_erase_business')
                       - (SELECT count(*) FROM f WHERE prosecdef AND proname <> 'service_qa_track_defaults_erase_business'), 1
  UNION ALL SELECT 12, (SELECT count(*) FROM f WHERE has_function_privilege('public', oid, 'EXECUTE')), 0
  UNION ALL SELECT 13, (SELECT count(*) FROM f WHERE proname = 'service_qa_track_defaults_erase_business' AND has_function_privilege('app_runtime', oid, 'EXECUTE')), 1
  UNION ALL SELECT 14, (SELECT count(*) FROM "ServiceQaTrackDefault"), NULL
  UNION ALL SELECT 15, (SELECT count(DISTINCT "businessId") FROM "ServiceQaTrackDefault"), NULL
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
