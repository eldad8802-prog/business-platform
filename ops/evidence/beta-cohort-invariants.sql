-- ============================================================================
-- beta-cohort-invariants.sql
--
-- Read-only Production INVARIANTS of the closed beta (after migration
--   20261017090000_beta_cohort_enrollment and its application release). Run before the switch is turned
--   on, after each tester signs up, and at any time during the beta. Every check is a count.
--
--   * who is in the beta: enrolled businesses, and that every one of them was enrolled when it was
--     created (no business that existed before the beta can be in it);
--   * nothing the beta closes is held by an enrolled business: no WhatsApp connection, no Meta lead-ads
--     connection, no Tax Authority connection, no Tax Authority submission waiting for an allocation;
--   * INFO: how many businesses are NOT enrolled (everyone else — untouched by the beta policy).
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend. No id, name or address.
-- PRIVACY: counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== beta cohort invariants: legend (n -> check) =='
\echo ' 1 INFO enrolled businesses (observed = rows)'
\echo ' 2 every enrollment names the closed-beta signup source (observed = other sources)'
\echo ' 3 every enrolled business was enrolled at its creation, within 5 minutes (observed = enrolled later: a pre-existing business)'
\echo ' 4 no enrolled business holds a WhatsApp connection row of any status (observed = rows)'
\echo ' 5 no enrolled business holds a Meta lead-ads connection of any status (observed = rows)'
\echo ' 6 no enrolled business holds a Tax Authority connection row of any status (observed = rows)'
\echo ' 7 no enrolled business has a Tax Authority submission that needs an allocation (READY / PENDING / SUBMITTED / HELD / FAILED; observed = rows)'
\echo ' 8 INFO businesses NOT enrolled (observed = rows; the beta policy cannot touch them)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
enr AS (SELECT e."businessId", e."source", e."createdAt" AS enrolled_at, b."createdAt" AS created_at
        FROM "BusinessBetaEnrollment" e JOIN "Business" b ON b.id = e."businessId"),
checks(n, ok, observed_count) AS (
  SELECT 1, true, (SELECT count(*) FROM enr)
  UNION ALL SELECT 2, NOT EXISTS (SELECT 1 FROM enr WHERE "source" <> 'CLOSED_BETA_SIGNUP'),
                      (SELECT count(*) FROM enr WHERE "source" <> 'CLOSED_BETA_SIGNUP')
  UNION ALL SELECT 3, NOT EXISTS (SELECT 1 FROM enr WHERE enrolled_at > created_at + interval '5 minutes'),
                      (SELECT count(*) FROM enr WHERE enrolled_at > created_at + interval '5 minutes')
  UNION ALL SELECT 4, NOT EXISTS (SELECT 1 FROM "WhatsAppConnection" w WHERE w."businessId" IN (SELECT "businessId" FROM enr)),
                      (SELECT count(*) FROM "WhatsAppConnection" w WHERE w."businessId" IN (SELECT "businessId" FROM enr))
  UNION ALL SELECT 5, NOT EXISTS (SELECT 1 FROM "AcquisitionConnection" a WHERE a."sourceKey" = 'meta.lead_ads'
                                    AND a."businessId" IN (SELECT "businessId" FROM enr)),
                      (SELECT count(*) FROM "AcquisitionConnection" a WHERE a."sourceKey" = 'meta.lead_ads'
                                    AND a."businessId" IN (SELECT "businessId" FROM enr))
  UNION ALL SELECT 6, NOT EXISTS (SELECT 1 FROM "BillingAuthorityConnection" c WHERE c."businessId" IN (SELECT "businessId" FROM enr)),
                      (SELECT count(*) FROM "BillingAuthorityConnection" c WHERE c."businessId" IN (SELECT "businessId" FROM enr))
  UNION ALL SELECT 7, NOT EXISTS (SELECT 1 FROM "BillingAuthoritySubmission" s WHERE s."businessId" IN (SELECT "businessId" FROM enr)
                                    AND s."status"::text IN ('READY', 'PENDING', 'SUBMITTED', 'HELD', 'FAILED')),
                      (SELECT count(*) FROM "BillingAuthoritySubmission" s WHERE s."businessId" IN (SELECT "businessId" FROM enr)
                                    AND s."status"::text IN ('READY', 'PENDING', 'SUBMITTED', 'HELD', 'FAILED'))
  UNION ALL SELECT 8, true, (SELECT count(*) FROM "Business" b WHERE b.id NOT IN (SELECT "businessId" FROM enr))
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
