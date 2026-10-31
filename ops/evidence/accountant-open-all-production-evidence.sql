-- ============================================================================
-- accountant-open-all-production-evidence.sql
--
-- Read-only Production proof AFTER release-migrate of 20261110090000_accountant_open_all (the accountant workflow and
-- sending, open for every business). Flags and counts only:
--   * the migration is recorded once, finished, with the pinned checksum (LF or CRLF), and nothing is pending;
--   * both definitions default ON and both policies global ON, emergency switch OFF;
--   * no business override was created or changed by it (business 9 keeps its two ENABLED rows, no DISABLED anywhere);
--   * no delivery is waiting or in flight — opening sends nothing.
--
-- PRIVACY: guard-clean (no write keyword anywhere, prose included).
-- ============================================================================

\echo '== accountant open-all proof: legend (n -> check) =='
\echo ' 1 the evidence role is a superuser or has BYPASSRLS (flag)'
\echo ' 2 20261110090000_accountant_open_all recorded once, finished, not rolled back, pinned checksum (flag; expected t)'
\echo ' 3 ledger rows unfinished or rolled back (count; expected 0)'
\echo ' 4 accountant_month_close: definition default ON, policy global ON, emergency OFF (flag; expected t)'
\echo ' 5 accountant_delivery: definition default ON, policy global ON, emergency OFF (flag; expected t)'
\echo ' 6 overrides of either feature ENABLED (count; expected 2, business 9)'
\echo ' 7 overrides of either feature DISABLED (count; expected 0)'
\echo ' 8 deliveries APPROVED or SENDING (count; expected 0)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

WITH
pin(lf, crlf) AS (VALUES ('ffca9439dc64d73b0f727d4ee1632b449693c6f0d2307d3c06e81051d581e25d', '647635404b9d9e9261d83fdd1195847759cdaf9a45d3320daea4b376cf8f3247')),
st AS (SELECT d."key", d."defaultEnabled" AS d, p."globalEnabled" AS g, p."emergencyDisabled" AS e
       FROM "PlatformFeatureDefinition" d JOIN "PlatformFeaturePolicy" p ON p."featureKey" = d."key"
       WHERE d."key" IN ('accountant_month_close', 'accountant_delivery')),
lines(n, flag, observed_count) AS (
            SELECT 1, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user), NULL::bigint
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" m, pin WHERE m.migration_name = '20261110090000_accountant_open_all'
                         AND m.finished_at IS NOT NULL AND m.rolled_back_at IS NULL AND m.checksum IN (pin.lf, pin.crlf)) = 1
                    AND (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261110090000_accountant_open_all') = 1, NULL
  UNION ALL SELECT 3, NULL, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 4, EXISTS (SELECT 1 FROM st WHERE "key" = 'accountant_month_close' AND d AND g AND NOT e), NULL
  UNION ALL SELECT 5, EXISTS (SELECT 1 FROM st WHERE "key" = 'accountant_delivery' AND d AND g AND NOT e), NULL
  UNION ALL SELECT 6, NULL, (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" IN ('accountant_month_close', 'accountant_delivery') AND "state"::text = 'ENABLED')
  UNION ALL SELECT 7, NULL, (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" IN ('accountant_month_close', 'accountant_delivery') AND "state"::text = 'DISABLED')
  UNION ALL SELECT 8, NULL, (SELECT count(*) FROM "AccountantDelivery" WHERE "status" IN ('APPROVED', 'SENDING'))
)
SELECT n, flag, observed_count FROM lines ORDER BY n;

ROLLBACK;
