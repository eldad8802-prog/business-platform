-- Business Cost learning — read-only verification of EVERY cost lineage (Wave 1 FACT + Wave 2 PATTERN).
-- Assert-shaped only (booleans and *_count integers) for the public-log redaction filter.

\echo '== L1 migration ledger: both cost migrations applied, ledger healthy'
SELECT
  EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261005090000_cost_learning_wave1_policies'
            AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS wave1_migration_applied,
  EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261007090000_cost_learning_wave2_patterns'
            AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS wave2_migration_applied,
  (SELECT count(*) FROM "_prisma_migrations") AS ledger_row_count,
  (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) AS unhealthy_row_count;

\echo '== L2 Wave 1 (4 FACT lineages) and Wave 2 (3 PATTERN lineages), each with exactly v1'
WITH k(key, wave) AS (VALUES
       ('payables-cost-data-completeness', 1), ('payables-recurring-amount-change', 1),
       ('payables-new-material-commitment', 1), ('payables-ended-commitment', 1),
       ('payables-baseline-shift', 2), ('payables-upcoming-concentration', 2), ('payables-cash-out-above-range', 2)),
     v AS (SELECT k.key, k.wave, dv.version FROM k JOIN "DerivationPolicy" p ON p.key = k.key
           LEFT JOIN "DerivationPolicyVersion" dv ON dv."policyId" = p.id)
SELECT
  (SELECT count(DISTINCT key) FROM v WHERE wave = 1) AS wave1_policy_row_count,
  (SELECT count(*) FROM v WHERE wave = 1 AND version IS NOT NULL) AS wave1_version_row_count,
  (SELECT count(DISTINCT key) FROM v WHERE wave = 2) AS wave2_policy_row_count,
  (SELECT count(*) FROM v WHERE wave = 2 AND version IS NOT NULL) AS wave2_version_row_count,
  (SELECT count(*) FROM v WHERE version IS NOT NULL AND version <> 'v1') AS non_v1_version_count,
  NOT EXISTS (SELECT 1 FROM k WHERE (SELECT count(*) FROM v WHERE v.key = k.key AND v.version = 'v1') <> 1
                                 OR (SELECT count(*) FROM v WHERE v.key = k.key) <> 1) AS each_exactly_v1;

\echo '== L3 no unexpected cost lineage (expected 0; the five known non-cost cadence lineages are named and excluded)'
SELECT count(*) AS unexpected_lineage_count
FROM "DerivationPolicy"
WHERE (key ILIKE '%cost%' OR key ILIKE '%baseline%' OR key ILIKE '%cadence%' OR key ILIKE '%concentration%'
       OR key ILIKE '%cash-out%' OR key ILIKE '%structure%' OR key ILIKE '%season%' OR key ILIKE '%behavio%'
       OR key = 'temporal-payables-late-share')
  AND key NOT IN ('payables-cost-data-completeness', 'payables-recurring-amount-change', 'payables-new-material-commitment',
                  'payables-ended-commitment', 'payables-baseline-shift', 'payables-upcoming-concentration',
                  'payables-cash-out-above-range')
  -- Pre-existing NON-cost lineages the broad patterns also match (M4/M6 cadence rules of other domains):
  AND key NOT IN ('documents-vendor-billing-cadence', 'suppliers-purchase-cadence', 'temporal-documents-vendor-cadence',
                  'temporal-inventory-restock-cadence', 'temporal-suppliers-purchase-cadence');

\echo '== L4 enrollment unchanged, nothing new learned since the last derive'
SELECT
  (SELECT "defaultEnabled" FROM "PlatformFeatureDefinition" WHERE key = 'knowledge_derivation') AS default_enabled,
  (SELECT "globalEnabled" FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'knowledge_derivation') AS global_enabled,
  (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'knowledge_derivation' AND state = 'ENABLED') AS enrolled_count,
  (SELECT count(*) FROM "KnowledgeMeasure" WHERE "measureKey" IN ('payables.baseline_shift', 'payables.upcoming_concentration',
                                                                 'payables.cash_out_above_range')) AS pattern_measure_count,
  (SELECT count(*) FROM "BusinessInsight" WHERE "insightKey" IN ('cost.baseline_shift', 'cost.upcoming_concentration',
                                                                'cost.cash_out_above_range')) AS pattern_insight_count;

\echo '== L5 RLS posture of the eight tables this learning reads or writes'
SELECT count(*) AS table_count,
       count(*) FILTER (WHERE c.relrowsecurity) AS rls_enabled_count,
       count(*) FILTER (WHERE c.relforcerowsecurity) AS rls_forced_count
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
  AND c.relname IN ('KnowledgeMeasure', 'KnowledgeMeasureEvidenceLink', 'BusinessInsight', 'Commitment', 'Installment', 'Payment', 'PaymentAllocation', 'PayablesAuditEvent');
