-- ============================================================================
-- m5-crm-lead-lifecycle-preflight.sql
--
-- Read-only Production preflight for Business Intake M5, migration
--   20261002090000_crm_lead_lifecycle
-- which adds the append-only table LeadLifecycleEvent (composite
-- (businessId, leadId) reference to Lead, FORCE RLS, SELECT + INS policies),
-- three Lead columns (lifecycleVersion, nextActionKind, firstHandledAt), five
-- Lead CHECKs, retypes Lead.valueEstimate / Lead.finalPrice from float to
-- NUMERIC(18,2), and backfills one `created` step per existing Lead (plus one
-- status step for each Lead no longer NEW).
--
--   P1   Lead_businessId_id_key present (sec-C) — the composite reference needs it.
--   P2   IdentityProposal present (M4) — the migration's own guard.
--   N1   the LeadLifecycleEvent name is free.
--   N2   none of the three new Lead columns exists.
--   N3   none of the new constraint / index / policy names is taken.
--   D1   every Lead.currency is NULL or three upper-case letters (the new CHECK).
--   D2   every Lead.valueEstimate / finalPrice is NULL or in [0, 1e16) (the retype).
--   L1   the M5 migration is not in the ledger yet; L2 ledger has no unfinished
--        or rolled-back row.
--   R1   role app_runtime exists (INFO: the privilege block is guarded).
--   I1-I4 INFO: Lead rows, Lead rows no longer NEW (= backfilled status steps),
--        non-null counts of the five legacy Lead fields, table size (how long
--        the Lead table rewrite holds its exclusive table mode).
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
  SELECT 1, 'P1 Lead_businessId_id_key present',
    (SELECT count(*) FROM pg_class WHERE relname = 'Lead_businessId_id_key' AND relkind = 'i')::text,
    EXISTS (SELECT 1 FROM pg_class WHERE relname = 'Lead_businessId_id_key' AND relkind = 'i')
  UNION ALL
  SELECT 2, 'P2 IdentityProposal present (M4)',
    ((to_regclass('public."IdentityProposal"') IS NOT NULL)::int)::text,
    to_regclass('public."IdentityProposal"') IS NOT NULL
  UNION ALL
  SELECT 3, 'N1 LeadLifecycleEvent name free',
    ((to_regclass('public."LeadLifecycleEvent"') IS NOT NULL)::int)::text,
    to_regclass('public."LeadLifecycleEvent"') IS NULL
  UNION ALL
  SELECT 4, 'N2 none of the three new Lead columns exists',
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'Lead'
        AND column_name IN ('lifecycleVersion', 'nextActionKind', 'firstHandledAt'))::text,
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'Lead'
        AND column_name IN ('lifecycleVersion', 'nextActionKind', 'firstHandledAt')) = 0
  UNION ALL
  SELECT 5, 'N3 no new constraint / index / policy name taken',
    ((SELECT count(*) FROM pg_constraint WHERE conname LIKE 'LeadLifecycleEvent\_%'
        OR conname IN ('Lead_nextActionKind_vocab', 'Lead_nextAction_has_due', 'Lead_lifecycleVersion_range',
                       'Lead_money_nonnegative', 'Lead_currency_iso'))
      + (SELECT count(*) FROM pg_class WHERE relkind = 'i' AND relname LIKE 'LeadLifecycleEvent\_%')
      + (SELECT count(*) FROM pg_policies WHERE policyname LIKE 'lead\_lifecycle\_%'))::text,
    ((SELECT count(*) FROM pg_constraint WHERE conname LIKE 'LeadLifecycleEvent\_%'
        OR conname IN ('Lead_nextActionKind_vocab', 'Lead_nextAction_has_due', 'Lead_lifecycleVersion_range',
                       'Lead_money_nonnegative', 'Lead_currency_iso'))
      + (SELECT count(*) FROM pg_class WHERE relkind = 'i' AND relname LIKE 'LeadLifecycleEvent\_%')
      + (SELECT count(*) FROM pg_policies WHERE policyname LIKE 'lead\_lifecycle\_%')) = 0
  UNION ALL
  SELECT 6, 'D1 every Lead.currency is NULL or ISO-4217 shaped',
    (SELECT count(*) FROM "Lead" WHERE "currency" IS NOT NULL AND "currency" !~ '^[A-Z]{3}$')::text,
    (SELECT count(*) FROM "Lead" WHERE "currency" IS NOT NULL AND "currency" !~ '^[A-Z]{3}$') = 0
  UNION ALL
  SELECT 7, 'D2 every Lead.valueEstimate / finalPrice is NULL or in [0, 1e16)',
    (SELECT count(*) FROM "Lead"
      WHERE ("valueEstimate" IS NOT NULL AND ("valueEstimate" < 0 OR "valueEstimate" >= 1e16))
         OR ("finalPrice" IS NOT NULL AND ("finalPrice" < 0 OR "finalPrice" >= 1e16)))::text,
    (SELECT count(*) FROM "Lead"
      WHERE ("valueEstimate" IS NOT NULL AND ("valueEstimate" < 0 OR "valueEstimate" >= 1e16))
         OR ("finalPrice" IS NOT NULL AND ("finalPrice" < 0 OR "finalPrice" >= 1e16))) = 0
  UNION ALL
  SELECT 8, 'L1 20261002090000_crm_lead_lifecycle not yet in the ledger',
    (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261002090000_crm_lead_lifecycle')::text,
    (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261002090000_crm_lead_lifecycle') = 0
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

SELECT 'I' || ord AS id, what, n
FROM (
  SELECT 1 AS ord, 'Lead rows (= backfilled created steps)' AS what, (SELECT count(*) FROM "Lead") AS n
  UNION ALL SELECT 2, 'Lead rows no longer NEW (= backfilled status steps)', (SELECT count(*) FROM "Lead" WHERE "status" <> 'NEW')
  UNION ALL SELECT 3, 'Lead rows with temperature / currentStage / quotedPrice set',
    (SELECT count(*) FROM "Lead" WHERE "temperature" IS NOT NULL OR "currentStage" IS NOT NULL OR "quotedPrice" IS NOT NULL)
  UNION ALL SELECT 4, 'Lead rows with valueEstimate / finalPrice set', (SELECT count(*) FROM "Lead" WHERE "valueEstimate" IS NOT NULL OR "finalPrice" IS NOT NULL)
  UNION ALL SELECT 5, 'Lead total size (bytes)', pg_total_relation_size('"Lead"')
) s ORDER BY ord;

ROLLBACK;
