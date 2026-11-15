-- ============================================================================
-- service-parts-reservation-guard-production-evidence.sql
--
-- Read-only PROOF after migration 20261128090000_service_parts_reservation_guard:
--   * it is recorded and finished, with the checksum of the reviewed migration.sql (pinned below);
--   * its two functions exist, SECURITY INVOKER, search_path pg_catalog, public, pg_temp, no PUBLIC EXECUTE;
--   * G1 "ServiceCase_parts_released_on_cancel" is an enabled DEFERRABLE INITIALLY DEFERRED constraint trigger on
--     ServiceCase bound to its function; G2 "ServicePart_takes_stock_on_live_case" an enabled, immediate row trigger
--     on ServicePart bound to its function;
--   * the M2 guards it builds on are still in place and enabled;
--   * no part line of a cancelled case is RESERVED; the ledger is clean.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== service parts reservation guard proof: legend (n -> check) =='
\echo ' 1 20261128090000_service_parts_reservation_guard is recorded, finished, not rolled back'
\echo ' 2 its ledger checksum is the reviewed migration.sql'
\echo ' 3 both functions: SECURITY INVOKER, search_path pg_catalog, public, pg_temp (of 2)'
\echo ' 4 PUBLIC may run none of them'
\echo ' 5 G1: enabled, deferrable, initially deferred, a constraint trigger on ServiceCase, its function'
\echo ' 6 G2: enabled, not deferrable, an after-row trigger on ServicePart, its function'
\echo ' 7 the M2 guards are in place and enabled (of 3)'
\echo ' 8 RESERVED part lines of a cancelled case (must be 0)'
\echo ' 9 ledger: no unfinished and no rolled-back row'

WITH c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261128090000_service_parts_reservation_guard'
                    AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS observed, 1 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261128090000_service_parts_reservation_guard'
                         AND checksum = '071fc09a7a9d715d9c5b63e76c137e155d64d3b8169d6d753b209df9b8888c45'), 1
  UNION ALL SELECT 3, (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                         AND proname IN ('service_part_takes_stock_guard', 'service_case_parts_released_on_cancel')
                         AND NOT prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']), 2
  UNION ALL SELECT 4, (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                         AND proname IN ('service_part_takes_stock_guard', 'service_case_parts_released_on_cancel')
                         AND has_function_privilege('public', oid, 'EXECUTE')), 0
  UNION ALL SELECT 5, (SELECT count(*) FROM pg_trigger t JOIN pg_class k ON k.oid = t.tgrelid JOIN pg_proc f ON f.oid = t.tgfoid
                        WHERE t.tgname = 'ServiceCase_parts_released_on_cancel' AND k.relname = 'ServiceCase' AND k.relnamespace = 'public'::regnamespace
                          AND f.proname = 'service_case_parts_released_on_cancel' AND t.tgconstraint <> 0
                          AND t.tgdeferrable AND t.tginitdeferred AND t.tgenabled = 'O' AND t.tgtype = 17), 1
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_trigger t JOIN pg_class k ON k.oid = t.tgrelid JOIN pg_proc f ON f.oid = t.tgfoid
                        WHERE t.tgname = 'ServicePart_takes_stock_on_live_case' AND k.relname = 'ServicePart' AND k.relnamespace = 'public'::regnamespace
                          AND f.proname = 'service_part_takes_stock_guard' AND NOT t.tgdeferrable AND t.tgenabled = 'O' AND t.tgtype = 17), 1
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_trigger WHERE tgenabled = 'O'
                         AND tgname IN ('ServicePart_guard', 'ServicePart_has_event', 'ServiceCase_parts_resolved_on_close')), 3
  UNION ALL SELECT 8, (SELECT count(*) FROM "ServicePart" p JOIN "ServiceCase" s ON s."id" = p."caseId" AND s."businessId" = p."businessId"
                        WHERE p."state" = 'RESERVED' AND (s."outcome"::text = 'CANCELLED' OR s."cancellationRequested")), 0
  UNION ALL SELECT 9, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL), 0
)
SELECT n,
       CASE WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
