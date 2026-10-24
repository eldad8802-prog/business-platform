-- ============================================================================
-- revenue-truth-foundation-preflight.sql
--
-- Read-only Production PREFLIGHT before migration
--   20261028090000_revenue_truth_foundation
--
-- Proves the database is where the migration expects it, from the catalog and counts only:
--   * the ledger is clean, 20261027090000_accountant_month_close (the last migration applied) is finished, and no
--     finished migration sorts after this one (it would then be applied out of order);
--   * none of the migration's objects exist yet (relations, enums, functions, policies);
--   * what it builds on exists exactly as the migration names it: the role app_runtime; Business, Document,
--     AcquisitionConnection, ExternalTransaction, BillingDocument; the tenant keys of Document (businessId, id)
--     and AcquisitionConnection (id, businessId) that its composite keys point at; the columns and enum labels
--     its link guard reads; ExternalTransaction and BillingDocument under FORCE row level security (the guard
--     reads them as the inserting role, so another business's row is simply not there to be found);
--   * the evidence role sees every row (it can tell "empty" from "hidden").
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== revenue truth foundation preflight: legend (n -> check) =='
\echo ' 1 the evidence role is a superuser or has BYPASSRLS (it sees every row)'
\echo ' 2 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 3 20261027090000_accountant_month_close is finished and no finished migration sorts after this one (observed = later finished migrations)'
\echo ' 4 20261028090000_revenue_truth_foundation is not recorded yet (observed = rows)'
\echo ' 5 no relation named Revenue* exists (observed = relations)'
\echo ' 6 no type named Revenue* exists (observed = types)'
\echo ' 7 no function named revenue_* exists (observed = functions)'
\echo ' 8 no policy named revenue_* exists (observed = policies)'
\echo ' 9 the role app_runtime exists'
\echo '10 Business, Document, AcquisitionConnection, ExternalTransaction, BillingDocument exist (observed = of 5)'
\echo '11 the tenant keys the composite keys point at: Document (businessId, id) and AcquisitionConnection (id, businessId), unique, not partial (observed = of 2)'
\echo '12 the enum labels the link guard compares: CREDIT, ISSUED, TAX_INVOICE, TAX_INVOICE_RECEIPT (observed = of 4)'
\echo '13 the columns the link guard reads on ExternalTransaction and BillingDocument (observed = of 10)'
\echo '14 ExternalTransaction and BillingDocument have RLS ENABLED + FORCED (observed = of 2)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
rel AS (SELECT c.oid, c.relname AS nm, c.relkind, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
        WHERE c.relnamespace = (SELECT oid FROM pub)),
key_cols AS (
  SELECT t.nm, (SELECT array_agg(a.attname::text ORDER BY k.ord)
                  FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) AS cols
  FROM pg_index i JOIN rel t ON t.oid = i.indrelid
  WHERE i.indisunique AND i.indisvalid AND i.indpred IS NULL AND t.nm IN ('Document', 'AcquisitionConnection')),
labels AS (SELECT t.typname, e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
           WHERE t.typnamespace = (SELECT oid FROM pub)),
guard_cols(tbl, col) AS (VALUES
  ('ExternalTransaction', 'id'), ('ExternalTransaction', 'businessId'), ('ExternalTransaction', 'direction'),
  ('ExternalTransaction', 'currency'), ('ExternalTransaction', 'amount'),
  ('BillingDocument', 'id'), ('BillingDocument', 'businessId'), ('BillingDocument', 'status'),
  ('BillingDocument', 'documentType'), ('BillingDocument', 'currency')),
present_cols AS (SELECT g.tbl, g.col FROM guard_cols g JOIN rel r ON r.nm = g.tbl AND r.relkind = 'r'
                 JOIN pg_attribute a ON a.attrelid = r.oid AND a.attname = g.col AND a.attnum > 0 AND NOT a.attisdropped),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) IS TRUE, 1
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL
                         AND migration_name > '20261028090000_revenue_truth_foundation') = 0
                      AND EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261027090000_accountant_month_close'
                                    AND finished_at IS NOT NULL AND rolled_back_at IS NULL),
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL
                         AND migration_name > '20261028090000_revenue_truth_foundation')
  UNION ALL SELECT 4, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261028090000_revenue_truth_foundation') = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261028090000_revenue_truth_foundation')
  UNION ALL SELECT 5, (SELECT count(*) FROM rel WHERE nm LIKE 'Revenue%') = 0, (SELECT count(*) FROM rel WHERE nm LIKE 'Revenue%')
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_type WHERE typnamespace = (SELECT oid FROM pub) AND typname LIKE 'Revenue%') = 0,
                      (SELECT count(*) FROM pg_type WHERE typnamespace = (SELECT oid FROM pub) AND typname LIKE 'Revenue%')
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_proc WHERE pronamespace = (SELECT oid FROM pub) AND proname LIKE 'revenue\_%') = 0,
                      (SELECT count(*) FROM pg_proc WHERE pronamespace = (SELECT oid FROM pub) AND proname LIKE 'revenue\_%')
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_policy WHERE polname LIKE 'revenue\_%') = 0,
                      (SELECT count(*) FROM pg_policy WHERE polname LIKE 'revenue\_%')
  UNION ALL SELECT 9, EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime'), 1
  UNION ALL SELECT 10, (SELECT count(*) FROM rel WHERE relkind = 'r'
                          AND nm IN ('Business', 'Document', 'AcquisitionConnection', 'ExternalTransaction', 'BillingDocument')) = 5,
                       (SELECT count(*) FROM rel WHERE relkind = 'r'
                          AND nm IN ('Business', 'Document', 'AcquisitionConnection', 'ExternalTransaction', 'BillingDocument'))
  UNION ALL SELECT 11, (SELECT count(DISTINCT nm) FROM key_cols
                          WHERE (nm = 'Document' AND cols = ARRAY['businessId', 'id'])
                             OR (nm = 'AcquisitionConnection' AND cols = ARRAY['id', 'businessId'])) = 2,
                       (SELECT count(DISTINCT nm) FROM key_cols
                          WHERE (nm = 'Document' AND cols = ARRAY['businessId', 'id'])
                             OR (nm = 'AcquisitionConnection' AND cols = ARRAY['id', 'businessId']))
  UNION ALL SELECT 12, (SELECT count(*) FROM labels
                          WHERE (typname = 'ExternalTransactionDirection' AND enumlabel = 'CREDIT')
                             OR (typname = 'BillingDocumentStatus' AND enumlabel = 'ISSUED')
                             OR (typname = 'BillingDocumentType' AND enumlabel IN ('TAX_INVOICE', 'TAX_INVOICE_RECEIPT'))) = 4,
                       (SELECT count(*) FROM labels
                          WHERE (typname = 'ExternalTransactionDirection' AND enumlabel = 'CREDIT')
                             OR (typname = 'BillingDocumentStatus' AND enumlabel = 'ISSUED')
                             OR (typname = 'BillingDocumentType' AND enumlabel IN ('TAX_INVOICE', 'TAX_INVOICE_RECEIPT')))
  UNION ALL SELECT 13, (SELECT count(*) FROM present_cols) = 10, (SELECT count(*) FROM present_cols)
  UNION ALL SELECT 14, (SELECT count(*) FROM rel WHERE relkind = 'r' AND nm IN ('ExternalTransaction', 'BillingDocument')
                          AND relrowsecurity AND relforcerowsecurity) = 2,
                       (SELECT count(*) FROM rel WHERE relkind = 'r' AND nm IN ('ExternalTransaction', 'BillingDocument')
                          AND relrowsecurity AND relforcerowsecurity)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
