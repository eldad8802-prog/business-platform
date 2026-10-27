-- ============================================================================
-- document-supplier-link-open-all-production-evidence.sql
--
-- Read-only Production EVIDENCE after migration
--   20261103100000_document_supplier_link_open_all
--
-- Proves, from counts only, that document supplier linking is open for every business:
--   * the migration is recorded and finished, nothing is unfinished or rolled back;
--   * the definition says ON by default, the global policy is ON and the emergency switch is OFF;
--   * how many business overrides close it (each one is a deliberate per-business choice, reported, not failed);
--   * how many businesses exist and how many the policy now opens (all minus the closing overrides).
-- No values, no names, no identifiers of any business.
-- ============================================================================

\echo ' 1 20261103100000_document_supplier_link_open_all is recorded once, finished, not rolled back (observed = rows)'
\echo ' 2 no migration is unfinished or rolled back (observed = rows)'
\echo ' 3 definition document_supplier_linking: defaultEnabled is true (observed = matching rows)'
\echo ' 4 policy document_supplier_linking: globalEnabled true, emergencyDisabled false (observed = matching rows)'
\echo ' 5 business overrides that close document_supplier_linking — reported, not failed (observed = rows)'
\echo ' 6 businesses (observed = rows)'
\echo ' 7 businesses the feature is open for: all minus the closing overrides (observed = businesses)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

WITH checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261103100000_document_supplier_link_open_all'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1,
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261103100000_document_supplier_link_open_all'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE "key" = 'document_supplier_linking' AND "defaultEnabled") = 1,
                      (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE "key" = 'document_supplier_linking' AND "defaultEnabled")
  UNION ALL SELECT 4, (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'document_supplier_linking' AND "globalEnabled" AND NOT "emergencyDisabled") = 1,
                      (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'document_supplier_linking' AND "globalEnabled" AND NOT "emergencyDisabled")
  UNION ALL SELECT 5, true,
                      (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'document_supplier_linking' AND "state" = 'DISABLED')
  UNION ALL SELECT 6, true,
                      (SELECT count(*) FROM "Business")
  UNION ALL SELECT 7, (SELECT count(*) FROM "Business" b WHERE NOT EXISTS (SELECT 1 FROM "BusinessFeatureAccess" a
                         WHERE a."businessId" = b."id" AND a."featureKey" = 'document_supplier_linking' AND a."state" = 'DISABLED'))
                      = (SELECT count(*) FROM "Business") - (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'document_supplier_linking' AND "state" = 'DISABLED'),
                      (SELECT count(*) FROM "Business" b WHERE NOT EXISTS (SELECT 1 FROM "BusinessFeatureAccess" a
                         WHERE a."businessId" = b."id" AND a."featureKey" = 'document_supplier_linking' AND a."state" = 'DISABLED'))
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
