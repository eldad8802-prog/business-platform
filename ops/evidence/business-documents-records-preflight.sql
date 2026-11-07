-- ============================================================================
-- business-documents-records-preflight.sql
--
-- Read-only PREFLIGHT before migration
--   20261114090000_business_documents_records   (pending)
--
-- Proves the ground is what the migration expects, and that it is the ONLY one pending:
--   * the ledger holds no unfinished and no rolled-back row;
--   * the migration is not recorded, and no finished migration sorts after it;
--   * every one of the 208 migrations that sort before it is recorded and finished (so a deploy applies exactly one);
--   * none of its six tables, eight types, twelve functions or its flag rows exists yet;
--   * app_runtime exists NOLOGIN NOSUPERUSER NOBYPASSRLS; the owner of Business carries BYPASSRLS (its definer
--     functions read and remove rows without a policy for removal);
--   * the composite keys its foreign keys target exist: Customer and Supplier (businessId, id);
--   * the billing catalog fingerprint (columns, constraints, indexes, triggers, policies, ACL and RLS of
--     BillingDocument and BillingDocumentLine) is printed as INFO, to be compared with the evidence run after.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== business documents records preflight: legend (n -> check) =='
\echo ' 1 ledger: no unfinished and no rolled-back row'
\echo ' 2 20261114090000_business_documents_records is NOT recorded'
\echo ' 3 no finished migration sorts after it'
\echo ' 4 finished migrations that sort before it (want 208: every one in the repository)'
\echo ' 5 20261113090000_service_external_work is recorded and finished'
\echo ' 6 none of the six new tables exists yet'
\echo ' 7 none of the eight new types exists yet'
\echo ' 8 none of the twelve new functions exists yet'
\echo ' 9 the business_documents flag has no definition, policy or business override row yet'
\echo '10 app_runtime exists NOLOGIN NOSUPERUSER NOBYPASSRLS'
\echo '11 the owner of Business carries BYPASSRLS or is a superuser'
\echo '12 the (businessId, id) keys of Customer and Supplier exist (of 2)'
\echo '13 billing catalog fingerprint (INFO: must equal check 16 of the evidence run)'
\echo '14 finished migrations in the ledger (informational)'

WITH c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) AS observed, 0 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261114090000_business_documents_records'), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name > '20261114090000_business_documents_records' AND finished_at IS NOT NULL), 0
  UNION ALL SELECT 4, (SELECT count(DISTINCT migration_name) FROM "_prisma_migrations"
                        WHERE migration_name < '20261114090000_business_documents_records' AND finished_at IS NOT NULL AND rolled_back_at IS NULL), 208
  UNION ALL SELECT 5, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261113090000_service_external_work'
                        AND finished_at IS NOT NULL AND rolled_back_at IS NULL), 1
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace
      AND relname IN ('BusinessDocumentFile', 'BusinessDocumentRequest', 'QuoteShareCopy', 'QuoteShareEvent', 'BusinessLetter', 'BusinessDocumentErasure')), 0
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_type WHERE typname IN ('BusinessDocumentFilePurpose', 'BusinessDocumentFileState', 'BusinessDocumentOperation',
      'BusinessDocumentRequestState', 'QuoteShareEventKind', 'QuoteShareChannel', 'BusinessLetterRecipientKind', 'BusinessDocumentErasureState')), 0
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
      AND (proname LIKE 'business\_documents\_%' OR proname LIKE 'business\_letter\_%')), 0
  UNION ALL SELECT 9, (SELECT (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE "key" = 'business_documents')
                            + (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'business_documents')
                            + (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'business_documents')), 0
  UNION ALL SELECT 10, (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls), 1
  UNION ALL SELECT 11, (SELECT count(*) FROM pg_class k JOIN pg_roles r ON r.oid = k.relowner
                         WHERE k.relname = 'Business' AND k.relnamespace = 'public'::regnamespace AND (r.rolbypassrls OR r.rolsuper)), 1
  UNION ALL SELECT 12, (SELECT count(*) FROM pg_constraint WHERE conname IN ('Customer_businessId_id_key', 'Supplier_businessId_id_key') AND contype = 'u'), 2
  UNION ALL SELECT 13, (SELECT hashtext(
         coalesce((SELECT string_agg(table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, ''), ',' ORDER BY table_name, ordinal_position)
                     FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('BillingDocument', 'BillingDocumentLine')), '')
      || coalesce((SELECT string_agg(conname || pg_get_constraintdef(oid), ',' ORDER BY conname)
                     FROM pg_constraint WHERE conrelid IN ('public."BillingDocument"'::regclass, 'public."BillingDocumentLine"'::regclass)), '')
      || coalesce((SELECT string_agg(indexdef, ',' ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename IN ('BillingDocument', 'BillingDocumentLine')), '')
      || coalesce((SELECT string_agg(tgname::text || tgenabled::text || tgfoid::regproc::text, ',' ORDER BY tgname)
                     FROM pg_trigger WHERE tgrelid IN ('public."BillingDocument"'::regclass, 'public."BillingDocumentLine"'::regclass)), '')
      || coalesce((SELECT string_agg(polname || polcmd::text, ',' ORDER BY polname)
                     FROM pg_policy WHERE polrelid IN ('public."BillingDocument"'::regclass, 'public."BillingDocumentLine"'::regclass)), '')
      || coalesce((SELECT string_agg(relname || coalesce(relacl::text, '') || relrowsecurity::text || relforcerowsecurity::text, ',' ORDER BY relname)
                     FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('BillingDocument', 'BillingDocumentLine')), '')
      || coalesce((SELECT string_agg(attrelid::regclass::text || '.' || attname || coalesce(attacl::text, ''), ',' ORDER BY attrelid, attnum)
                     FROM pg_attribute WHERE attrelid IN ('public."BillingDocument"'::regclass, 'public."BillingDocumentLine"'::regclass) AND attnum > 0 AND attacl IS NOT NULL), '')
    )::bigint), NULL
  UNION ALL SELECT 14, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL), NULL
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
