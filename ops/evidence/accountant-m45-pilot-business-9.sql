-- ============================================================================
-- accountant-m45-pilot-business-9.sql
--
-- Read-only Production evidence BEFORE the G5 M4 + M5 pilot in business 9 (and again after it).
-- Where business 9 stands, and that nothing else can send:
--   * the send permission `accountant_delivery` is held by nobody (or, during the pilot, by business 9 ONLY);
--   * the monthly workflow `accountant_month_close` is on for business 9 and for no other business;
--   * business 9's accountant recipient is the owner's test address — compared by md5 only, so the address is not
--     written here and never printed;
--   * which of its months has a READY package, and that no delivery is waiting, in flight or holding a live link
--     anywhere; codes and verified devices (zero before the pilot).
--
-- OUTPUT: n | flag | observed_count. Counts and flags only; no address, name or id is printed.
-- PRIVACY: guard-clean (no write keyword anywhere, prose included).
-- ============================================================================

\echo '== accountant M4 + M5 pilot, business 9: legend (n -> check) =='
\echo ' 1 the evidence role is a superuser or has BYPASSRLS (flag)'
\echo ' 2 business 9 exists (count; expected 1)'
\echo ' 3 business 9 holds accountant_month_close ENABLED (flag; expected t)'
\echo ' 4 businesses other than 9 holding accountant_month_close ENABLED (count; expected 0)'
\echo ' 5 the policy of accountant_delivery: globalEnabled false, not emergency-disabled (flag; expected t)'
\echo ' 6 accountant_delivery ENABLED overrides, any business (count; 0 before the permission is given, 1 during the pilot)'
\echo ' 7 accountant_delivery ENABLED overrides of businesses other than 9 (count; expected 0)'
\echo ' 8 business 9 has an accountant recipient (count; expected 1)'
\echo ' 9 that recipient is the owner test address (md5 compare) (flag; expected t)'
\echo '10 business 9 months with a READY package (count)'
\echo '11 of them, the most recent closed month 2026-10 or 2026-09 (count)'
\echo '12 deliveries APPROVED or SENDING, any business (count; expected 0)'
\echo '13 deliveries whose link is live (accepted/delivered, not revoked, not expired), any business (count; expected 0)'
\echo '14 business 9 deliveries ever (count; informational)'
\echo '15 one-time codes + verified devices, any business (count; 0 before the pilot)'
\echo '16 devices not revoked, any business (count; 0 before and after the pilot)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

WITH
fa AS (SELECT "businessId", "featureKey", "state"::text AS state FROM "BusinessFeatureAccess"),
lines(n, flag, observed_count) AS (
            SELECT 1, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user), NULL::bigint
  UNION ALL SELECT 2, NULL, (SELECT count(*) FROM "Business" WHERE "id" = 9)
  UNION ALL SELECT 3, EXISTS (SELECT 1 FROM fa WHERE "businessId" = 9 AND "featureKey" = 'accountant_month_close' AND state = 'ENABLED'), NULL
  UNION ALL SELECT 4, NULL, (SELECT count(*) FROM fa WHERE "businessId" <> 9 AND "featureKey" = 'accountant_month_close' AND state = 'ENABLED')
  UNION ALL SELECT 5, EXISTS (SELECT 1 FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'accountant_delivery' AND "globalEnabled" = false AND "emergencyDisabled" = false), NULL
  UNION ALL SELECT 6, NULL, (SELECT count(*) FROM fa WHERE "featureKey" = 'accountant_delivery' AND state = 'ENABLED')
  UNION ALL SELECT 7, NULL, (SELECT count(*) FROM fa WHERE "featureKey" = 'accountant_delivery' AND state = 'ENABLED' AND "businessId" <> 9)
  UNION ALL SELECT 8, NULL, (SELECT count(*) FROM "AccountantRecipient" WHERE "businessId" = 9)
  UNION ALL SELECT 9, EXISTS (SELECT 1 FROM "AccountantRecipient" WHERE "businessId" = 9 AND md5(lower(trim("email"))) = 'd48caab029243bd939f7c4327dd1c0ff'), NULL
  UNION ALL SELECT 10, NULL, (SELECT count(DISTINCT p."periodId") FROM "AccountantPackage" p WHERE p."businessId" = 9 AND p."status" = 'READY')
  UNION ALL SELECT 11, NULL, (SELECT count(*) FROM "AccountantPackage" p JOIN "AccountantPeriod" pe ON pe."id" = p."periodId"
                               WHERE p."businessId" = 9 AND p."status" = 'READY' AND pe."periodKey" IN ('2026-10', '2026-09'))
  UNION ALL SELECT 12, NULL, (SELECT count(*) FROM "AccountantDelivery" WHERE "status" IN ('APPROVED', 'SENDING'))
  UNION ALL SELECT 13, NULL, (SELECT count(*) FROM "AccountantDelivery" WHERE "status" IN ('ACCEPTED', 'DELIVERED')
                               AND "linkRevokedAt" IS NULL AND "linkExpiresAt" > now())
  UNION ALL SELECT 14, NULL, (SELECT count(*) FROM "AccountantDelivery" WHERE "businessId" = 9)
  UNION ALL SELECT 15, NULL, (SELECT count(*) FROM "AccountantLinkChallenge") + (SELECT count(*) FROM "AccountantLinkDevice")
  UNION ALL SELECT 16, NULL, (SELECT count(*) FROM "AccountantLinkDevice" WHERE "revokedAt" IS NULL)
)
SELECT n, flag, observed_count FROM lines ORDER BY n;

ROLLBACK;
