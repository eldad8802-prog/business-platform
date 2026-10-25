-- ============================================================================
-- accountant-g2-business-9-identity.sql
--
-- Read-only Production identity check for business 9 before G2.2 of the monthly accountant workflow.
-- The platform-admin flag of accountant-g2-business-9-preflight.sql is one signal; this file adds
-- signals the owner can compare with what they see in the app (counts of their own documents,
-- customers, leads, suppliers, issued documents, tasks), plus history only the owner's business
-- has (the most owner decisions, the knowledge-derivation enrollment) and recent use.
--
-- Flags and counts only — no id value, name, address, amount or text reaches the log
-- (scripts/ci/evidence-redact.mjs). Business 9 is named in the legend only.
--
-- OUTPUT: n | flag | observed_count. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== accountant G2.2 identity check for business 9: legend =='
\echo ' 1 documents of business 9, all time (count)'
\echo ' 2 approved documents of business 9 (count)'
\echo ' 3 active customers of business 9 (count)'
\echo ' 4 leads of business 9 (count)'
\echo ' 5 suppliers of business 9 (count)'
\echo ' 6 issued billing documents of business 9, all time (count)'
\echo ' 7 tasks of business 9, not erased (count)'
\echo ' 8 owner decisions (review events) of business 9 (count)'
\echo ' 9 business 9 has the most owner decisions of all businesses (flag)'
\echo '10 business 9 is enrolled in knowledge derivation (flag)'
\echo '11 a user of business 9 used a session in the last 7 days (flag)'
\echo '12 business 9 is the only business with a platform admin (flag)'
\echo '13 days since business 9 was opened (count)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
rev AS (SELECT e."businessId", count(*) AS c FROM "ReviewEvent" e GROUP BY e."businessId"),
lines(n, flag, observed_count) AS (
            SELECT 1, NULL::boolean, (SELECT count(*) FROM "Document" d WHERE d."businessId" = 9)
  UNION ALL SELECT 2, NULL, (SELECT count(*) FROM "Document" d WHERE d."businessId" = 9 AND d."status" = 'approved')
  UNION ALL SELECT 3, NULL, (SELECT count(*) FROM "Customer" c WHERE c."businessId" = 9 AND c."isActive")
  UNION ALL SELECT 4, NULL, (SELECT count(*) FROM "Lead" l WHERE l."businessId" = 9)
  UNION ALL SELECT 5, NULL, (SELECT count(*) FROM "Supplier" s WHERE s."businessId" = 9)
  UNION ALL SELECT 6, NULL, (SELECT count(*) FROM "BillingDocument" g WHERE g."businessId" = 9 AND g."status"::text = 'ISSUED')
  UNION ALL SELECT 7, NULL, (SELECT count(*) FROM "Task" t WHERE t."businessId" = 9 AND t."erasedAt" IS NULL)
  UNION ALL SELECT 8, NULL, coalesce((SELECT c FROM rev WHERE "businessId" = 9), 0)
  UNION ALL SELECT 9, coalesce((SELECT c FROM rev WHERE "businessId" = 9), 0) > 0
                     AND coalesce((SELECT c FROM rev WHERE "businessId" = 9), 0) = (SELECT max(c) FROM rev), NULL
  UNION ALL SELECT 10, EXISTS (SELECT 1 FROM "BusinessFeatureAccess" a WHERE a."businessId" = 9
                                AND a."featureKey" = 'knowledge_derivation' AND a.state::text = 'ENABLED'), NULL
  UNION ALL SELECT 11, EXISTS (SELECT 1 FROM "AuthSession" x JOIN "User" u ON u."id" = x."userId"
                                WHERE u."businessId" = 9 AND x."lastUsedAt" >= now() - interval '7 days'), NULL
  UNION ALL SELECT 12, (SELECT array_agg(DISTINCT u."businessId") FROM "User" u WHERE u."role"::text = 'PLATFORM_ADMIN') = ARRAY[9], NULL
  UNION ALL SELECT 13, NULL, (SELECT (current_date - b."createdAt"::date)::bigint FROM "Business" b WHERE b."id" = 9)
)
SELECT n, flag, observed_count FROM lines ORDER BY n;

ROLLBACK;
