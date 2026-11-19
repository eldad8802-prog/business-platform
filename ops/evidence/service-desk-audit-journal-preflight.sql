-- ============================================================================
-- service-desk-audit-journal-preflight.sql
--
-- Read-only PREFLIGHT before migration
--   20261122090000_service_desk_audit_journal   (NOT applied)
--
-- Proves Production is the shape the migration expects:
--   * the ledger is clean; this migration is not recorded; nothing after it is finished;
--   * 1.3-0 (20261120090000_service_desk_ui_foundation) is recorded and finished — the migration extends its journal
--     and reuses its tables;
--   * none of the names it introduces exists yet: the eight enum values, the CHECK, the table, the three functions;
--   * the two enum types it extends exist; the foundation functions it reuses exist (service_user_same_business,
--     service_journal_truncate_guard); ServiceSettings and ServiceCaseEvent exist;
--   * app_runtime exists NOLOGIN NOSUPERUSER NOBYPASSRLS; the owner of Business carries BYPASSRLS or is a superuser;
--   * informational: whether #1026's migration 20261121090000 is recorded (either order is supported — the two touch
--     no common function), and the number of finished migrations.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== service desk audit journal preflight: legend (n -> check) =='
\echo ' 1 ledger: no unfinished and no rolled-back row'
\echo ' 2 20261122090000_service_desk_audit_journal is NOT recorded'
\echo ' 3 no finished migration sorts after it'
\echo ' 4 1.3-0 20261120090000_service_desk_ui_foundation is recorded and finished'
\echo ' 5 none of the eight new enum values exists yet'
\echo ' 6 the CHECK ServiceCaseEvent_record_in_place does not exist yet'
\echo ' 7 ServiceSettingsEvent does not exist yet'
\echo ' 8 none of the three new functions exists yet'
\echo ' 9 the two extended enum types exist (ServiceEventType, ServiceCaseAction)'
\echo '10 the foundation functions it reuses exist (of 2)'
\echo '11 ServiceSettings and ServiceCaseEvent exist (of 2)'
\echo '12 app_runtime exists NOLOGIN NOSUPERUSER NOBYPASSRLS'
\echo '13 the owner of Business carries BYPASSRLS or is a superuser'
\echo '14 #1026 migration 20261121090000_service_desk_ui_erasure_text recorded (informational; either order is supported)'
\echo '15 finished migrations in the ledger (informational)'

WITH c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) AS observed, 0 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261122090000_service_desk_audit_journal'), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name > '20261122090000_service_desk_audit_journal' AND finished_at IS NOT NULL), 0
  UNION ALL SELECT 4, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261120090000_service_desk_ui_foundation'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL), 1
  UNION ALL SELECT 5, (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                        WHERE (t.typname = 'ServiceEventType' AND e.enumlabel IN ('case.technician_assigned', 'intake.recorded', 'coverage.recorded', 'qa.recorded'))
                           OR (t.typname = 'ServiceCaseAction' AND e.enumlabel IN ('ASSIGN_TECHNICIAN', 'RECORD_INTAKE', 'RECORD_COVERAGE', 'RECORD_QA'))), 0
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_constraint WHERE conname = 'ServiceCaseEvent_record_in_place'), 0
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = 'ServiceSettingsEvent'), 0
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
      AND proname IN ('service_settings_event_matches', 'service_settings_event_guard', 'service_settings_journal_erase_business')), 0
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_type WHERE typname IN ('ServiceEventType', 'ServiceCaseAction')), 2
  UNION ALL SELECT 10, (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
      AND proname IN ('service_user_same_business', 'service_journal_truncate_guard')), 2
  UNION ALL SELECT 11, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('ServiceSettings', 'ServiceCaseEvent')), 2
  UNION ALL SELECT 12, (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls), 1
  UNION ALL SELECT 13, (SELECT count(*) FROM pg_class k JOIN pg_roles r ON r.oid = k.relowner
                         WHERE k.relname = 'Business' AND k.relnamespace = 'public'::regnamespace AND (r.rolbypassrls OR r.rolsuper)), 1
  UNION ALL SELECT 14, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261121090000_service_desk_ui_erasure_text' AND finished_at IS NOT NULL), NULL
  UNION ALL SELECT 15, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL), NULL
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
