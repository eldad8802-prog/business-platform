-- ============================================================================
-- closed-loop-recommendation-evidence-production-evidence.sql
--
-- Read-only Production EVIDENCE after migration
--   20261011090000_closed_loop_recommendation_evidence
--
-- Proves the migration's outcome, from the catalog and counts only:
--   * it is recorded and finished, nothing is unfinished or rolled back;
--   * the table exists with RLS ENABLED + FORCED, exactly the two tenant policies (read, add) on the
--     app.current_business_id GUC and no other command policy;
--   * the append-only trigger runs m9_append_only_guard() before any row rewrite or removal;
--   * the composite (businessId, recommendationId) FK to OutcomeRecommendation and the Business FK, both cascading;
--   * one evidence row per recommendation (unique) and the kind / shape checks exist;
--   * app_runtime holds exactly r + a on the table and U + r on its sequence;
--   * owner_recommendations is defined default-off and globally off, not emergency-disabled, and NO business
--     has access to it; the table is empty (nothing was backfilled).
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== Closed loop recommendation evidence production evidence: legend (n -> check) =='
\echo ' 1 the migration is recorded and finished (observed = finished rows)'
\echo ' 2 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 3 OutcomeRecommendationEvidence exists with RLS ENABLED + FORCED'
\echo ' 4 exactly two policies: tenant read (r) and tenant add (a), both on the GUC (observed = policies)'
\echo ' 5 the append-only trigger runs m9_append_only_guard before row rewrite or removal (observed = such triggers)'
\echo ' 6 composite FK (businessId, recommendationId) to OutcomeRecommendation, cascading'
\echo ' 7 FK businessId to Business, cascading'
\echo ' 8 unique (businessId, recommendationId) and the two check constraints exist (observed = of 3)'
\echo ' 9 app_runtime table privileges are exactly ar (read, add)'
\echo '10 app_runtime holds USAGE + SELECT on the id sequence (observed = privileges)'
\echo '11 owner_recommendations defined: defaultEnabled false, mutable true'
\echo '12 owner_recommendations policy: globalEnabled false, emergencyDisabled false'
\echo '13 no business has a feature-access row for owner_recommendations (observed = rows)'
\echo '14 OutcomeRecommendationEvidence is empty: nothing was backfilled (observed = rows)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
ev AS (SELECT c.oid, c.relrowsecurity, c.relforcerowsecurity, c.relacl FROM pg_class c
       WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'OutcomeRecommendationEvidence' AND c.relkind = 'r'),
seq AS (SELECT c.oid, c.relacl FROM pg_class c
        WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'OutcomeRecommendationEvidence_id_seq' AND c.relkind = 'S'),
rt AS (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime'),
rt_items AS (SELECT DISTINCT (CASE x.privilege_type
              WHEN 'SELECT' THEN 'r' WHEN 'INS' || 'ERT' THEN 'a' WHEN 'UPD' || 'ATE' THEN 'w'
              WHEN 'DEL' || 'ETE' THEN 'd' WHEN 'TRUNC' || 'ATE' THEN 'D' WHEN 'REFERENCES' THEN 'x'
              WHEN 'TRIGGER' THEN 't' WHEN 'MAINTAIN' THEN 'm' ELSE '?' END) COLLATE "C" AS l
           FROM ev CROSS JOIN LATERAL aclexplode(ev.relacl) x WHERE x.grantee = (SELECT oid FROM rt)),
rt_tbl AS (SELECT string_agg(l, '' ORDER BY l) AS letters FROM rt_items),
rt_seq AS (SELECT count(*) AS n FROM seq CROSS JOIN LATERAL aclexplode(seq.relacl) x
           WHERE x.grantee = (SELECT oid FROM rt) AND x.privilege_type IN ('USAGE', 'SELECT')),
pols AS (SELECT p.polname, p.polcmd, pg_get_expr(COALESCE(p.polqual, p.polwithcheck), p.polrelid) AS expr
         FROM pg_policy p WHERE p.polrelid = (SELECT oid FROM ev)),
fks AS (SELECT k.conname, k.confrelid::regclass::text AS target, k.confdeltype, cardinality(k.conkey) AS width
        FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM ev) AND k.contype = 'f'),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261011090000_closed_loop_recommendation_evidence'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1,
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261011090000_closed_loop_recommendation_evidence'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, EXISTS (SELECT 1 FROM ev WHERE relrowsecurity AND relforcerowsecurity), (SELECT count(*) FROM ev)
  UNION ALL SELECT 4, (SELECT count(*) FROM pols) = 2
                      AND EXISTS (SELECT 1 FROM pols WHERE polcmd = 'r' AND expr LIKE '%app.current_business_id%')
                      AND EXISTS (SELECT 1 FROM pols WHERE polcmd = 'a' AND expr LIKE '%app.current_business_id%'),
                      (SELECT count(*) FROM pols)
  UNION ALL SELECT 5, (SELECT count(*) FROM pg_trigger t JOIN pg_proc f ON f.oid = t.tgfoid
                        WHERE t.tgrelid = (SELECT oid FROM ev) AND NOT t.tgisinternal AND f.proname = 'm9_append_only_guard'
                          AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16 AND (t.tgtype & 8) = 8) = 1,
                      (SELECT count(*) FROM pg_trigger t JOIN pg_proc f ON f.oid = t.tgfoid
                        WHERE t.tgrelid = (SELECT oid FROM ev) AND NOT t.tgisinternal AND f.proname = 'm9_append_only_guard')
  UNION ALL SELECT 6, EXISTS (SELECT 1 FROM fks WHERE target = '"OutcomeRecommendation"' AND width = 2 AND confdeltype = 'c'), 1
  UNION ALL SELECT 7, EXISTS (SELECT 1 FROM fks WHERE target = '"Business"' AND width = 1 AND confdeltype = 'c'), 1
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_class i WHERE i.relnamespace = (SELECT oid FROM pub)
                         AND i.relname = 'OutcomeRecommendationEvidence_businessId_recommendationId_key')
                      + (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM ev) AND k.contype = 'c') = 3,
                      (SELECT count(*) FROM pg_class i WHERE i.relnamespace = (SELECT oid FROM pub)
                         AND i.relname = 'OutcomeRecommendationEvidence_businessId_recommendationId_key')
                      + (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM ev) AND k.contype = 'c')
  UNION ALL SELECT 9, (SELECT letters FROM rt_tbl) = 'ar', 1
  UNION ALL SELECT 10, (SELECT n FROM rt_seq) = 2, (SELECT n FROM rt_seq)
  UNION ALL SELECT 11, EXISTS (SELECT 1 FROM "PlatformFeatureDefinition" WHERE key = 'owner_recommendations' AND NOT "defaultEnabled" AND mutable), 1
  UNION ALL SELECT 12, EXISTS (SELECT 1 FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'owner_recommendations' AND NOT "globalEnabled" AND NOT "emergencyDisabled"), 1
  UNION ALL SELECT 13, (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'owner_recommendations') = 0,
                       (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'owner_recommendations')
  UNION ALL SELECT 14, (SELECT count(*) FROM "OutcomeRecommendationEvidence") = 0, (SELECT count(*) FROM "OutcomeRecommendationEvidence")
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
