-- ============================================================================
-- service-parts-preflight.sql
--
-- Read-only PREFLIGHT before migration
--   20261115090000_service_parts   (NOT applied)
--
-- Proves Production is the shape the migration expects:
--   * the ledger is clean; this migration is not recorded; nothing after it is finished;
--   * 1.2b (20261113090000_service_external_work) is recorded and finished — M2 references its work table;
--   * none of the names it introduces exists yet: two tables, five types, eleven functions;
--   * app_runtime exists NOLOGIN NOSUPERUSER NOBYPASSRLS;
--   * the six composite keys it references exist (InventoryItem, InventoryMovement, ServiceCase, ServiceDevice,
--     ServiceQuote, ServiceExternalWork);
--   * InventoryItem, InventoryMovement, PurchaseOrder, PurchaseOrderLine are under RLS (enabled + forced);
--   * the two foundation functions it reuses exist (service_user_same_business, service_journal_truncate_guard);
--   * the owner of Business (the migration role) carries BYPASSRLS or is a superuser;
--   * the number of finished migrations, and whether the M0 reason value exists (both informational: M2 compares the
--     movement reason as text and applies with or without M0; parts are issued only after M0);
--   * the business documents migration 20261114090000 (#980) is recorded and finished — it sorts BEFORE this one, so
--     while it is pending the release gate's PREFIX INVARIANT refuses expected=[this migration] anyway; check 15 makes
--     that visible before anyone asks for the release (as 1.2b's check 13 did for #953). M2 does not use its objects.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== service parts preflight: legend (n -> check) =='
\echo ' 1 ledger: no unfinished and no rolled-back row'
\echo ' 2 20261115090000_service_parts is NOT recorded'
\echo ' 3 no finished migration sorts after it'
\echo ' 4 1.2b 20261113090000_service_external_work is recorded and finished'
\echo ' 5 neither of the two new tables exists yet'
\echo ' 6 none of the five new types exists yet'
\echo ' 7 none of the eleven new functions exists yet'
\echo ' 8 app_runtime exists NOLOGIN NOSUPERUSER NOBYPASSRLS'
\echo ' 9 the composite keys M2 references exist (of 6)'
\echo '10 InventoryItem, InventoryMovement, PurchaseOrder, PurchaseOrderLine: RLS enabled and forced (of 4)'
\echo '11 the foundation functions M2 reuses exist (of 2)'
\echo '12 the owner of Business carries BYPASSRLS or is a superuser'
\echo '13 finished migrations in the ledger (informational)'
\echo '14 the M0 reason value SERVICE_PART exists on InventoryMovementReason (informational; 0 = M0 not released)'
\echo '15 the business documents migration 20261114090000_business_documents_records (#980) is recorded and finished'

WITH c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) AS observed, 0 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261115090000_service_parts'), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name > '20261115090000_service_parts' AND finished_at IS NOT NULL), 0
  UNION ALL SELECT 4, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261113090000_service_external_work' AND finished_at IS NOT NULL AND rolled_back_at IS NULL), 1
  UNION ALL SELECT 5, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('ServicePart', 'ServicePartEvent')), 0
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_type WHERE typname IN ('ServicePartState', 'ServicePartSource', 'ServicePartCostSource',
                                                                     'ServicePartWriteOffReason', 'ServicePartEventKind')), 0
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
      AND proname IN ('service_part_check_movement', 'service_part_check_order', 'service_part_insert_guard', 'service_part_guard',
                      'service_part_has_event', 'service_part_split_reconciles', 'service_part_event_matches_part',
                      'service_part_event_guard', 'service_case_parts_resolved_on_close',
                      'service_external_parts_resolved_on_return', 'service_parts_erase_business')), 0
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls), 1
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_class WHERE relname IN ('InventoryItem_id_businessId_key', 'InventoryMovement_id_businessId_key',
                                                                        'ServiceCase_businessId_id_key', 'ServiceDevice_businessId_id_key',
                                                                        'ServiceQuote_businessId_caseId_version_key', 'ServiceExternalWork_businessId_id_key')), 6
  UNION ALL SELECT 10, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace
      AND relname IN ('InventoryItem', 'InventoryMovement', 'PurchaseOrder', 'PurchaseOrderLine') AND relrowsecurity AND relforcerowsecurity), 4
  UNION ALL SELECT 11, (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
      AND proname IN ('service_user_same_business', 'service_journal_truncate_guard')), 2
  UNION ALL SELECT 12, (SELECT count(*) FROM pg_class k JOIN pg_roles r ON r.oid = k.relowner
                         WHERE k.relname = 'Business' AND k.relnamespace = 'public'::regnamespace AND (r.rolbypassrls OR r.rolsuper)), 1
  UNION ALL SELECT 13, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL), NULL
  UNION ALL SELECT 14, (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                         WHERE t.typname = 'InventoryMovementReason' AND e.enumlabel = 'SERVICE_PART'), NULL
  UNION ALL SELECT 15, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261114090000_business_documents_records'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL), 1
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
