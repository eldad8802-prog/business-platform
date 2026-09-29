-- ============================================================================
-- m4-identity-routing-preflight.sql
--
-- Read-only Production preflight for Business Intake M4, migration
--   20261001090000_m4_identity_routing
-- which adds two tables (IdentityLink, IdentityProposal) with composite
-- (businessId, id) references to Customer / Lead / IntakeEvent, eight
-- nullable / defaulted columns + four CHECKs on IntakeNormalizedEvent, and
-- tenant isolation for the two new tables.
--
--   V1   server_version_num >= 150000 (the migration's own guard; the
--        column-list form of the SET NULL referential action needs PG 15).
--   P1-P3 the composite keys M4 references are present (from sec-C and M3):
--        Customer_businessId_id_key, Lead_businessId_id_key,
--        IntakeEvent_businessId_id_key (constraint or index).
--   N1   neither new table name is taken.
--   N2   none of the eight new IntakeNormalizedEvent column names is taken.
--   N3   none of the new constraint / index / policy names is taken.
--   L1   the M4 migration is not in the ledger yet; L2 ledger has no
--        unfinished or rolled-back row.
--   R1   role app_runtime exists (INFO: the privilege block is guarded).
--   S1-S5 row count and total size of the tables the migration locks
--        (INFO, for estimating how long those table modes are held): IntakeNormalizedEvent takes
--        ACCESS EXCLUSIVE for the column + CHECK step (the CHECKs scan it);
--        Customer, Lead, IntakeEvent and Business take SHARE ROW EXCLUSIVE
--        while the new, EMPTY tables get their references.
--
-- PRIVACY: every result is a count, a size, a version number or a catalog
-- flag. No data row, id, name, phone, email or message text is ever selected.
--
-- HONEST COUNTS: row_security is off for this transaction; a role subject to
-- row-level security raises an error instead of an undercount.
--
-- Guard-clean: the workflow rejects this file if it contains any write
-- keyword, prose included, so the wording deliberately avoids those words.
-- ============================================================================

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

