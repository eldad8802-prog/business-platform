-- ============================================================================
-- service-desk-qa-lists-production-evidence.sql
--
-- Read-only EVIDENCE after migration 20261129090000_service_desk_qa_lists was applied.
--
-- Proves:
--   * the migration is recorded once, finished, not rolled back; the ledger is clean;
--   * the two enum values exist; the CHECK ServiceCaseEvent_qa_list_in_place exists and is validated;
--   * the six tables: ENABLE + FORCE RLS, exactly three tenant policies each (read, append, change; never a removal
--     policy, never an all-commands policy), the runtime table ACL exactly "arw" on the list head and "ar" (append +
--     read) on the five others, nothing for PUBLIC; their 18 triggers and the three on ServiceCase;
--   * the fourteen functions: search_path ending in pg_temp, exactly one SECURITY DEFINER (the erase), none executable
--     by PUBLIC, the erase executable by app_runtime;
--   * ServiceCase.qaListId / qaListVersion exist and are nullable;
--   * informational counts: lists, QA records, cases naming a list (all expected 0 until the code ships).
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== service desk QA lists evidence: legend (n -> check) =='
\echo ' 1 the migration is recorded once, finished, not rolled back'
\echo ' 2 ledger: no unfinished and no rolled-back row'
\echo ' 3 the two new enum values exist (of 2)'
\echo ' 4 the CHECK ServiceCaseEvent_qa_list_in_place exists and is validated'
\echo ' 5 the six tables have ENABLE and FORCE row level security (of 6)'
\echo ' 6 each has exactly three tenant policies: read, append, change (of 6)'
\echo ' 7 the table ACL gives app_runtime arw on the head and ar on the five others (of 6)'
\echo ' 8 the table ACL gives PUBLIC nothing (expected 0 tables)'
\echo ' 9 the 18 triggers of the six tables exist (of 18)'
\echo '10 the three ServiceCase triggers exist (of 3)'
\echo '11 the fourteen functions with search_path ending in pg_temp (of 14)'
\echo '12 exactly one of them is SECURITY DEFINER: the erase (1)'
\echo '13 none of them executable by PUBLIC (expected 0)'
\echo '14 the erase function is executable by app_runtime'
\echo '15 ServiceCase.qaListId and qaListVersion exist and are nullable (of 2)'
\echo '16 QA lists (informational; 0 until the code ships)'
\echo '17 QA records (informational; 0 until the code ships)'
\echo '18 cases naming a QA list (informational; 0 until the code ships)'

WITH t(name) AS (VALUES ('ServiceQaList'), ('ServiceQaListVersion'), ('ServiceQaListItem'), ('ServiceQaListEvent'), ('ServiceCaseQaRecord'), ('ServiceCaseQaItemResult')),
     k AS (SELECT c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity, coalesce(c.relacl::text, '') AS acl FROM pg_class c JOIN t ON t.name = c.relname
            WHERE c.relnamespace = 'public'::regnamespace),
     f AS (SELECT p.oid, p.proname, p.prosecdef, p.proconfig FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN
      ('service_qa_in_erasure', 'service_qa_list_guard', 'service_qa_list_journaled', 'service_qa_list_version_guard',
       'service_qa_list_version_complete', 'service_qa_list_item_guard', 'service_qa_list_event_guard', 'service_case_qa_list_guard',
       'service_case_qa_list_journaled', 'service_case_qa_completion_matches', 'service_case_qa_record_guard',
       'service_case_qa_record_matches', 'service_case_qa_result_guard', 'service_qa_lists_erase_business')),
