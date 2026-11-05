-- ============================================================================
-- service-external-work-preflight.sql
--
-- Read-only PREFLIGHT before migration
--   20261113090000_service_external_work   (NOT applied)
--
-- Proves Production is the shape the migration expects:
--   * the ledger is clean; this migration is not recorded; nothing after it is finished;
--   * the Service Desk foundation (20261112090000) is recorded and finished;
--   * the leads migration 20261110100000 (#953) is recorded and finished — it sorts BEFORE this one, so while it is
--     pending the release gate's PREFIX INVARIANT refuses expected=[this migration] anyway; check 13 makes that
--     visible before anyone asks for the release (a combined release of both is not this track's plan);
--   * none of the names it introduces exists yet: two tables, four types, eight functions;
--   * app_runtime exists NOLOGIN NOSUPERUSER NOBYPASSRLS;
--   * the (businessId, id) keys of Supplier, StaffMember, ServiceCase and ServiceDevice exist;
--   * Supplier is under RLS (enabled + forced);
--   * the owner of Business (the migration role) carries BYPASSRLS or is a superuser;
--   * the number of finished migrations (informational).
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== service external work preflight: legend (n -> check) =='
\echo ' 1 ledger: no unfinished and no rolled-back row'
\echo ' 2 20261113090000_service_external_work is NOT recorded'
\echo ' 3 no finished migration sorts after it'
\echo ' 4 the Service Desk foundation 20261112090000 is recorded and finished'
\echo ' 5 neither of the two new tables exists yet'
\echo ' 6 none of the four new types exists yet'
\echo ' 7 none of the eight new functions exists yet'
\echo ' 8 app_runtime exists NOLOGIN NOSUPERUSER NOBYPASSRLS'
\echo ' 9 the (businessId, id) keys of Supplier, StaffMember, ServiceCase, ServiceDevice exist (of 4)'
\echo '10 Supplier: RLS enabled and forced'
\echo '11 the owner of Business carries BYPASSRLS or is a superuser'
\echo '12 finished migrations in the ledger (informational)'
\echo '13 the leads migration 20261110100000_acquisition_resolve_paused_hold (#953) is recorded and finished'

WITH c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) AS observed, 0 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261113090000_service_external_work'), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name > '20261113090000_service_external_work' AND finished_at IS NOT NULL), 0
  UNION ALL SELECT 4, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261112090000_service_desk_foundation' AND finished_at IS NOT NULL AND rolled_back_at IS NULL), 1
  UNION ALL SELECT 5, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('ServiceExternalWork', 'ServiceExternalWorkEvent')), 0
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_type WHERE typname IN ('ServiceExternalWorkState', 'ServiceExternalProgress', 'ServiceExternalReturnResult', 'ServiceExternalWorkEventKind')), 0
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
      AND proname IN ('service_external_work_insert_guard', 'service_external_work_guard', 'service_external_work_has_event',
                      'service_external_event_matches_work', 'service_external_event_guard', 'service_handover_no_open_external',
                      'service_case_external_work_closed', 'service_external_erase_business')), 0
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls), 1
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_class WHERE relname IN ('Supplier_businessId_id_key', 'StaffMember_businessId_id_key',
                                                                        'ServiceCase_businessId_id_key', 'ServiceDevice_businessId_id_key')), 4
  UNION ALL SELECT 10, (SELECT count(*) FROM pg_class WHERE relname = 'Supplier' AND relnamespace = 'public'::regnamespace AND relrowsecurity AND relforcerowsecurity), 1
  UNION ALL SELECT 11, (SELECT count(*) FROM pg_class k JOIN pg_roles r ON r.oid = k.relowner
                         WHERE k.relname = 'Business' AND k.relnamespace = 'public'::regnamespace AND (r.rolbypassrls OR r.rolsuper)), 1
  UNION ALL SELECT 12, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL), NULL
  UNION ALL SELECT 13, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261110100000_acquisition_resolve_paused_hold'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL), 1
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
