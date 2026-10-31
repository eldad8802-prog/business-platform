-- ============================================================================
-- accountant-rollout-readiness.sql
--
-- Read-only Production evidence BEFORE opening the accountant workflow (accountant_month_close) and sending
-- (accountant_delivery) to every business — and again after it. Counts and flags only:
--   * how many businesses the sweep would see (not deletion-requested, not deleted, not the platform system row);
--   * explicit overrides of either feature, by state (an explicit DISABLED keeps a business closed after opening);
--   * the two definitions and policies as they stand;
--   * recipients set; months and packages already prepared, by month; deliveries by status; live links;
--   * one-time codes and devices; whether the hourly sweep has prepared anything in the last 2 hours (the observable
--     sign that ACCOUNTANT_SWEEP_ENABLED is on: on the 1st it creates the month just closed for an enabled business).
--
-- OUTPUT: n | flag | observed_count. No name, address or id is printed.
-- PRIVACY: guard-clean (no write keyword anywhere, prose included).
-- ============================================================================

\echo '== accountant rollout readiness: legend (n -> check) =='
\echo ' 1 the evidence role is a superuser or has BYPASSRLS (flag)'
\echo ' 2 businesses the sweep would see: not deletion-requested, not deleted, not the platform system row (count)'
\echo ' 3 accountant_month_close overrides ENABLED (count)'
\echo ' 4 accountant_month_close overrides DISABLED (count)'
\echo ' 5 accountant_delivery overrides ENABLED (count)'
\echo ' 6 accountant_delivery overrides DISABLED (count)'
\echo ' 7 accountant_month_close definition defaultEnabled (flag)'
\echo ' 8 accountant_month_close policy globalEnabled (flag)'
\echo ' 9 accountant_month_close policy emergencyDisabled (flag)'
\echo '10 accountant_delivery definition defaultEnabled (flag)'
\echo '11 accountant_delivery policy globalEnabled (flag)'
\echo '12 accountant_delivery policy emergencyDisabled (flag)'
\echo '13 businesses with an accountant recipient (count)'
\echo '14 accountant months recorded, any business (count)'
\echo '15 months 2026-10 recorded (count)'
\echo '16 months 2026-09 recorded (count)'
\echo '17 months older than 2026-09 recorded (count)'
\echo '18 READY packages, any business (count)'
\echo '19 deliveries APPROVED or SENDING (count; expected 0)'
\echo '20 deliveries ACCEPTED or DELIVERED (count)'
\echo '21 deliveries FAILED, CANCELED or BOUNCED (count)'
\echo '22 links live: accepted/delivered, not revoked, not expired (count)'
\echo '23 one-time codes (count)'
\echo '24 devices not revoked (count)'
\echo '25 months evaluated in the last 2 hours (count; > 0 means the sweep is running)'
\echo '26 months 2026-10 created in the last 2 hours (count)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

WITH
fa AS (SELECT "businessId", "featureKey", "state"::text AS state FROM "BusinessFeatureAccess"),
def AS (SELECT "key", "defaultEnabled" FROM "PlatformFeatureDefinition" WHERE "key" IN ('accountant_month_close', 'accountant_delivery')),
pol AS (SELECT "featureKey", "globalEnabled", "emergencyDisabled" FROM "PlatformFeaturePolicy" WHERE "featureKey" IN ('accountant_month_close', 'accountant_delivery')),
lines(n, flag, observed_count) AS (
            SELECT 1, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user), NULL::bigint
  UNION ALL SELECT 2, NULL, (SELECT count(*) FROM "Business" WHERE "deletionRequestedAt" IS NULL AND "deletedAt" IS NULL AND "name" <> '__PLATFORM_SYSTEM__')
  UNION ALL SELECT 3, NULL, (SELECT count(*) FROM fa WHERE "featureKey" = 'accountant_month_close' AND state = 'ENABLED')
  UNION ALL SELECT 4, NULL, (SELECT count(*) FROM fa WHERE "featureKey" = 'accountant_month_close' AND state = 'DISABLED')
  UNION ALL SELECT 5, NULL, (SELECT count(*) FROM fa WHERE "featureKey" = 'accountant_delivery' AND state = 'ENABLED')
  UNION ALL SELECT 6, NULL, (SELECT count(*) FROM fa WHERE "featureKey" = 'accountant_delivery' AND state = 'DISABLED')
  UNION ALL SELECT 7, (SELECT "defaultEnabled" FROM def WHERE "key" = 'accountant_month_close'), NULL
  UNION ALL SELECT 8, (SELECT "globalEnabled" FROM pol WHERE "featureKey" = 'accountant_month_close'), NULL
  UNION ALL SELECT 9, (SELECT "emergencyDisabled" FROM pol WHERE "featureKey" = 'accountant_month_close'), NULL
  UNION ALL SELECT 10, (SELECT "defaultEnabled" FROM def WHERE "key" = 'accountant_delivery'), NULL
  UNION ALL SELECT 11, (SELECT "globalEnabled" FROM pol WHERE "featureKey" = 'accountant_delivery'), NULL
  UNION ALL SELECT 12, (SELECT "emergencyDisabled" FROM pol WHERE "featureKey" = 'accountant_delivery'), NULL
  UNION ALL SELECT 13, NULL, (SELECT count(*) FROM "AccountantRecipient")
  UNION ALL SELECT 14, NULL, (SELECT count(*) FROM "AccountantPeriod")
  UNION ALL SELECT 15, NULL, (SELECT count(*) FROM "AccountantPeriod" WHERE "periodKey" = '2026-10')
  UNION ALL SELECT 16, NULL, (SELECT count(*) FROM "AccountantPeriod" WHERE "periodKey" = '2026-09')
  UNION ALL SELECT 17, NULL, (SELECT count(*) FROM "AccountantPeriod" WHERE "periodKey" < '2026-09')
  UNION ALL SELECT 18, NULL, (SELECT count(*) FROM "AccountantPackage" WHERE "status" = 'READY')
  UNION ALL SELECT 19, NULL, (SELECT count(*) FROM "AccountantDelivery" WHERE "status" IN ('APPROVED', 'SENDING'))
  UNION ALL SELECT 20, NULL, (SELECT count(*) FROM "AccountantDelivery" WHERE "status" IN ('ACCEPTED', 'DELIVERED'))
  UNION ALL SELECT 21, NULL, (SELECT count(*) FROM "AccountantDelivery" WHERE "status" IN ('FAILED', 'CANCELED', 'BOUNCED'))
  UNION ALL SELECT 22, NULL, (SELECT count(*) FROM "AccountantDelivery" WHERE "status" IN ('ACCEPTED', 'DELIVERED') AND "linkRevokedAt" IS NULL AND "linkExpiresAt" > now())
  UNION ALL SELECT 23, NULL, (SELECT count(*) FROM "AccountantLinkChallenge")
  UNION ALL SELECT 24, NULL, (SELECT count(*) FROM "AccountantLinkDevice" WHERE "revokedAt" IS NULL)
  UNION ALL SELECT 25, NULL, (SELECT count(*) FROM "AccountantPeriod" WHERE "evaluatedAt" > now() - interval '2 hours')
  UNION ALL SELECT 26, NULL, (SELECT count(*) FROM "AccountantPeriod" WHERE "periodKey" = '2026-10' AND "createdAt" > now() - interval '2 hours')
)
SELECT n, flag, observed_count FROM lines ORDER BY n;

ROLLBACK;
