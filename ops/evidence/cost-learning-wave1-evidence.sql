-- Business Cost learning, Wave 1 — read-only Production verification after 20261005090000.
-- SELECT-only (enforced by the workflow's static guard and by a Postgres read-only session).

\echo '== C1 migration ledger: the Wave-1 migration applied, and the latest one'
SELECT migration_name, finished_at IS NOT NULL AS applied_ok, rolled_back_at IS NULL AS not_rolled_back, applied_steps_count
FROM "_prisma_migrations" WHERE migration_name = '20261005090000_cost_learning_wave1_policies';
SELECT count(*) AS total_rows,
       count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS healthy_rows,
       max(migration_name) AS latest_migration
FROM "_prisma_migrations";

\echo '== C2 cost lineages and their versions (expected 4 rows, each exactly v1)'
SELECT p.key AS policy_key, string_agg(v.version, ',' ORDER BY v.version) AS versions
FROM "DerivationPolicy" p LEFT JOIN "DerivationPolicyVersion" v ON v."policyId" = p.id
WHERE p.key IN ('payables-cost-data-completeness', 'payables-recurring-amount-change', 'payables-new-material-commitment', 'payables-ended-commitment')
GROUP BY p.key ORDER BY p.key;
SELECT
  (SELECT count(*) FROM "DerivationPolicy" WHERE key IN ('payables-cost-data-completeness', 'payables-recurring-amount-change', 'payables-new-material-commitment', 'payables-ended-commitment')) AS policy_rows,
  (SELECT count(*) FROM "DerivationPolicyVersion" v JOIN "DerivationPolicy" p ON p.id = v."policyId"
     WHERE p.key IN ('payables-cost-data-completeness', 'payables-recurring-amount-change', 'payables-new-material-commitment', 'payables-ended-commitment')) AS version_rows,
  (SELECT count(*) FROM "DerivationPolicyVersion" v JOIN "DerivationPolicy" p ON p.id = v."policyId"
     WHERE p.key IN ('payables-cost-data-completeness', 'payables-recurring-amount-change', 'payables-new-material-commitment', 'payables-ended-commitment')
       AND v.version <> 'v1') AS non_v1_rows;

\echo '== C3 unexpected cost or Wave-2 lineages (expected 0) and every payables lineage'
SELECT count(*) AS unexpected_cost_or_wave2_rows
FROM "DerivationPolicy"
WHERE (key ILIKE '%cost%' OR key ILIKE '%baseline%' OR key ILIKE '%cadence-change%' OR key ILIKE '%concentration%'
       OR key ILIKE '%cash-out%' OR key = 'temporal-payables-late-share')
  AND key NOT IN ('payables-cost-data-completeness', 'payables-recurring-amount-change', 'payables-new-material-commitment', 'payables-ended-commitment');
SELECT key FROM "DerivationPolicy" WHERE key LIKE 'payables-%' OR key LIKE 'temporal-payables-%' ORDER BY key;

\echo '== C4 knowledge_derivation feature: default, policy, overrides, enrolled (expected enrolled 0)'
SELECT "defaultEnabled" AS default_enabled FROM "PlatformFeatureDefinition" WHERE key = 'knowledge_derivation';
SELECT "globalEnabled" AS global_enabled, "emergencyDisabled" AS emergency_disabled FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'knowledge_derivation';
SELECT count(*) AS override_rows, count(*) FILTER (WHERE state = 'ENABLED') AS enrolled_businesses
FROM "BusinessFeatureAccess" WHERE "featureKey" = 'knowledge_derivation';

\echo '== C5 nothing learned yet (expected 0 cost measures, 0 cost insights)'
SELECT
  (SELECT count(*) FROM "KnowledgeMeasure" WHERE "measureKey" IN ('payables.cost_data_completeness', 'payables.recurring_amount_change', 'payables.new_material_commitment', 'payables.ended_commitment')) AS cost_measures,
  (SELECT count(*) FROM "BusinessInsight" WHERE "insightKey" LIKE 'cost.%') AS cost_insights;

\echo '== C6 RLS posture of the tables this learning reads or writes (expected enabled + forced)'
SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
  AND c.relname IN ('KnowledgeMeasure', 'KnowledgeMeasureEvidenceLink', 'BusinessInsight', 'Commitment', 'Installment', 'Payment', 'PaymentAllocation', 'PayablesAuditEvent')
ORDER BY c.relname;

\echo '== C7 runtime privileges on the lineage tables (for comparison; the migration carries no privilege statements)'
SELECT grantee, table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privileges
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name IN ('DerivationPolicy', 'DerivationPolicyVersion') AND grantee LIKE 'app_%'
GROUP BY grantee, table_name ORDER BY grantee, table_name;