WITH
checks(ord, check_name, observed, pass) AS (
  SELECT 1, 'V1 server_version_num >= 150000',
    current_setting('server_version_num'),
    current_setting('server_version_num')::int >= 150000
  UNION ALL
  SELECT 2, 'P1 Customer_businessId_id_key present',
    ((SELECT count(*) FROM pg_constraint WHERE conname = 'Customer_businessId_id_key')
      + (SELECT count(*) FROM pg_class WHERE relname = 'Customer_businessId_id_key' AND relkind = 'i'))::text,
    EXISTS (SELECT 1 FROM pg_class WHERE relname = 'Customer_businessId_id_key' AND relkind = 'i')
  UNION ALL
  SELECT 3, 'P2 Lead_businessId_id_key present',
    ((SELECT count(*) FROM pg_constraint WHERE conname = 'Lead_businessId_id_key')
      + (SELECT count(*) FROM pg_class WHERE relname = 'Lead_businessId_id_key' AND relkind = 'i'))::text,
    EXISTS (SELECT 1 FROM pg_class WHERE relname = 'Lead_businessId_id_key' AND relkind = 'i')
  UNION ALL
  SELECT 4, 'P3 IntakeEvent_businessId_id_key present',
    (SELECT count(*) FROM pg_class WHERE relname = 'IntakeEvent_businessId_id_key' AND relkind = 'i')::text,
    EXISTS (SELECT 1 FROM pg_class WHERE relname = 'IntakeEvent_businessId_id_key' AND relkind = 'i')
  UNION ALL
  SELECT 5, 'N1 IdentityLink / IdentityProposal names free',
    ((to_regclass('public."IdentityLink"') IS NOT NULL)::int + (to_regclass('public."IdentityProposal"') IS NOT NULL)::int)::text,
    to_regclass('public."IdentityLink"') IS NULL AND to_regclass('public."IdentityProposal"') IS NULL
  UNION ALL
  SELECT 6, 'N2 none of the eight IntakeNormalizedEvent columns exists',
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'IntakeNormalizedEvent'
        AND column_name IN ('identityState', 'identityPolicyVersion', 'identityCustomerId', 'identityEvidence',
                            'identityCandidateCount', 'routingRule', 'routingDestination', 'ownerReviewRequired'))::text,
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'IntakeNormalizedEvent'
        AND column_name IN ('identityState', 'identityPolicyVersion', 'identityCustomerId', 'identityEvidence',
                            'identityCandidateCount', 'routingRule', 'routingDestination', 'ownerReviewRequired')) = 0
  UNION ALL
  SELECT 7, 'N3 no new constraint / index / policy name taken',
    ((SELECT count(*) FROM pg_constraint WHERE conname LIKE 'IdentityLink\_%' OR conname LIKE 'IdentityProposal\_%'
        OR conname IN ('IntakeNormalizedEvent_identityState_vocab', 'IntakeNormalizedEvent_routingDestination_vocab',
                       'IntakeNormalizedEvent_routingRule_format', 'IntakeNormalizedEvent_identityCandidateCount_range'))
      + (SELECT count(*) FROM pg_class WHERE relkind = 'i' AND (relname LIKE 'IdentityLink\_%' OR relname LIKE 'IdentityProposal\_%'))
      + (SELECT count(*) FROM pg_policies WHERE policyname LIKE 'identity\_link\_%' OR policyname LIKE 'identity\_proposal\_%'))::text,
    ((SELECT count(*) FROM pg_constraint WHERE conname LIKE 'IdentityLink\_%' OR conname LIKE 'IdentityProposal\_%'
        OR conname IN ('IntakeNormalizedEvent_identityState_vocab', 'IntakeNormalizedEvent_routingDestination_vocab',
                       'IntakeNormalizedEvent_routingRule_format', 'IntakeNormalizedEvent_identityCandidateCount_range'))
      + (SELECT count(*) FROM pg_class WHERE relkind = 'i' AND (relname LIKE 'IdentityLink\_%' OR relname LIKE 'IdentityProposal\_%'))
      + (SELECT count(*) FROM pg_policies WHERE policyname LIKE 'identity\_link\_%' OR policyname LIKE 'identity\_proposal\_%')) = 0
  UNION ALL
  SELECT 8, 'L1 20261001090000_m4_identity_routing not yet in the ledger',
    (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261001090000_m4_identity_routing')::text,
    (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261001090000_m4_identity_routing') = 0
  UNION ALL
  SELECT 9, 'L2 ledger: no unfinished or rolled-back row',
    (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)::text,
    (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0
  UNION ALL
  SELECT 10, 'R1 role app_runtime exists (INFO)',
    (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime')::text,
    true
)
SELECT ord, check_name, observed, CASE WHEN pass THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM checks ORDER BY ord;

SELECT 'S' || ord AS id, tbl, rows_estimate_exact, pg_size_pretty(total_bytes) AS total_size
FROM (
  SELECT 1 AS ord, 'IntakeNormalizedEvent' AS tbl, (SELECT count(*) FROM "IntakeNormalizedEvent") AS rows_estimate_exact,
         pg_total_relation_size('"IntakeNormalizedEvent"') AS total_bytes
  UNION ALL SELECT 2, 'IntakeEvent', (SELECT count(*) FROM "IntakeEvent"), pg_total_relation_size('"IntakeEvent"')
  UNION ALL SELECT 3, 'Customer', (SELECT count(*) FROM "Customer"), pg_total_relation_size('"Customer"')
  UNION ALL SELECT 4, 'Lead', (SELECT count(*) FROM "Lead"), pg_total_relation_size('"Lead"')
  UNION ALL SELECT 5, 'Business', (SELECT count(*) FROM "Business"), pg_total_relation_size('"Business"')
) s ORDER BY ord;

ROLLBACK;
