-- Business Cost learning — Wave 1 rule lineages (COST-08, COST-02, COST-04, COST-05).
--
-- GOVERNANCE ROWS ONLY. No table, no column, no index, no RLS policy, no grant changes. The resolver
-- is fail-closed: a cost rule whose lineage is missing refuses to write rather than producing an
-- unversioned artifact, so without these rows the four rules fail at the "policy" stage and nothing
-- is learned.
--
-- Detection parameters are versioned in code (lib/knowledge/rules/cost.ts, COST_POLICY_PARAMS) under
-- the same (key, version) identity and recorded in every measure's detail. A threshold change is a new
-- version row, never an edit of v1.
--
-- Wave 2 policies (COST-01, COST-03, COST-06, COST-07, T-AP-03) are deliberately NOT registered here.
-- Learning still runs only for businesses enrolled in the knowledge_derivation feature (default off).
-- Idempotent.

INSERT INTO "DerivationPolicy" ("key", "name") VALUES
  ('payables-cost-data-completeness',  'COST-08 · cost data completeness / eligibility gate'),
  ('payables-recurring-amount-change', 'COST-02 · a recorded recurring cost changed amount'),
  ('payables-new-material-commitment', 'COST-04 · a genuinely new recurring commitment, material vs the previous baseline'),
  ('payables-ended-commitment',        'COST-05 · a recurring commitment explicitly ended')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "DerivationPolicyVersion" ("policyId", "version")
SELECT p."id", 'v1'
FROM "DerivationPolicy" p
WHERE p."key" IN (
  'payables-cost-data-completeness', 'payables-recurring-amount-change',
  'payables-new-material-commitment', 'payables-ended-commitment'
)
ON CONFLICT ("policyId", "version") DO NOTHING;
