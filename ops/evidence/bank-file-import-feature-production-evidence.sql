-- ============================================================================
-- bank-file-import-feature-production-evidence.sql
--
-- Read-only Production EVIDENCE after migration
--   20261031090000_bank_file_import_feature
--
-- Proves, from counts only, that the bank file import feature exists and is OFF everywhere:
--   * the migration is recorded once and finished; no migration is unfinished or rolled back;
--   * the definition row is OFF by default and switchable; the global policy is OFF, the emergency switch OFF;
--   * no business override opens it;
--   * nothing has been imported through it: no run of the bank statement kind, no bank line from its batches.
-- No values, no names, no identifiers of any business.
-- ============================================================================

\echo ' 1 20261031090000_bank_file_import_feature is recorded once, finished, not rolled back (observed = rows)'
\echo ' 2 no migration is unfinished or rolled back (observed = rows)'
\echo ' 3 definition bank_file_import: defaultEnabled false, mutable true (observed = matching rows)'
\echo ' 4 policy bank_file_import: globalEnabled false, emergencyDisabled false (observed = matching rows)'
\echo ' 5 business overrides that open bank_file_import (observed = rows)'
\echo ' 6 import runs of the bank statement kind (observed = rows)'
\echo ' 7 bank lines from bank file import batches (observed = rows)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

WITH checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261031090000_bank_file_import_feature'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1,
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261031090000_bank_file_import_feature'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE "key" = 'bank_file_import' AND NOT "defaultEnabled" AND "mutable") = 1,
                      (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE "key" = 'bank_file_import' AND NOT "defaultEnabled" AND "mutable")
  UNION ALL SELECT 4, (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'bank_file_import' AND NOT "globalEnabled" AND NOT "emergencyDisabled") = 1,
                      (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'bank_file_import' AND NOT "globalEnabled" AND NOT "emergencyDisabled")
  UNION ALL SELECT 5, (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'bank_file_import' AND "state" = 'ENABLED') = 0,
                      (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'bank_file_import' AND "state" = 'ENABLED')
  UNION ALL SELECT 6, (SELECT count(*) FROM "ImportRun" WHERE "domain" = 'bank_statement') = 0,
                      (SELECT count(*) FROM "ImportRun" WHERE "domain" = 'bank_statement')
  UNION ALL SELECT 7, (SELECT count(*) FROM "ExternalTransaction" WHERE "importBatchId" LIKE 'bnk-%') = 0,
                      (SELECT count(*) FROM "ExternalTransaction" WHERE "importBatchId" LIKE 'bnk-%')
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
