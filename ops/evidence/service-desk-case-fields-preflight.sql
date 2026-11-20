-- ============================================================================
-- service-desk-case-fields-preflight.sql — read-only PREFLIGHT before migration
--   20261214090000_service_desk_case_fields   (NOT applied)
-- Proves Production is the shape the migration expects. Catalog, ledger and counts only. Guard-clean.
-- OUTPUT: n | result | observed_count.
-- ============================================================================
\echo '== service desk case fields preflight: legend (n -> check) =='
\echo ' 1 ledger: no unfinished and no rolled-back row'
\echo ' 2 20261214090000_service_desk_case_fields is NOT recorded'
\echo ' 3 prerequisite 20261127090000_service_desk_tracks (M1) is recorded and finished'
\echo ' 4 ServiceCase has neither estimatedReadyOn nor itemLocationNote yet'
\echo ' 5 ServiceCaseLoaner does not exist yet'
\echo ' 6 Task has no serviceCaseId yet'
\echo ' 7 the helper service_ui_business_writable exists'
\echo ' 8 the unique key ServiceCase_businessId_id_key exists'
\echo ' 9 role app_runtime exists'
\echo '10 none of the three new functions exists yet'
\echo '11 tasks (informational)'
WITH c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) AS observed, 0 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261214090000_service_desk_case_fields'), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261127090000_service_desk_tracks' AND finished_at IS NOT NULL AND rolled_back_at IS NULL), 1
  UNION ALL SELECT 4, (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ServiceCase' AND column_name IN ('estimatedReadyOn', 'itemLocationNote')), 0
  UNION ALL SELECT 5, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = 'ServiceCaseLoaner'), 0
  UNION ALL SELECT 6, (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Task' AND column_name = 'serviceCaseId'), 0
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'service_ui_business_writable'), 1
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_class WHERE relname = 'ServiceCase_businessId_id_key'), 1
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime'), 1
  UNION ALL SELECT 10, (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                          AND proname IN ('service_case_loaner_in_erasure', 'service_case_loaner_guard', 'service_case_fields_erase_business')), 0
  UNION ALL SELECT 11, (SELECT count(*) FROM "Task"), NULL
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
