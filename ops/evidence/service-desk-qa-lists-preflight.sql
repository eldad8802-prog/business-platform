-- ============================================================================
-- service-desk-qa-lists-preflight.sql
--
-- Read-only PREFLIGHT before migration
--   20261129090000_service_desk_qa_lists   (NOT applied)
--
-- Proves Production is the shape the migration expects:
--   * the ledger is clean; this migration is not recorded; nothing after it is finished;
--   * M1 (20261127090000_service_desk_tracks) is recorded and finished — its CHECK is a premise of this migration;
--   * none of the names it introduces exists yet: the two enum values, the CHECK, the six tables, the two types, the
--     fourteen functions, the two ServiceCase columns;
--   * the foundation functions it reuses exist (service_user_same_business, service_journal_truncate_guard,
--     service_ui_business_writable); the two journal CHECKs it requires exist;
--   * app_runtime exists NOLOGIN NOSUPERUSER NOBYPASSRLS; the owner of Business carries BYPASSRLS or is a superuser;
--   * informational: finished migrations, service cases.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== service desk QA lists preflight: legend (n -> check) =='
\echo ' 1 ledger: no unfinished and no rolled-back row'
\echo ' 2 20261129090000_service_desk_qa_lists is NOT recorded'
\echo ' 3 no finished migration sorts after it'
\echo ' 4 M1 20261127090000_service_desk_tracks is recorded and finished'
\echo ' 5 none of the two new enum values exists yet'
\echo ' 6 the CHECK ServiceCaseEvent_qa_list_in_place is not there yet'
\echo ' 7 none of the six new tables exists yet'
\echo ' 8 none of the two new enum types exists yet'
\echo ' 9 none of the fourteen new functions exists yet'
\echo '10 ServiceCase has neither qaListId nor qaListVersion yet'
\echo '11 the foundation functions it reuses exist (of 3)'
\echo '12 the journal CHECKs it requires exist (of 2)'
\echo '13 app_runtime exists NOLOGIN NOSUPERUSER NOBYPASSRLS'
\echo '14 the owner of Business carries BYPASSRLS or is a superuser'
\echo '15 finished migrations in the ledger (informational)'
\echo '16 service cases (informational; every one keeps its built-in QA template)'

WITH c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) AS observed, 0 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261129090000_service_desk_qa_lists'), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name > '20261129090000_service_desk_qa_lists' AND finished_at IS NOT NULL), 0
  UNION ALL SELECT 4, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261127090000_service_desk_tracks'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL), 1
  UNION ALL SELECT 5, (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                        WHERE (t.typname = 'ServiceEventType' AND e.enumlabel = 'qa.list_chosen')
                           OR (t.typname = 'ServiceCaseAction' AND e.enumlabel = 'CHOOSE_QA_LIST')), 0
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_constraint WHERE conname = 'ServiceCaseEvent_qa_list_in_place'), 0
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN
      ('ServiceQaList', 'ServiceQaListVersion', 'ServiceQaListItem', 'ServiceQaListEvent', 'ServiceCaseQaRecord', 'ServiceCaseQaItemResult')), 0
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_type WHERE typname IN ('ServiceQaResult', 'ServiceQaListAction')), 0
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN
      ('service_qa_in_erasure', 'service_qa_list_guard', 'service_qa_list_journaled', 'service_qa_list_version_guard',
       'service_qa_list_version_complete', 'service_qa_list_item_guard', 'service_qa_list_event_guard', 'service_case_qa_list_guard',
       'service_case_qa_list_journaled', 'service_case_qa_completion_matches', 'service_case_qa_record_guard',
       'service_case_qa_record_matches', 'service_case_qa_result_guard', 'service_qa_lists_erase_business')), 0
  UNION ALL SELECT 10, (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ServiceCase'
                          AND column_name IN ('qaListId', 'qaListVersion')), 0
  UNION ALL SELECT 11, (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
      AND proname IN ('service_user_same_business', 'service_journal_truncate_guard', 'service_ui_business_writable')), 3
  UNION ALL SELECT 12, (SELECT count(*) FROM pg_constraint WHERE conname IN ('ServiceCaseEvent_record_in_place', 'ServiceCaseEvent_tracks_in_place')), 2
  UNION ALL SELECT 13, (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls), 1
  UNION ALL SELECT 14, (SELECT count(*) FROM pg_class k JOIN pg_roles r ON r.oid = k.relowner
                         WHERE k.relname = 'Business' AND k.relnamespace = 'public'::regnamespace AND (r.rolbypassrls OR r.rolsuper)), 1
  UNION ALL SELECT 15, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL), NULL
  UNION ALL SELECT 16, (SELECT count(*) FROM "ServiceCase"), NULL
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
