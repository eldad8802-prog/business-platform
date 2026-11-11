-- ============================================================================
-- service-qa-track-defaults-preflight.sql
--
-- Read-only PREFLIGHT before migration
--   20261130100000_service_qa_track_defaults   (NOT applied)
--
-- Proves Production is the shape the migration expects:
--   * the ledger is clean; this migration is not recorded; nothing after it is finished;
--   * the QA lists migration (20261129090000_service_desk_qa_lists) is recorded and finished: its list head table,
--     its composite key and its erasure marker helper are the premise;
--   * none of the names it introduces exists yet: the table, the two functions;
--   * the foundation functions it reuses exist (service_user_same_business, service_journal_truncate_guard,
--     service_ui_business_writable, service_qa_in_erasure);
--   * app_runtime exists NOLOGIN NOSUPERUSER NOBYPASSRLS; the owner of Business carries BYPASSRLS or is a superuser;
--   * informational: finished migrations, QA lists.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== service desk QA track defaults preflight: legend (n -> check) =='
\echo ' 1 ledger: no unfinished and no rolled-back row'
\echo ' 2 20261130100000_service_qa_track_defaults is NOT recorded'
\echo ' 3 no finished migration sorts after it'
\echo ' 4 the QA lists migration 20261129090000 is recorded and finished'
\echo ' 5 the QA list head table and its composite key exist (of 2)'
\echo ' 6 the table ServiceQaTrackDefault is not there yet'
\echo ' 7 none of the two new functions exists yet'
\echo ' 8 the functions it reuses exist (of 4)'
\echo ' 9 app_runtime exists NOLOGIN NOSUPERUSER NOBYPASSRLS'
\echo '10 the owner of Business carries BYPASSRLS or is a superuser'
\echo '11 finished migrations in the ledger (informational)'
\echo '12 QA lists (informational)'

WITH c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) AS observed, 0 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261130100000_service_qa_track_defaults'), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name > '20261130100000_service_qa_track_defaults' AND finished_at IS NOT NULL), 0
  UNION ALL SELECT 4, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261129090000_service_desk_qa_lists'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL), 1
  UNION ALL SELECT 5, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace
                          AND relname IN ('ServiceQaList', 'ServiceQaList_businessId_id_key')), 2
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = 'ServiceQaTrackDefault'), 0
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN
      ('service_qa_track_default_guard', 'service_qa_track_defaults_erase_business')), 0
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
      AND proname IN ('service_user_same_business', 'service_journal_truncate_guard', 'service_ui_business_writable', 'service_qa_in_erasure')), 4
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls), 1
  UNION ALL SELECT 10, (SELECT count(*) FROM pg_class k JOIN pg_roles r ON r.oid = k.relowner
                         WHERE k.relname = 'Business' AND k.relnamespace = 'public'::regnamespace AND (r.rolbypassrls OR r.rolsuper)), 1
  UNION ALL SELECT 11, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL), NULL
  UNION ALL SELECT 12, (SELECT count(*) FROM "ServiceQaList"), NULL
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
