-- ============================================================================
-- service-desk-foundation-preflight.sql
--
-- Read-only PREFLIGHT for migration
--   20261112090000_service_desk_foundation   (NOT applied)
--
-- Measures the premises the migration's outcome depends on:
--   * the ledger is clean, this migration is not recorded, nothing sorting after it was applied first;
--   * none of the names it introduces exists yet: seven tables, eleven types, twelve functions;
--   * what it builds on is there: app_runtime (NOLOGIN NOSUPERUSER NOBYPASSRLS), the "Customer" and "StaffMember"
--     (businessId, id) keys its composite references target, the btree_gist extension its exclusion uses, and
--     "BillingDocument" under RLS enabled + forced (the quote guard reads it as the invoker);
--   * the role that owns "Business" (the migration role, which will own the new objects) carries BYPASSRLS or is a
--     superuser.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog and ledger only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== service desk foundation preflight: legend (n -> check) =='
\echo ' 1 ledger: no unfinished and no rolled-back row (observed = such rows)'
\echo ' 2 20261112090000_service_desk_foundation is NOT recorded'
\echo ' 3 no finished migration sorts after it'
\echo ' 4 none of the seven Service tables exists yet'
\echo ' 5 none of the eleven Service types exists yet'
\echo ' 6 none of the twelve service_ functions exists yet'
\echo ' 7 app_runtime exists NOLOGIN NOSUPERUSER NOBYPASSRLS'
\echo ' 8 the Customer (businessId, id) key exists'
\echo ' 9 a unique index on StaffMember (businessId, id) exists'
\echo '10 the btree_gist extension is installed'
\echo '11 BillingDocument: RLS enabled and forced'
\echo '12 the owner of Business (the migration role) carries BYPASSRLS or is a superuser'
\echo '13 finished migrations in the ledger (informational)'

WITH c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) AS observed, 0 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261112090000_service_desk_foundation'), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name > '20261112090000_service_desk_foundation' AND finished_at IS NOT NULL), 0
  UNION ALL SELECT 4, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace
      AND relname IN ('ServiceCaseNumberSequence','ServiceDevice','ServiceCase','ServiceCaseIntake','ServiceQuote','ServiceCaseEvent','ServiceHandover')), 0
  UNION ALL SELECT 5, (SELECT count(*) FROM pg_type WHERE typnamespace = 'public'::regnamespace
      AND typname IN ('ServiceCaseKind','ServiceCaseStatus','ServiceHoldReason','ServiceOutcome','ServiceCoverageSource',
                      'ServiceCoverageDecision','ServiceQuoteState','ServiceQuoteApprovalMethod','ServiceActor','ServiceCaseAction','ServiceEventType')), 0
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
      AND proname IN ('service_user_same_business','service_case_guard','service_device_guard','service_intake_guard',
                      'service_quote_billing_document_guard','service_quote_guard','service_event_matches_case','service_case_opening_guard',
                      'service_event_append_only_guard','service_journal_truncate_guard','service_handover_guard','service_erase_business')), 0
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls), 1
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_constraint WHERE conname = 'Customer_businessId_id_key'), 1
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid
      WHERE t.relname = 'StaffMember' AND t.relnamespace = 'public'::regnamespace AND i.indisunique
        AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a WHERE a.attrelid = t.oid AND a.attnum = ANY(i.indkey)) = ARRAY['businessId','id']), 1
  UNION ALL SELECT 10, (SELECT count(*) FROM pg_extension WHERE extname = 'btree_gist'), 1
  UNION ALL SELECT 11, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = 'BillingDocument' AND relrowsecurity AND relforcerowsecurity), 1
  UNION ALL SELECT 12, (SELECT count(*) FROM pg_class t JOIN pg_roles r ON r.oid = t.relowner
      WHERE t.relnamespace = 'public'::regnamespace AND t.relname = 'Business' AND (r.rolbypassrls OR r.rolsuper)), 1
  UNION ALL SELECT 13, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL), NULL
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
