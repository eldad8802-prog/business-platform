-- ============================================================================
-- cost-learning-wave1-verdict.sql
--
-- Read-only Production VERDICT for migration
--   20261005090000_cost_learning_wave1_policies   (#609, applied by release-migrate 36952624032)
--
-- The descriptive file (cost-learning-wave1-evidence.sql) prints names and counts that the
-- evidence redactor hides in a public log. This file asserts the same facts as PASS/FAIL, so the
-- verdict survives redaction: the migration inserted EXACTLY its 4 lineages (exact key + name)
-- and EXACTLY one 'v1' version each — 8 rows — and nothing else changed state: no other cost /
-- Wave-2 lineage, nobody enrolled, nothing learned.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger, governance rows and counts — no tenant row content.
-- Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== cost learning wave 1 verdict — legend (n → check) =='
\echo ' 1 L1 20261005090000_cost_learning_wave1_policies recorded: finished, not rolled back, 1 step'
\echo ' 2 L2 migration ledger: no unfinished and no rolled-back row (observed = such rows)'
\echo ' 3 L3 finished migrations (INFO count; 165 expected)'
\echo ' 4 L4 the latest finished migration is 20261005090000_cost_learning_wave1_policies'
\echo ' 5 P1 exactly 4 lineages carry the Wave-1 keys (observed = rows)'
\echo ' 6 P2 each of the 4 carries exactly the reviewed name (observed = matching rows)'
\echo ' 7 V1 exactly 4 version rows for those lineages (observed = rows)'
\echo ' 8 V2 every one of them is v1, one per lineage (observed = lineages with exactly one v1 and nothing else)'
\echo ' 9 X1 no other cost / Wave-2 lineage exists (observed = rows)'
\echo '10 E1 knowledge_derivation: nobody enrolled (observed = ENABLED overrides)'
\echo '11 E2 knowledge_derivation: not globally enabled'
\echo '12 K1 nothing learned yet: cost measures (observed = rows)'
\echo '13 K2 nothing learned yet: cost insights (observed = rows)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
w1(key, name) AS (VALUES
  ('payables-cost-data-completeness',  'COST-08 · cost data completeness / eligibility gate'),
  ('payables-recurring-amount-change', 'COST-02 · a recorded recurring cost changed amount'),
  ('payables-new-material-commitment', 'COST-04 · a genuinely new recurring commitment, material vs the previous baseline'),
  ('payables-ended-commitment',        'COST-05 · a recurring commitment explicitly ended')),
ledger AS (SELECT migration_name, finished_at, rolled_back_at, applied_steps_count FROM "_prisma_migrations"),
pol AS (SELECT p.id, p.key, p.name FROM "DerivationPolicy" p WHERE p.key IN (SELECT key FROM w1)),
ver AS (SELECT v."policyId", v.version FROM "DerivationPolicyVersion" v WHERE v."policyId" IN (SELECT id FROM pol)),
checks(n, ok, observed_count) AS (
  SELECT 1, EXISTS (SELECT 1 FROM ledger WHERE migration_name = '20261005090000_cost_learning_wave1_policies'
                     AND finished_at IS NOT NULL AND rolled_back_at IS NULL AND applied_steps_count = 1),
            (SELECT count(*) FROM ledger WHERE migration_name = '20261005090000_cost_learning_wave1_policies')
  UNION ALL SELECT 2, (SELECT count(*) FROM ledger WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM ledger WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, true, (SELECT count(*) FROM ledger WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 4, (SELECT max(migration_name) FROM ledger WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)
                        = '20261005090000_cost_learning_wave1_policies', 1
  UNION ALL SELECT 5, (SELECT count(*) FROM pol) = 4, (SELECT count(*) FROM pol)
  UNION ALL SELECT 6, (SELECT count(*) FROM pol JOIN w1 USING (key) WHERE pol.name = w1.name) = 4,
                      (SELECT count(*) FROM pol JOIN w1 USING (key) WHERE pol.name = w1.name)
  UNION ALL SELECT 7, (SELECT count(*) FROM ver) = 4, (SELECT count(*) FROM ver)
  UNION ALL SELECT 8, (SELECT count(*) FROM pol p WHERE (SELECT count(*) FROM ver WHERE "policyId" = p.id) = 1
                         AND (SELECT count(*) FROM ver WHERE "policyId" = p.id AND version = 'v1') = 1) = 4,
                      (SELECT count(*) FROM pol p WHERE (SELECT count(*) FROM ver WHERE "policyId" = p.id) = 1
                         AND (SELECT count(*) FROM ver WHERE "policyId" = p.id AND version = 'v1') = 1)
  UNION ALL SELECT 9, (SELECT count(*) FROM "DerivationPolicy"
                        WHERE (key ILIKE '%cost%' OR key ILIKE '%baseline%' OR key ILIKE '%cadence-change%' OR key ILIKE '%concentration%'
                               OR key ILIKE '%cash-out%' OR key = 'temporal-payables-late-share')
                          AND key NOT IN (SELECT key FROM w1)) = 0,
                      (SELECT count(*) FROM "DerivationPolicy"
                        WHERE (key ILIKE '%cost%' OR key ILIKE '%baseline%' OR key ILIKE '%cadence-change%' OR key ILIKE '%concentration%'
                               OR key ILIKE '%cash-out%' OR key = 'temporal-payables-late-share')
                          AND key NOT IN (SELECT key FROM w1))
  UNION ALL SELECT 10, (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'knowledge_derivation' AND state = 'ENABLED') = 0,
                       (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'knowledge_derivation' AND state = 'ENABLED')
  UNION ALL SELECT 11, NOT EXISTS (SELECT 1 FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'knowledge_derivation' AND "globalEnabled"), 1
  UNION ALL SELECT 12, (SELECT count(*) FROM "KnowledgeMeasure" WHERE "measureKey" IN ('payables.cost_data_completeness', 'payables.recurring_amount_change',
                                                                                   'payables.new_material_commitment', 'payables.ended_commitment')) = 0,
                       (SELECT count(*) FROM "KnowledgeMeasure" WHERE "measureKey" IN ('payables.cost_data_completeness', 'payables.recurring_amount_change',
                                                                                   'payables.new_material_commitment', 'payables.ended_commitment'))
  UNION ALL SELECT 13, (SELECT count(*) FROM "BusinessInsight" WHERE "insightKey" LIKE 'cost.%') = 0,
                       (SELECT count(*) FROM "BusinessInsight" WHERE "insightKey" LIKE 'cost.%')
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
