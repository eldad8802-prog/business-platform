-- ============================================================================
-- service-desk-case-fields-production-evidence.sql — read-only EVIDENCE after
--   20261214090000_service_desk_case_fields was applied. Catalog, ledger and counts only. Guard-clean.
-- OUTPUT: n | result | observed_count.
-- ============================================================================
\echo '== service desk case fields evidence: legend (n -> check) =='
\echo ' 1 20261214090000_service_desk_case_fields recorded once, finished, not rolled back'
\echo ' 2 ledger: no unfinished and no rolled-back row'
\echo ' 3 ServiceCase.estimatedReadyOn (date) and itemLocationNote (text) exist, both nullable'
\echo ' 4 ServiceCase_item_location_note CHECK exists, validated'
\echo ' 5 ServiceCaseLoaner exists with RLS enabled and forced'
\echo ' 6 ServiceCaseLoaner has exactly its three tenant policies (read, add, change)'
\echo ' 7 the guard trigger ServiceCaseLoaner_guard exists and is enabled'
\echo ' 8 service_case_fields_erase_business is SECURITY DEFINER with a pinned search_path'
\echo ' 9 app_runtime holds exactly arw (read, add, change) on ServiceCaseLoaner, and no other role holds anything'
\echo '10 Task.serviceCaseId exists (nullable) with the composite FK to ServiceCase'
\echo '11 loans recorded (informational)'
\echo '12 tasks linked to a case (informational)'
WITH t AS (SELECT k.oid, k.relrowsecurity, k.relforcerowsecurity FROM pg_class k WHERE k.relnamespace = 'public'::regnamespace AND k.relname = 'ServiceCaseLoaner'),
c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261214090000_service_desk_case_fields' AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS observed, 1 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ServiceCase' AND is_nullable = 'YES'
                         AND ((column_name = 'estimatedReadyOn' AND data_type = 'date') OR (column_name = 'itemLocationNote' AND data_type = 'text'))), 2
  UNION ALL SELECT 4, (SELECT count(*) FROM pg_constraint WHERE conname = 'ServiceCase_item_location_note' AND convalidated), 1
  UNION ALL SELECT 5, (SELECT count(*) FROM t WHERE relrowsecurity AND relforcerowsecurity), 1
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_policy y JOIN t ON y.polrelid = t.oid
                         WHERE (y.polname = 'service_case_loaner_tenant_select' AND y.polcmd = 'r')
                            OR (y.polname = 'service_case_loaner_tenant_insert' AND y.polcmd = 'a')
                            OR (y.polname = 'service_case_loaner_tenant_update' AND y.polcmd = 'w'))
                     + (SELECT 10 * (count(*) - 3) FROM pg_policy y JOIN t ON y.polrelid = t.oid), 3
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_trigger g JOIN t ON g.tgrelid = t.oid WHERE g.tgname = 'ServiceCaseLoaner_guard' AND g.tgenabled = 'O'), 1
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'service_case_fields_erase_business' AND prosecdef
                         AND array_to_string(proconfig, ',') LIKE '%search_path=%'), 1
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_class k WHERE k.relnamespace = 'public'::regnamespace AND k.relname = 'ServiceCaseLoaner'
                         AND k.relacl::text LIKE '%app_runtime=arw/%')
                     + (SELECT 10 * count(*) FROM pg_class k CROSS JOIN LATERAL aclexplode(k.relacl) x
                         WHERE k.relnamespace = 'public'::regnamespace AND k.relname = 'ServiceCaseLoaner'
                           AND x.grantee <> k.relowner AND x.grantee <> 'app_runtime'::regrole), 1
  UNION ALL SELECT 10, (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Task' AND column_name = 'serviceCaseId' AND is_nullable = 'YES')
                     + (SELECT count(*) FROM pg_constraint WHERE conname = 'Task_service_case_fkey' AND contype = 'f'), 2
  UNION ALL SELECT 11, (SELECT count(*) FROM "ServiceCaseLoaner"), NULL
  UNION ALL SELECT 12, (SELECT count(*) FROM "Task" WHERE "serviceCaseId" IS NOT NULL), NULL
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
