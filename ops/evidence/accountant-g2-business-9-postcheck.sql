-- ============================================================================
-- accountant-g2-business-9-postcheck.sql
--
-- Read-only Production check AFTER G2.2 of the monthly accountant workflow: business 9 alone was
-- enabled and its most recently closed month (September 2026) was prepared once. It proves, from
-- flags and counts only:
--   * only business 9 is enabled;
--   * only the latest closed month exists: one period, 2026-09, nothing older and no open October;
--   * no duplicate package: one READY package, under business 9's own private exports prefix;
--   * the owner has exactly one live accountant notice;
--   * nothing was sent: no recipient, no delivery, anywhere;
--   * every other business is untouched: no accountant row and no accountant notice.
--
-- Flags and counts only (scripts/ci/evidence-redact.mjs); business 9 is named in the legend only.
--
-- OUTPUT: n | flag | observed_count. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== accountant G2.2 post-check for business 9: legend =='
\echo ' 1 exactly one accountant_month_close override exists, and it is business 9 ENABLED (flag)'
\echo ' 2 the feature is not emergency-disabled (flag; null = no policy row)'
\echo ' 3 periods of business 9 (count; expected 1)'
\echo ' 4 that period is 2026-09 (flag)'
\echo ' 5 the period waits for the owner: READY_FOR_REVIEW or NEEDS_ATTENTION (flag)'
\echo ' 6 READY packages of business 9 (count; expected 1)'
\echo ' 7 FAILED packages of business 9 (count; expected 0)'
\echo ' 8 periods anywhere with more than one READY package (count; expected 0)'
\echo ' 9 the READY package is stored under biz/9/exports/accountant/2026-09/ (flag)'
\echo '10 live accountant notices of business 9 (count; expected 1)'
\echo '11 recipients, all businesses (count; expected 0)'
\echo '12 deliveries, all businesses (count; expected 0)'
\echo '13 accountant rows of any OTHER business: periods + packages + recipients + deliveries + trail (count; expected 0)'
\echo '14 accountant notices of any OTHER business (count; expected 0)'
\echo '15 trail events of business 9 (count; informational)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
ready AS (SELECT k."periodId", count(*) AS c FROM "AccountantPackage" k WHERE k.status = 'READY' GROUP BY k."periodId"),
lines(n, flag, observed_count) AS (
            SELECT 1, (SELECT count(*) FROM "BusinessFeatureAccess" a WHERE a."featureKey" = 'accountant_month_close') = 1
                      AND EXISTS (SELECT 1 FROM "BusinessFeatureAccess" a WHERE a."featureKey" = 'accountant_month_close'
                                    AND a."businessId" = 9 AND a.state::text = 'ENABLED'), NULL::bigint
  UNION ALL SELECT 2, (SELECT NOT p."emergencyDisabled" FROM "PlatformFeaturePolicy" p WHERE p."featureKey" = 'accountant_month_close'), NULL
  UNION ALL SELECT 3, NULL, (SELECT count(*) FROM "AccountantPeriod" p WHERE p."businessId" = 9)
  UNION ALL SELECT 4, (SELECT bool_and(p."periodKey" = '2026-09') FROM "AccountantPeriod" p WHERE p."businessId" = 9), NULL
  UNION ALL SELECT 5, (SELECT bool_and(p.status IN ('READY_FOR_REVIEW', 'NEEDS_ATTENTION')) FROM "AccountantPeriod" p WHERE p."businessId" = 9), NULL
  UNION ALL SELECT 6, NULL, (SELECT count(*) FROM "AccountantPackage" k WHERE k."businessId" = 9 AND k.status = 'READY')
  UNION ALL SELECT 7, NULL, (SELECT count(*) FROM "AccountantPackage" k WHERE k."businessId" = 9 AND k.status = 'FAILED')
  UNION ALL SELECT 8, NULL, (SELECT count(*) FROM ready WHERE c > 1)
  UNION ALL SELECT 9, (SELECT bool_and(k."storageKey" LIKE 'biz/9/exports/accountant/2026-09/%') FROM "AccountantPackage" k
                        WHERE k."businessId" = 9 AND k.status = 'READY'), NULL
  UNION ALL SELECT 10, NULL, (SELECT count(*) FROM "Notification" x WHERE x."businessId" = 9
                               AND x."entityType" LIKE 'accountant\_period%' AND x."resolvedAt" IS NULL)
  UNION ALL SELECT 11, NULL, (SELECT count(*) FROM "AccountantRecipient")
  UNION ALL SELECT 12, NULL, (SELECT count(*) FROM "AccountantDelivery")
  UNION ALL SELECT 13, NULL, (SELECT (SELECT count(*) FROM "AccountantPeriod" WHERE "businessId" <> 9)
                                   + (SELECT count(*) FROM "AccountantPackage" WHERE "businessId" <> 9)
                                   + (SELECT count(*) FROM "AccountantRecipient" WHERE "businessId" <> 9)
                                   + (SELECT count(*) FROM "AccountantDelivery" WHERE "businessId" <> 9)
                                   + (SELECT count(*) FROM "AccountantWorkflowEvent" WHERE "businessId" <> 9))
  UNION ALL SELECT 14, NULL, (SELECT count(*) FROM "Notification" x WHERE x."businessId" <> 9 AND x."entityType" LIKE 'accountant\_period%')
  UNION ALL SELECT 15, NULL, (SELECT count(*) FROM "AccountantWorkflowEvent" e WHERE e."businessId" = 9)
)
SELECT n, flag, observed_count FROM lines ORDER BY n;

ROLLBACK;
