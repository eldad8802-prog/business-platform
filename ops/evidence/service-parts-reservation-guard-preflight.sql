-- ============================================================================
-- service-parts-reservation-guard-preflight.sql
--
-- Read-only PREFLIGHT before migration
--   20261128090000_service_parts_reservation_guard   (NOT applied)
--
-- Proves Production is the shape the migration expects:
--   * the ledger is clean; this migration is not recorded; no later Service Desk migration is finished (other modules may be);
--   * M2 (20261115090000_service_parts) is recorded and finished — the migration adds two triggers on its tables and
--     reads its guards' case-row convention;
--   * none of the names it introduces exists yet (two functions, two triggers);
--   * the M2 guards it builds on exist;
--   * NO part line of a cancelled case is RESERVED (outcome CANCELLED or a cancel requested) — the migration refuses
--     to apply otherwise; such lines are released by the application first, with their RELEASED events;
--   * app_runtime exists NOLOGIN NOSUPERUSER NOBYPASSRLS and may take the per-item advisory key the guard uses;
--   * informational: whether M1 (20261127090000) is recorded (release-migrate applies the approved prefix in name
--     order), items whose current reservations already exceed what is on hand (the guard judges NEW reservations
--     only), the number of RESERVED lines, the number of finished migrations.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== service parts reservation guard preflight: legend (n -> check) =='
\echo ' 1 ledger: no unfinished and no rolled-back row'
\echo ' 2 20261128090000_service_parts_reservation_guard is NOT recorded'
\echo ' 3 no finished Service Desk migration (name containing _service_) sorts after it; later migrations of other modules are fine'
\echo ' 4 M2 20261115090000_service_parts is recorded and finished'
\echo ' 5 none of the two new functions exists yet'
\echo ' 6 none of the two new triggers exists yet'
\echo ' 7 the M2 guards it builds on exist (of 3)'
\echo ' 8 RESERVED part lines of a cancelled case (must be 0)'
\echo ' 9 app_runtime exists NOLOGIN NOSUPERUSER NOBYPASSRLS'
\echo '10 app_runtime may run pg_advisory_xact_lock(integer, integer)'
\echo '11 M1 20261127090000_service_desk_tracks recorded (informational)'
\echo '12 items whose RESERVED lines already exceed what is on hand (informational; only new reservations are judged)'
\echo '13 RESERVED part lines in all (informational)'
\echo '14 finished migrations in the ledger (informational)'

WITH c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) AS observed, 0 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261128090000_service_parts_reservation_guard'), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name > '20261128090000_service_parts_reservation_guard' AND position('_service_' in migration_name) > 0 AND finished_at IS NOT NULL), 0
  UNION ALL SELECT 4, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261115090000_service_parts'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL), 1
  UNION ALL SELECT 5, (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
      AND proname IN ('service_part_takes_stock_guard', 'service_case_parts_released_on_cancel')), 0
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_trigger WHERE tgname IN ('ServicePart_takes_stock_on_live_case', 'ServiceCase_parts_released_on_cancel')), 0
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('service_part_guard', 'service_case_parts_resolved_on_close'))
                    + (SELECT count(*) FROM pg_trigger t JOIN pg_class k ON k.oid = t.tgrelid
                        WHERE t.tgname = 'ServicePart_guard' AND k.relname = 'ServicePart' AND k.relnamespace = 'public'::regnamespace), 3
  UNION ALL SELECT 8, (SELECT count(*) FROM "ServicePart" p JOIN "ServiceCase" s ON s."id" = p."caseId" AND s."businessId" = p."businessId"
                        WHERE p."state" = 'RESERVED' AND (s."outcome"::text = 'CANCELLED' OR s."cancellationRequested")), 0
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls), 1
  UNION ALL SELECT 10, (SELECT count(*) FROM pg_proc p WHERE p.oid = 'pg_catalog.pg_advisory_xact_lock(integer, integer)'::regprocedure
                         AND EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'app_runtime')
                         AND has_function_privilege('app_runtime', p.oid, 'EXECUTE')), 1
  UNION ALL SELECT 11, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261127090000_service_desk_tracks' AND finished_at IS NOT NULL), NULL
  UNION ALL SELECT 12, (SELECT count(*) FROM (SELECT p."businessId", p."inventoryItemId", sum(p."quantity") AS held FROM "ServicePart" p
                                                WHERE p."state" = 'RESERVED' GROUP BY p."businessId", p."inventoryItemId") r
                          JOIN "InventoryItem" i ON i."id" = r."inventoryItemId" AND i."businessId" = r."businessId"
                         WHERE r.held > i."currentQuantity" + 1e-9), NULL
  UNION ALL SELECT 13, (SELECT count(*) FROM "ServicePart" WHERE "state" = 'RESERVED'), NULL
  UNION ALL SELECT 14, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL), NULL
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
