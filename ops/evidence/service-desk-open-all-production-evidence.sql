-- ============================================================================
-- service-desk-open-all-production-evidence.sql
--
-- Read-only Production evidence AFTER release-migrate of 20261221190000_service_desk_open_all. Flags and counts only:
--   1-3  the ledger: recorded once, finished, nothing unfinished; 20261222090000 still not recorded;
--   4-6  the module's rows: definition default ON, policy global ON, emergency switch untouched (OFF);
--   7-9  overrides unchanged: business 9 ENABLED, no DISABLED, no new override row;
--  10-11 service rows (info: the apply writes none);
--  12-13 the privileges and RLS policies fingerprints (must equal preflight rows 18-19).
--
-- PRIVACY: guard-clean (no write keyword anywhere, prose included). No names, no ids except the pilot business.
-- ============================================================================

\echo '== service desk open-all evidence: legend (n -> check) =='
\echo ' 1 20261221190000_service_desk_open_all recorded exactly once and finished (flag; expected t)'
\echo ' 2 ledger rows unfinished or rolled back (count; expected 0)'
\echo ' 3 20261222090000_service_desk_case_records not recorded (flag; expected t)'
\echo ' 4 service_desk: definition default ON (flag; expected t)'
\echo ' 5 service_desk: policy global ON (flag; expected t)'
\echo ' 6 service_desk: the emergency switch is set (flag; expected f)'
\echo ' 7 business 9: service_desk override is ENABLED (flag; expected t)'
\echo ' 8 service_desk overrides DISABLED (count; expected 0)'
\echo ' 9 service_desk override rows in total (count; expected 1)'
\echo '10 service cases outside business 9 (count; info)'
\echo '11 service cases in business 9 (count; info)'
\echo '12 privileges fingerprint of the Service tables (must equal preflight row 18)'
\echo '13 RLS policies fingerprint of the Service tables (must equal preflight row 19)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

WITH
d AS (SELECT "defaultEnabled" AS on_ FROM "PlatformFeatureDefinition" WHERE "key" = 'service_desk'),
p AS (SELECT "globalEnabled" AS g, "emergencyDisabled" AS e FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'service_desk'),
svc AS (SELECT c.oid, c.relname, c.relacl FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
         WHERE ns.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'Service%'),
lines(n, flag, observed_count) AS (
            SELECT 1, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261221190000_service_desk_open_all'
                        AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1
                      AND (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261221190000_service_desk_open_all') = 1, NULL::bigint
  UNION ALL SELECT 2, NULL, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, NOT EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261222090000_service_desk_case_records'), NULL
  UNION ALL SELECT 4, COALESCE((SELECT bool_and(on_) FROM d), false) AND (SELECT count(*) FROM d) = 1, NULL
  UNION ALL SELECT 5, COALESCE((SELECT bool_and(g) FROM p), false) AND (SELECT count(*) FROM p) = 1, NULL
  UNION ALL SELECT 6, COALESCE((SELECT bool_or(e) FROM p), false), NULL
  UNION ALL SELECT 7, EXISTS (SELECT 1 FROM "BusinessFeatureAccess" WHERE "businessId" = 9 AND "featureKey" = 'service_desk' AND "state"::text = 'ENABLED'), NULL
  UNION ALL SELECT 8, NULL, (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'service_desk' AND "state"::text = 'DISABLED')
  UNION ALL SELECT 9, NULL, (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'service_desk')
  UNION ALL SELECT 10, NULL, (SELECT count(*) FROM "ServiceCase" WHERE "businessId" <> 9)
  UNION ALL SELECT 11, NULL, (SELECT count(*) FROM "ServiceCase" WHERE "businessId" = 9)
  UNION ALL SELECT 12, NULL, (SELECT ('x' || substr(md5(string_agg(relname || ':' || coalesce(relacl::text, '-'), ',' ORDER BY relname)), 1, 8))::bit(32)::int FROM svc)
  UNION ALL SELECT 13, NULL, (SELECT ('x' || substr(md5(string_agg(pl.polname || ':' || pl.polcmd || ':' || pg_get_expr(pl.polqual, pl.polrelid), ',' ORDER BY pl.polname)), 1, 8))::bit(32)::int
                               FROM pg_policy pl JOIN svc ON svc.oid = pl.polrelid)
)
SELECT n, flag, observed_count FROM lines ORDER BY n;

ROLLBACK;
