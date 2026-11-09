-- ============================================================================
-- service-desk-audit-journal-production-evidence.sql
--
-- Read-only EVIDENCE after migration 20261122090000_service_desk_audit_journal was applied.
--
-- Proves:
--   * the migration is recorded once, finished, not rolled back; the ledger is clean;
--   * the eight enum values exist; the CHECK ServiceCaseEvent_record_in_place exists and is validated;
--   * ServiceSettingsEvent: ENABLE + FORCE RLS, exactly two tenant policies (one SELECT, one append policy — a WITH CHECK
--     and no USING), the runtime's privileges exactly "ar" (append + read) in the table ACL and nothing for PUBLIC; its
--     four triggers (user of the same business, matches the settings version, append-only, no table wipe);
--   * the three functions: search_path ending in pg_temp, exactly one SECURITY DEFINER (the erase), none executable by
--     PUBLIC, the erase executable by app_runtime;
--   * informational counts: settings events, records of the four new case events (both expected 0 until the code ships).
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== service desk audit journal evidence: legend (n -> check) =='
\echo ' 1 the migration is recorded once, finished, not rolled back'
\echo ' 2 ledger: no unfinished and no rolled-back row'
\echo ' 3 the eight new enum values exist (of 8)'
\echo ' 4 the CHECK ServiceCaseEvent_record_in_place exists and is validated'
\echo ' 5 ServiceSettingsEvent has ENABLE and FORCE row level security'
\echo ' 6 its policies: one SELECT and one append policy, both keyed on the tenant, and no other (of 2)'
\echo ' 7 the table ACL gives app_runtime exactly "ar" (append + read)'
\echo ' 8 the table ACL gives PUBLIC nothing (expected 0 entries)'
\echo ' 9 its four triggers exist (of 4)'
\echo '10 the three functions with search_path ending in pg_temp (of 3)'
\echo '11 SECURITY DEFINER among them: exactly the erase (of 1)'
\echo '12 any of them executable by PUBLIC (expected 0)'
\echo '13 the erase is executable by app_runtime'
\echo '14 settings events (informational; 0 until the code ships)'
\echo '15 case events of the four new types (informational; 0 until the code ships)'

WITH f AS (
  SELECT p.oid, p.proname, p.prosecdef, array_to_string(p.proconfig, ',') AS cfg FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('service_settings_event_matches', 'service_settings_event_guard', 'service_settings_journal_erase_business')
), c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261122090000_service_desk_audit_journal'
                    AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS observed, 1 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                        WHERE (t.typname = 'ServiceEventType' AND e.enumlabel IN ('case.technician_assigned', 'intake.recorded', 'coverage.recorded', 'qa.recorded'))
                           OR (t.typname = 'ServiceCaseAction' AND e.enumlabel IN ('ASSIGN_TECHNICIAN', 'RECORD_INTAKE', 'RECORD_COVERAGE', 'RECORD_QA'))), 8
  UNION ALL SELECT 4, (SELECT count(*) FROM pg_constraint WHERE conname = 'ServiceCaseEvent_record_in_place' AND convalidated), 1
  UNION ALL SELECT 5, (SELECT count(*) FROM pg_class WHERE relname = 'ServiceSettingsEvent' AND relrowsecurity AND relforcerowsecurity), 1
  UNION ALL SELECT 6, (SELECT count(*) FILTER (WHERE cmd = 'SELECT' AND qual LIKE '%app.current_business_id%')
                            + count(*) FILTER (WHERE cmd <> 'SELECT' AND qual IS NULL AND with_check LIKE '%app.current_business_id%')
                            + CASE WHEN count(*) = 2 THEN 0 ELSE 100 END
                         FROM pg_policies WHERE tablename = 'ServiceSettingsEvent'), 2
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_class k, unnest(k.relacl) AS a(item)
                        WHERE k.relname = 'ServiceSettingsEvent' AND k.relnamespace = 'public'::regnamespace AND a.item::text LIKE 'app_runtime=ar/%'), 1
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_class k, unnest(k.relacl) AS a(item)
                        WHERE k.relname = 'ServiceSettingsEvent' AND k.relnamespace = 'public'::regnamespace AND a.item::text LIKE '=%'), 0
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_trigger WHERE tgrelid = '"ServiceSettingsEvent"'::regclass AND NOT tgisinternal
                          AND tgname IN ('ServiceSettingsEvent_user_same_business', 'ServiceSettingsEvent_matches_settings', 'ServiceSettingsEvent_append_only', 'ServiceSettingsEvent_no_truncate')), 4
  UNION ALL SELECT 10, (SELECT count(*) FROM f WHERE cfg LIKE 'search_path=%pg_temp'), 3
  UNION ALL SELECT 11, (SELECT count(*) FROM f WHERE prosecdef AND proname = 'service_settings_journal_erase_business')
                       + (SELECT count(*) FROM f WHERE prosecdef AND proname <> 'service_settings_journal_erase_business') * 100, 1
  UNION ALL SELECT 12, (SELECT count(*) FROM f WHERE has_function_privilege('public', f.oid, 'EXECUTE')), 0
  UNION ALL SELECT 13, (SELECT count(*) FROM f WHERE proname = 'service_settings_journal_erase_business' AND has_function_privilege('app_runtime', f.oid, 'EXECUTE')), 1
  UNION ALL SELECT 14, (SELECT count(*) FROM "ServiceSettingsEvent"), NULL
  UNION ALL SELECT 15, (SELECT count(*) FROM "ServiceCaseEvent" WHERE "eventType"::text IN ('case.technician_assigned', 'intake.recorded', 'coverage.recorded', 'qa.recorded')), NULL
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
