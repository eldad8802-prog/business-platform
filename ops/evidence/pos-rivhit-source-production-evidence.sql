-- ============================================================================
-- pos-rivhit-source-production-evidence.sql
--
-- Read-only Production EVIDENCE after migration 20261103090000_pos_rivhit_source.
--
-- Proves, from counts only, that the migration landed exactly and that nothing reads Rivhit:
--   * the migration is recorded once, finished, with the checksum of the reviewed file;
--   * the feature pos_rivhit is OFF by default, OFF globally, the emergency switch OFF, no business override opens it;
--   * the source list and shape name pos.rivhit; both route vocabularies name revenue;
--   * no pos.rivhit connection exists and no revenue row came from one.
-- No values, no names, no identifiers of any business.
-- ============================================================================

\echo ' 1 20261103090000_pos_rivhit_source is recorded once, finished, not rolled back (observed = rows)'
\echo ' 2 no migration is unfinished or rolled back (observed = rows)'
\echo ' 3 the recorded checksum is the reviewed file (observed = matching rows)'
\echo ' 4 definition pos_rivhit: defaultEnabled false, mutable true (observed = matching rows)'
\echo ' 5 policy pos_rivhit: globalEnabled false, emergencyDisabled false (observed = matching rows)'
\echo ' 6 business overrides that open pos_rivhit (observed = rows)'
\echo ' 7 AcquisitionConnection_source_key names pos.rivhit (observed = matching)'
\echo ' 8 AcquisitionConnection_source_shape names pos.rivhit (observed = matching)'
\echo ' 9 both IntakeNormalizedEvent route vocabularies name revenue (observed = matching, of 2)'
\echo '10 pos.rivhit connections (observed = rows)'
\echo '11 revenue rows from a pos.rivhit source scope (observed = rows)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

WITH checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261103090000_pos_rivhit_source'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1,
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261103090000_pos_rivhit_source'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261103090000_pos_rivhit_source'
                         AND checksum = '8b1d7dc54103f35d8ceefaadd94fef913ad84d07accb96dec93ece305c489a7c') = 1,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261103090000_pos_rivhit_source'
                         AND checksum = '8b1d7dc54103f35d8ceefaadd94fef913ad84d07accb96dec93ece305c489a7c')
  UNION ALL SELECT 4, (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE "key" = 'pos_rivhit' AND NOT "defaultEnabled" AND "mutable") = 1,
                      (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE "key" = 'pos_rivhit' AND NOT "defaultEnabled" AND "mutable")
  UNION ALL SELECT 5, (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'pos_rivhit' AND NOT "globalEnabled" AND NOT "emergencyDisabled") = 1,
                      (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'pos_rivhit' AND NOT "globalEnabled" AND NOT "emergencyDisabled")
  UNION ALL SELECT 6, (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'pos_rivhit' AND "state" = 'ENABLED') = 0,
                      (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'pos_rivhit' AND "state" = 'ENABLED')
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_constraint WHERE conname = 'AcquisitionConnection_source_key'
                         AND pg_get_constraintdef(oid) LIKE '%pos.rivhit%') = 1,
                      (SELECT count(*) FROM pg_constraint WHERE conname = 'AcquisitionConnection_source_key'
                         AND pg_get_constraintdef(oid) LIKE '%pos.rivhit%')
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_constraint WHERE conname = 'AcquisitionConnection_source_shape'
                         AND pg_get_constraintdef(oid) LIKE '%pos.rivhit%') = 1,
                      (SELECT count(*) FROM pg_constraint WHERE conname = 'AcquisitionConnection_source_shape'
                         AND pg_get_constraintdef(oid) LIKE '%pos.rivhit%')
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_constraint
                        WHERE conname IN ('IntakeNormalizedEvent_routeTarget_vocab', 'IntakeNormalizedEvent_routingDestination_vocab')
                          AND pg_get_constraintdef(oid) LIKE '%revenue%') = 2,
                      (SELECT count(*) FROM pg_constraint
                        WHERE conname IN ('IntakeNormalizedEvent_routeTarget_vocab', 'IntakeNormalizedEvent_routingDestination_vocab')
                          AND pg_get_constraintdef(oid) LIKE '%revenue%')
  UNION ALL SELECT 10, (SELECT count(*) FROM "AcquisitionConnection" WHERE "sourceKey" = 'pos.rivhit') = 0,
                       (SELECT count(*) FROM "AcquisitionConnection" WHERE "sourceKey" = 'pos.rivhit')
  UNION ALL SELECT 11, ((SELECT count(*) FROM "RevenueSale" WHERE "sourceScope" LIKE 'pos.rivhit%')
                      + (SELECT count(*) FROM "RevenueReceipt" WHERE "sourceScope" LIKE 'pos.rivhit%')) = 0,
                       ((SELECT count(*) FROM "RevenueSale" WHERE "sourceScope" LIKE 'pos.rivhit%')
                      + (SELECT count(*) FROM "RevenueReceipt" WHERE "sourceScope" LIKE 'pos.rivhit%'))
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
