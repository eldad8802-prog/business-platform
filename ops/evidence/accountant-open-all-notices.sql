-- ============================================================================
-- accountant-open-all-notices.sql
--
-- Read-only Production evidence AFTER opening the accountant workflow to every business (#893, 2026-11-01):
-- the months the hourly sweep prepared for 2026-10, the businesses still waiting for it, and the in-app notices
-- those months produced. Verification only; it reads, it never changes anything.
--   * months of 2026-10 by status, failures, and businesses the sweep sees that have no such month yet;
--   * no business holds two months for one period (also a unique key; counted here as proof);
--   * accountant notices (entity types accountant_period_*), per business and per month, open vs resolved;
--   * every accountant notice intends the in-app channel only, and none was attempted as a push;
--   * no delivery to an accountant was approved, sent or attempted since the opening.
--
-- OUTPUT: n | flag | observed_count. No name, address or id is printed.
-- PRIVACY: guard-clean (no write keyword anywhere, prose included).
-- ============================================================================

\echo '== accountant open-all notices: legend (n -> check) =='
\echo ' 1 the evidence role is a superuser or has BYPASSRLS (flag)'
\echo ' 2 businesses the sweep would see: not deletion-requested, not deleted, not the platform system row (count)'
\echo ' 3 of those, closed by an explicit accountant_month_close DISABLED override (count; expected 0)'
\echo ' 4 months 2026-10 recorded, any business (count)'
\echo ' 5 months 2026-10 of businesses the sweep sees (count)'
\echo ' 6 businesses the sweep sees with NO month 2026-10 yet = still waiting (count)'
\echo ' 7 months 2026-10 PREPARING (count)'
\echo ' 8 months 2026-10 READY_FOR_REVIEW (count)'
\echo ' 9 months 2026-10 NEEDS_ATTENTION (count)'
\echo '10 months 2026-10 PREPARATION_FAILED (count; expected 0)'
\echo '11 months 2026-10 in any other status (count)'
\echo '12 months 2026-10 carrying a failure code (count; expected 0)'
\echo '13 business + period pairs held by more than one month, any period (count; expected 0)'
\echo '14 months 2026-10 whose latest package is READY (count)'
\echo '15 months 2026-10 with more than one package version (count; a rebuild after a change, not a duplicate)'
\echo '16 months 2026-10 evaluated since the opening, 2026-11-01 17:06 UTC (count)'
\echo '17 accountant notices, any business, any month (count)'
\echo '18 accountant notices of months 2026-10 (count)'
\echo '19 accountant notices of months 2026-10 still open: not resolved, not dismissed (count)'
\echo '20 businesses with at least one accountant notice of 2026-10 (count)'
\echo '21 months with more than one OPEN accountant notice (count; expected 0)'
\echo '22 most open accountant notices of a single business (count)'
\echo '23 accountant notices first surfaced since the opening (count)'
\echo '24 accountant notices whose intended channels include anything but IN_APP (count; expected 0)'
\echo '25 notification attempts of accountant notices on a channel other than IN_APP (count; expected 0)'
\echo '26 accountant deliveries approved since the opening (count; expected 0)'
\echo '27 accountant deliveries APPROVED or SENDING now (count; expected 0)'
\echo '28 accountant deliveries, all time (count)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

WITH
opened AS (SELECT timestamptz '2026-11-01 17:06:00+00' AS at),
biz AS (SELECT "id" FROM "Business" WHERE "deletionRequestedAt" IS NULL AND "deletedAt" IS NULL AND "name" <> '__PLATFORM_SYSTEM__'),
oct AS (SELECT * FROM "AccountantPeriod" WHERE "periodKey" = '2026-10'),
notice AS (SELECT * FROM "Notification" WHERE "entityType" LIKE 'accountant\_period\_%'),
oct_notice AS (SELECT n.* FROM notice n JOIN oct p ON p."id" = n."entityId" AND p."businessId" = n."businessId"),
open_notice AS (SELECT * FROM notice WHERE "resolvedAt" IS NULL AND "dismissedAt" IS NULL),
lines(n, flag, observed_count) AS (
            SELECT 1, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user), NULL::bigint
  UNION ALL SELECT 2, NULL, (SELECT count(*) FROM biz)
  UNION ALL SELECT 3, NULL, (SELECT count(*) FROM "BusinessFeatureAccess" fa JOIN biz b ON b."id" = fa."businessId"
                              WHERE fa."featureKey" = 'accountant_month_close' AND fa."state"::text = 'DISABLED')
  UNION ALL SELECT 4, NULL, (SELECT count(*) FROM oct)
  UNION ALL SELECT 5, NULL, (SELECT count(*) FROM oct p JOIN biz b ON b."id" = p."businessId")
  UNION ALL SELECT 6, NULL, (SELECT count(*) FROM biz b WHERE NOT EXISTS (SELECT 1 FROM oct p WHERE p."businessId" = b."id"))
  UNION ALL SELECT 7, NULL, (SELECT count(*) FROM oct WHERE "status" = 'PREPARING')
  UNION ALL SELECT 8, NULL, (SELECT count(*) FROM oct WHERE "status" = 'READY_FOR_REVIEW')
  UNION ALL SELECT 9, NULL, (SELECT count(*) FROM oct WHERE "status" = 'NEEDS_ATTENTION')
  UNION ALL SELECT 10, NULL, (SELECT count(*) FROM oct WHERE "status" = 'PREPARATION_FAILED')
  UNION ALL SELECT 11, NULL, (SELECT count(*) FROM oct WHERE "status" NOT IN ('PREPARING', 'READY_FOR_REVIEW', 'NEEDS_ATTENTION', 'PREPARATION_FAILED'))
  UNION ALL SELECT 12, NULL, (SELECT count(*) FROM oct WHERE "failureCode" IS NOT NULL)
  UNION ALL SELECT 13, NULL, (SELECT count(*) FROM (SELECT 1 FROM "AccountantPeriod" GROUP BY "businessId", "periodKey" HAVING count(*) > 1) d)
  UNION ALL SELECT 14, NULL, (SELECT count(*) FROM oct p JOIN "AccountantPackage" k ON k."id" = p."latestPackageId" AND k."businessId" = p."businessId" WHERE k."status" = 'READY')
  UNION ALL SELECT 15, NULL, (SELECT count(*) FROM (SELECT 1 FROM "AccountantPackage" k JOIN oct p ON p."id" = k."periodId" GROUP BY k."periodId" HAVING count(*) > 1) v)
  UNION ALL SELECT 16, NULL, (SELECT count(*) FROM oct, opened WHERE "evaluatedAt" >= opened.at)
  UNION ALL SELECT 17, NULL, (SELECT count(*) FROM notice)
  UNION ALL SELECT 18, NULL, (SELECT count(*) FROM oct_notice)
  UNION ALL SELECT 19, NULL, (SELECT count(*) FROM oct_notice WHERE "resolvedAt" IS NULL AND "dismissedAt" IS NULL)
  UNION ALL SELECT 20, NULL, (SELECT count(DISTINCT "businessId") FROM oct_notice)
  UNION ALL SELECT 21, NULL, (SELECT count(*) FROM (SELECT 1 FROM open_notice GROUP BY "businessId", "entityId" HAVING count(*) > 1) m)
  UNION ALL SELECT 22, NULL, (SELECT coalesce(max(c), 0) FROM (SELECT count(*) AS c FROM open_notice GROUP BY "businessId") x)
  UNION ALL SELECT 23, NULL, (SELECT count(*) FROM notice, opened WHERE "firstSurfacedAt" >= opened.at)
  UNION ALL SELECT 24, NULL, (SELECT count(*) FROM notice WHERE "intendedChannels" <> ARRAY['IN_APP']::"NotificationChannel"[])
  UNION ALL SELECT 25, NULL, (SELECT count(*) FROM "NotificationDelivery" d JOIN notice n ON n."id" = d."notificationId" AND n."businessId" = d."businessId"
                               WHERE d."channel"::text <> 'IN_APP')
  UNION ALL SELECT 26, NULL, (SELECT count(*) FROM "AccountantDelivery", opened WHERE "approvedAt" >= opened.at)
  UNION ALL SELECT 27, NULL, (SELECT count(*) FROM "AccountantDelivery" WHERE "status" IN ('APPROVED', 'SENDING'))
  UNION ALL SELECT 28, NULL, (SELECT count(*) FROM "AccountantDelivery")
)
SELECT n, flag, observed_count FROM lines ORDER BY n;

ROLLBACK;
