-- Business Cost learning, Wave 1 — read-only Production verification after 20261005090000.
-- SELECT-only (static guard + Postgres read-only session). Every result is ASSERT-SHAPED — booleans and
-- *_count integers — because the public Actions log redacts every other cell (scripts/ci/evidence-redact.mjs).

\echo '== C1 migration ledger'
SELECT
  EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261005090000_cost_learning_wave1_policies'
            AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS wave1_migration_applied,
  (SELECT count(*) FROM "_prisma_migrations") AS ledger_row_count,
  (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS healthy_row_count,
  (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) AS unhealthy_row_count,
  (SELECT max(migration_name) FROM "_prisma_migrations") = '20261005090000_cost_learning_wave1_policies' AS wave1_is_latest_applied;

\echo '== C2 the four cost lineages, each with exactly v1'
WITH k(key) AS (VALUES ('payables-cost-data-completeness'), ('payables-recurring-amount-change'),
                       ('payables-new-material-commitment'), ('payables-ended-commitment')),
     v AS (SELECT p.key, dv.version FROM "DerivationPolicy" p JOIN k ON k.key = p.key
           LEFT JOIN "DerivationPolicyVersion" dv ON dv."policyId" = p.id)
SELECT
  (SELECT count(DISTINCT key) FROM v) AS policy_row_count,
  (SELECT count(*) FROM v WHERE version IS NOT NULL) AS version_row_count,
  (SELECT count(*) FROM v WHERE version IS NOT NULL AND version <> 'v1') AS non_v1_version_count,
  (SELECT count(DISTINCT key) FROM v) = 4 AS all_four_present,
  NOT EXISTS (SELECT 1 FROM k WHERE (SELECT count(*) FROM v WHERE v.key = k.key AND v.version = 'v1') <> 1
                                 OR (SELECT count(*) FROM v WHERE v.key = k.key) <> 1) AS each_exactly_v1;

\echo '== C3 no unexpected cost or Wave-2 lineage'
SELECT count(*) AS unexpected_lineage_count
FROM "DerivationPolicy"
WHERE (key ILIKE '%cost%' OR key ILIKE '%baseline%' OR key ILIKE '%cadence-change%' OR key ILIKE '%concentration%'
       OR key ILIKE '%cash-out%' OR key = 'temporal-payables-late-share')
  AND key NOT IN ('payables-cost-data-completeness', 'payables-recurring-amount-change', 'payables-new-material-commitment', 'payables-ended-commitment');

\echo '== C4 knowledge_derivation: off by default, no business enrolled'
SELECT
  (SELECT "defaultEnabled" FROM "PlatformFeatureDefinition" WHERE key = 'knowledge_derivation') AS default_enabled,
  (SELECT "globalEnabled" FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'knowledge_derivation') AS global_enabled,
  (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'knowledge_derivation') AS override_count,
  (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'knowledge_derivation' AND state = 'ENABLED') AS enrolled_count;

\echo '== C5 nothing learned yet'
SELECT
  (SELECT count(*) FROM "KnowledgeMeasure" WHERE "measureKey" IN ('payables.cost_data_completeness', 'payables.recurring_amount_change',
                                                                 'payables.new_material_commitment', 'payables.ended_commitment')) AS cost_measure_count,
  (SELECT count(*) FROM "BusinessInsight" WHERE "insightKey" LIKE 'cost.%') AS cost_insight_count;

\echo '== C6 RLS posture of the eight tables this learning reads or writes'
SELECT
  count(*) AS table_count,
  count(*) FILTER (WHERE c.relrowsecurity) AS rls_enabled_count,
  count(*) FILTER (WHERE c.relforcerowsecurity) AS rls_forced_count
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
  AND c.relname IN ('KnowledgeMeasure', 'KnowledgeMeasureEvidenceLink', 'BusinessInsight', 'Commitment', 'Installment', 'Payment', 'PaymentAllocation', 'PayablesAuditEvent');

\echo '== C7 runtime privileges on the lineage tables (the migration carries no privilege statement)'
SELECT
  has_table_privilege('app_runtime', '"DerivationPolicy"', 'SELECT') AS runtime_can_read_policy,
  has_table_privilege('app_runtime', '"DerivationPolicyVersion"', 'SELECT') AS runtime_can_read_version;
