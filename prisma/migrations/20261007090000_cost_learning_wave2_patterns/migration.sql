-- Business Cost learning — Wave 2 PATTERN rule lineages (COST-01, COST-06, COST-07).
--
-- GOVERNANCE ROWS ONLY. No table, column, index, RLS policy or privilege change. Without these rows
-- the three PATTERN rules fail closed at the policy stage and learn nothing.
--
-- Detection parameters are versioned in code (lib/knowledge/rules/cost.ts, COST_POLICY_PARAMS) under
-- the same (key, version) identity and recorded in every measure's detail. Each rule is gated by COST-08:
-- below its trustworthy-history / covered-window minimum it stores INSUFFICIENT_EVIDENCE, never a pattern.
-- T-AP-03 stays BLOCKED (paid-date provenance) and is deliberately NOT registered.
-- Learning still runs only for businesses enrolled in knowledge_derivation (default off). Idempotent.

INSERT INTO "DerivationPolicy" ("key", "name") VALUES
  ('payables-baseline-shift',         'COST-01 · sustained change in the recorded monthly baseline (PATTERN)'),
  ('payables-upcoming-concentration', 'COST-06 · upcoming payments above every covered historical window (PATTERN)'),
  ('payables-cash-out-above-range',   'COST-07 · recorded cash out above every covered historical window (PATTERN)')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "DerivationPolicyVersion" ("policyId", "version")
SELECT p."id", 'v1'
FROM "DerivationPolicy" p
WHERE p."key" IN ('payables-baseline-shift', 'payables-upcoming-concentration', 'payables-cash-out-above-range')
ON CONFLICT ("policyId", "version") DO NOTHING;
