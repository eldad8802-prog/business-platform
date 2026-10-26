-- ============================================================================
-- pos-rivhit-source-preflight.sql
--
-- Read-only Production PREFLIGHT before migration 20261104090000_pos_rivhit_source.
--
-- Proves, from counts only, that Production is the database the migration was written for:
--   * the ledger is clean and the migration is not recorded yet; every applied migration sorts before it;
--   * the connection source list and shape are the M7-A ones (telephony.voicenter present, no pos.* source);
--   * the two intake route vocabularies exist and hold no 'revenue' value yet;
--   * the revenue truth tables exist;
--   * no pos.* connection row and no pos_rivhit feature row exist.
-- No values, no names, no identifiers of any business.
-- ============================================================================

\echo ' 1 no migration is unfinished or rolled back (observed = rows)'
\echo ' 2 20261104090000_pos_rivhit_source is not recorded (observed = rows)'
\echo ' 3 every recorded migration sorts before 20261104090000_pos_rivhit_source (observed = rows at or after it)'
\echo ' 4 AcquisitionConnection_source_key is the M7-A list: telephony.voicenter present, no pos.* (observed = matching)'
\echo ' 5 AcquisitionConnection_source_shape exists (observed = rows)'
\echo ' 6 IntakeNormalizedEvent route vocabularies exist without revenue (observed = matching, of 2)'
\echo ' 7 RevenueSale and RevenueReceipt exist (observed = tables, of 2)'
\echo ' 8 pos.* connection rows (observed = rows)'
\echo ' 9 pos_rivhit feature definition / policy rows (observed = rows)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

WITH checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
            (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261104090000_pos_rivhit_source') = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261104090000_pos_rivhit_source')
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name >= '20261104090000_pos_rivhit_source') = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name >= '20261104090000_pos_rivhit_source')
  UNION ALL SELECT 4, (SELECT count(*) FROM pg_constraint WHERE conname = 'AcquisitionConnection_source_key'
                         AND pg_get_constraintdef(oid) LIKE '%telephony.voicenter%'
                         AND pg_get_constraintdef(oid) NOT LIKE '%pos.%') = 1,
                      (SELECT count(*) FROM pg_constraint WHERE conname = 'AcquisitionConnection_source_key'
                         AND pg_get_constraintdef(oid) LIKE '%telephony.voicenter%'
                         AND pg_get_constraintdef(oid) NOT LIKE '%pos.%')
  UNION ALL SELECT 5, (SELECT count(*) FROM pg_constraint WHERE conname = 'AcquisitionConnection_source_shape') = 1,
                      (SELECT count(*) FROM pg_constraint WHERE conname = 'AcquisitionConnection_source_shape')
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_constraint
                        WHERE conname IN ('IntakeNormalizedEvent_routeTarget_vocab', 'IntakeNormalizedEvent_routingDestination_vocab')
                          AND pg_get_constraintdef(oid) ~ '''c[a]ll'''
                          AND pg_get_constraintdef(oid) NOT LIKE '%revenue%') = 2,
                      (SELECT count(*) FROM pg_constraint
                        WHERE conname IN ('IntakeNormalizedEvent_routeTarget_vocab', 'IntakeNormalizedEvent_routingDestination_vocab')
                          AND pg_get_constraintdef(oid) ~ '''c[a]ll'''
                          AND pg_get_constraintdef(oid) NOT LIKE '%revenue%')
  UNION ALL SELECT 7, ((to_regclass('public."RevenueSale"') IS NOT NULL)::int + (to_regclass('public."RevenueReceipt"') IS NOT NULL)::int) = 2,
                      ((to_regclass('public."RevenueSale"') IS NOT NULL)::int + (to_regclass('public."RevenueReceipt"') IS NOT NULL)::int)
  UNION ALL SELECT 8, (SELECT count(*) FROM "AcquisitionConnection" WHERE "sourceKey" LIKE 'pos.%') = 0,
                      (SELECT count(*) FROM "AcquisitionConnection" WHERE "sourceKey" LIKE 'pos.%')
  UNION ALL SELECT 9, ((SELECT count(*) FROM "PlatformFeatureDefinition" WHERE "key" = 'pos_rivhit')
                     + (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'pos_rivhit')) = 0,
                      ((SELECT count(*) FROM "PlatformFeatureDefinition" WHERE "key" = 'pos_rivhit')
                     + (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'pos_rivhit'))
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
