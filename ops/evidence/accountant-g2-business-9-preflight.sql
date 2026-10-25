-- ============================================================================
-- accountant-g2-business-9-preflight.sql
--
-- Read-only Production preflight before G2.2 of the monthly accountant workflow: the owner chose
-- business 9 as the first (and only) business to enable. Before the business override is set, this
-- proves, from flags and counts only:
--   * business 9 exists, is live (not being deleted), and is the owner's own business (one of its
--     users is the platform admin);
--   * no business has an accountant_month_close override yet, the feature is not emergency-disabled,
--     and business 9 has no accountant row and no accountant notice;
--   * what the first package will hold: business 9's September 2026 (Israel time) records, documents
--     still waiting for review, and issued documents; plus October so far (still open, never prepared).
--
-- Business 9 is named in the legend, and the rows carry flags and counts only, so the output survives
-- scripts/ci/evidence-redact.mjs. September 2026 in Israel time is [2026-08-31 21:00, 2026-09-30 21:00)
-- UTC (summer time, UTC+3), as lib/accountant/period.ts computes it.
--
-- OUTPUT: n | flag | observed_count. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== accountant G2.2 preflight for business 9: legend =='
\echo ' 1 business 9 exists (flag)'
\echo ' 2 business 9 is live: no deletion requested, not erased (flag)'
\echo ' 3 business 9 is the owner business: one of its users is the platform admin (flag)'
\echo ' 4 users of business 9 (count)'
\echo ' 5 platform admin users in total (count)'
\echo ' 6 accountant_month_close override rows for business 9 (count; expected 0)'
\echo ' 7 accountant_month_close override rows for ANY business (count; expected 0)'
\echo ' 8 the feature is not emergency-disabled (flag; null = no policy row)'
\echo ' 9 accountant rows of business 9: periods + packages + recipients + deliveries + trail (count; expected 0)'
\echo '10 accountant notices of business 9 (count; expected 0)'
\echo '11 business 9 September 2026 approved financial records (count)'
\echo '12 business 9 September 2026 documents still waiting for review (count)'
\echo '13 business 9 September 2026 issued billing documents (count)'
\echo '14 business 9 October 2026 financial records so far (count; the month is open)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
sep AS (SELECT timestamp '2026-08-31 21:00:00' AS lo, timestamp '2026-09-30 21:00:00' AS hi),
oct AS (SELECT timestamp '2026-09-30 21:00:00' AS lo, timestamp '2026-10-31 22:00:00' AS hi),
lines(n, flag, observed_count) AS (
            SELECT 1, EXISTS (SELECT 1 FROM "Business" b WHERE b."id" = 9), NULL::bigint
  UNION ALL SELECT 2, EXISTS (SELECT 1 FROM "Business" b WHERE b."id" = 9 AND b."deletionRequestedAt" IS NULL AND b."deletedAt" IS NULL), NULL
  UNION ALL SELECT 3, EXISTS (SELECT 1 FROM "User" u WHERE u."businessId" = 9 AND u."role"::text = 'PLATFORM_ADMIN'), NULL
  UNION ALL SELECT 4, NULL, (SELECT count(*) FROM "User" u WHERE u."businessId" = 9)
  UNION ALL SELECT 5, NULL, (SELECT count(*) FROM "User" u WHERE u."role"::text = 'PLATFORM_ADMIN')
  UNION ALL SELECT 6, NULL, (SELECT count(*) FROM "BusinessFeatureAccess" a WHERE a."businessId" = 9 AND a."featureKey" = 'accountant_month_close')
  UNION ALL SELECT 7, NULL, (SELECT count(*) FROM "BusinessFeatureAccess" a WHERE a."featureKey" = 'accountant_month_close')
  UNION ALL SELECT 8, (SELECT NOT p."emergencyDisabled" FROM "PlatformFeaturePolicy" p WHERE p."featureKey" = 'accountant_month_close'), NULL
  UNION ALL SELECT 9, NULL, (SELECT (SELECT count(*) FROM "AccountantPeriod" WHERE "businessId" = 9)
                                  + (SELECT count(*) FROM "AccountantPackage" WHERE "businessId" = 9)
                                  + (SELECT count(*) FROM "AccountantRecipient" WHERE "businessId" = 9)
                                  + (SELECT count(*) FROM "AccountantDelivery" WHERE "businessId" = 9)
                                  + (SELECT count(*) FROM "AccountantWorkflowEvent" WHERE "businessId" = 9))
  UNION ALL SELECT 10, NULL, (SELECT count(*) FROM "Notification" x WHERE x."businessId" = 9 AND x."entityType" LIKE 'accountant\_period%')
  UNION ALL SELECT 11, NULL, (SELECT count(*) FROM "FinancialRecord" r, sep WHERE r."businessId" = 9 AND r."date" >= sep.lo AND r."date" < sep.hi)
  UNION ALL SELECT 12, NULL, (SELECT count(*) FROM "Document" d, sep WHERE d."businessId" = 9 AND d."status" = 'needs_review' AND d."createdAt" >= sep.lo AND d."createdAt" < sep.hi)
  UNION ALL SELECT 13, NULL, (SELECT count(*) FROM "BillingDocument" g, sep WHERE g."businessId" = 9 AND g."status"::text = 'ISSUED' AND g."issuedAt" >= sep.lo AND g."issuedAt" < sep.hi)
  UNION ALL SELECT 14, NULL, (SELECT count(*) FROM "FinancialRecord" r, oct WHERE r."businessId" = 9 AND r."date" >= oct.lo AND r."date" < oct.hi)
)
SELECT n, flag, observed_count FROM lines ORDER BY n;

ROLLBACK;