c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261129090000_service_desk_qa_lists'
                    AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS observed, 1 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM pg_enum e JOIN pg_type ty ON ty.oid = e.enumtypid
                        WHERE (ty.typname = 'ServiceEventType' AND e.enumlabel = 'qa.list_chosen')
                           OR (ty.typname = 'ServiceCaseAction' AND e.enumlabel = 'CHOOSE_QA_LIST')), 2
  UNION ALL SELECT 4, (SELECT count(*) FROM pg_constraint WHERE conname = 'ServiceCaseEvent_qa_list_in_place' AND convalidated), 1
  UNION ALL SELECT 5, (SELECT count(*) FROM k WHERE relrowsecurity AND relforcerowsecurity), 6
  UNION ALL SELECT 6, (SELECT count(*) FROM k
                        WHERE (SELECT string_agg(p.polcmd::text, '' ORDER BY p.polcmd::text) FROM pg_policy p WHERE p.polrelid = k.oid) = 'arw'
                          AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = k.oid
                                           AND position('current_business_id' IN coalesce(pg_get_expr(p.polqual, p.polrelid), '') || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) = 0)), 6
  UNION ALL SELECT 7, (SELECT count(*) FROM k WHERE (relname = 'ServiceQaList' AND position('app_runtime=arw/' IN acl) > 0)
                                              OR (relname <> 'ServiceQaList' AND position('app_runtime=ar/' IN acl) > 0)), 6
  UNION ALL SELECT 8, (SELECT count(*) FROM k WHERE acl ~ '(^|[{,])=[a-zA-Z]'), 0
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_trigger g JOIN k ON k.oid = g.tgrelid WHERE NOT g.tgisinternal AND g.tgname IN
      ('ServiceQaList_guard', 'ServiceQaList_no_truncate', 'ServiceQaList_journaled',
       'ServiceQaListVersion_user_same_business', 'ServiceQaListVersion_guard', 'ServiceQaListVersion_no_truncate', 'ServiceQaListVersion_complete',
       'ServiceQaListItem_guard', 'ServiceQaListItem_no_truncate',
       'ServiceQaListEvent_user_same_business', 'ServiceQaListEvent_guard', 'ServiceQaListEvent_no_truncate',
       'ServiceCaseQaRecord_user_same_business', 'ServiceCaseQaRecord_guard', 'ServiceCaseQaRecord_no_truncate', 'ServiceCaseQaRecord_matches',
       'ServiceCaseQaItemResult_guard', 'ServiceCaseQaItemResult_no_truncate')), 18
  UNION ALL SELECT 10, (SELECT count(*) FROM pg_trigger g WHERE g.tgrelid = 'public."ServiceCase"'::regclass AND NOT g.tgisinternal
                          AND g.tgname IN ('ServiceCase_qa_list_guard', 'ServiceCase_qa_list_journaled', 'ServiceCase_qa_completion_matches')), 3
  UNION ALL SELECT 11, (SELECT count(*) FROM f WHERE EXISTS (SELECT 1 FROM unnest(proconfig) s WHERE s LIKE 'search_path=%pg_temp')), 14
  UNION ALL SELECT 12, (SELECT count(*) FROM f WHERE prosecdef AND proname = 'service_qa_lists_erase_business')
                       - (SELECT count(*) FROM f WHERE prosecdef AND proname <> 'service_qa_lists_erase_business'), 1
  UNION ALL SELECT 13, (SELECT count(*) FROM f WHERE has_function_privilege('public', oid, 'EXECUTE')), 0
  UNION ALL SELECT 14, (SELECT count(*) FROM f WHERE proname = 'service_qa_lists_erase_business' AND has_function_privilege('app_runtime', oid, 'EXECUTE')), 1
  UNION ALL SELECT 15, (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ServiceCase'
                          AND column_name IN ('qaListId', 'qaListVersion') AND is_nullable = 'YES'), 2
  UNION ALL SELECT 16, (SELECT count(*) FROM "ServiceQaList"), NULL
  UNION ALL SELECT 17, (SELECT count(*) FROM "ServiceCaseQaRecord"), NULL
  UNION ALL SELECT 18, (SELECT count(*) FROM "ServiceCase" WHERE "qaListId" IS NOT NULL), NULL
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
