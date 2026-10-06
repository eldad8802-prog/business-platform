-- ============================================================================
-- closed-loop-gate-c-enrollment.sql
--
-- Read-only Production proof before Gate C (Closed Loop Activation): exactly
-- which of businesses 3, 9 and 38 are enrolled for knowledge derivation
-- (feature key knowledge_derivation, explicit ENABLED row), whether the feature
-- is emergency-disabled, and how many successful derive runs each has had.
--
-- Resolves the inventory finding "3 ENABLED rows, set != {3, 9}" (run
-- 37511884914) without listing ids: each business is asked by name in the
-- legend, and the rows carry flags and counts only, so the output survives
-- scripts/ci/evidence-redact.mjs. Nothing is changed.
--
-- OUTPUT: n | flag | observed_count. Guard-clean: no write keyword anywhere.
-- ============================================================================

\echo '== Closed loop Gate C enrollment proof (knowledge_derivation): legend =='
\echo ' 1 business 3 has an ENABLED row (flag)'
\echo ' 2 business 9 has an ENABLED row (flag)'
\echo ' 3 the ENABLED set is exactly businesses {3, 9, 38} (flag)'
\echo ' 4 policy emergencyDisabled is false (flag; null = no policy row)'
\echo ' 5 business 3 successful derive runs (count)'
\echo ' 6 business 9 successful derive runs (count)'
\echo ' 7 business 38 successful derive runs (count)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
enabled AS (SELECT a."businessId" FROM "BusinessFeatureAccess" a
            WHERE a."featureKey" = 'knowledge_derivation' AND a.state::text = 'ENABLED'),
runs AS (SELECT r."businessId", count(*) AS ok_runs FROM "KnowledgeDerivationRun" r
         WHERE r.status::text = 'SUCCEEDED' GROUP BY r."businessId"),
lines(n, flag, observed_count) AS (
            SELECT 1, EXISTS (SELECT 1 FROM enabled WHERE "businessId" = 3), NULL::bigint
  UNION ALL SELECT 2, EXISTS (SELECT 1 FROM enabled WHERE "businessId" = 9), NULL
  UNION ALL SELECT 3, (SELECT coalesce(array_agg("businessId" ORDER BY "businessId"), '{}') = ARRAY[3, 9, 38] FROM enabled), NULL
  UNION ALL SELECT 4, (SELECT NOT p."emergencyDisabled" FROM "PlatformFeaturePolicy" p WHERE p."featureKey" = 'knowledge_derivation'), NULL
  UNION ALL SELECT 5, NULL, coalesce((SELECT ok_runs FROM runs WHERE "businessId" = 3), 0)
  UNION ALL SELECT 6, NULL, coalesce((SELECT ok_runs FROM runs WHERE "businessId" = 9), 0)
  UNION ALL SELECT 7, NULL, coalesce((SELECT ok_runs FROM runs WHERE "businessId" = 38), 0)
)
SELECT n, flag, observed_count FROM lines ORDER BY n;

ROLLBACK;
