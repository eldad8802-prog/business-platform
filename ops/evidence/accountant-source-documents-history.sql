-- ============================================================================
-- accountant-source-documents-history.sql
--
-- Read-only Production evidence for S4 of the accountant source-documents work: historical data the
-- package builder relies on.
--   * approved documents WITHOUT a financial record never reach the package (the package is built from
--     records) — the only approval path creates both in one transaction, so any such row is historical;
--   * documents without Document.contentHashSha256 are shipped as "not verified" (S2);
--   * records whose document is not approved, or has no stored file, show up as missing originals.
-- Business 9 (the enabled business) and its September 2026 month (Israel time) are named in the legend.
--
-- Flags and counts only (scripts/ci/evidence-redact.mjs): no id, name, amount, path or text. Nothing is
-- changed and no automatic correction follows from it.
--
-- OUTPUT: n | flag | observed_count. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== accountant source documents — historical data: legend =='
\echo ' 1 approved documents, all businesses (count)'
\echo ' 2 approved documents WITHOUT a financial record, all businesses (count)'
\echo ' 3 businesses with at least one approved document without a record (count)'
\echo ' 4 approved documents without a recorded file hash, all businesses (count)'
\echo ' 5 ... of those, with a financial record (they would ship as "not verified") (count)'
\echo ' 6 businesses with at least one approved, recorded document without a hash (count)'
\echo ' 7 financial records whose document is not approved (count)'
\echo ' 8 financial records whose document has no stored file name (count)'
\echo ' 9 days since the newest document created without a hash (count; null = none)'
\echo '10 business 9: approved documents without a financial record, all time (count)'
\echo '11 business 9: September 2026 records whose document has no recorded hash (count)'
\echo '12 business 9: September 2026 records whose document has a recorded hash (count)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
sep AS (SELECT timestamp '2026-08-31 21:00:00' AS lo, timestamp '2026-09-30 21:00:00' AS hi),
approved AS (SELECT d."id", d."businessId", d."contentHashSha256" AS h, d."createdAt" AS c FROM "Document" d WHERE d."status" = 'approved'),
lines(n, flag, observed_count) AS (
            SELECT 1, NULL::boolean, (SELECT count(*) FROM approved)
  UNION ALL SELECT 2, NULL, (SELECT count(*) FROM approved a WHERE NOT EXISTS (SELECT 1 FROM "FinancialRecord" r WHERE r."documentId" = a."id"))
  UNION ALL SELECT 3, NULL, (SELECT count(DISTINCT a."businessId") FROM approved a WHERE NOT EXISTS (SELECT 1 FROM "FinancialRecord" r WHERE r."documentId" = a."id"))
  UNION ALL SELECT 4, NULL, (SELECT count(*) FROM approved WHERE h IS NULL)
  UNION ALL SELECT 5, NULL, (SELECT count(*) FROM approved a WHERE a.h IS NULL AND EXISTS (SELECT 1 FROM "FinancialRecord" r WHERE r."documentId" = a."id"))
  UNION ALL SELECT 6, NULL, (SELECT count(DISTINCT a."businessId") FROM approved a WHERE a.h IS NULL AND EXISTS (SELECT 1 FROM "FinancialRecord" r WHERE r."documentId" = a."id"))
  UNION ALL SELECT 7, NULL, (SELECT count(*) FROM "FinancialRecord" r JOIN "Document" d ON d."id" = r."documentId" WHERE d."status" <> 'approved')
  UNION ALL SELECT 8, NULL, (SELECT count(*) FROM "FinancialRecord" r JOIN "Document" d ON d."id" = r."documentId" WHERE coalesce(btrim(d."fileUrl"), '') = '')
  UNION ALL SELECT 9, NULL, (SELECT (current_date - max(d."createdAt")::date)::bigint FROM "Document" d WHERE d."contentHashSha256" IS NULL)
  UNION ALL SELECT 10, NULL, (SELECT count(*) FROM approved a WHERE a."businessId" = 9 AND NOT EXISTS (SELECT 1 FROM "FinancialRecord" r WHERE r."documentId" = a."id"))
  UNION ALL SELECT 11, NULL, (SELECT count(*) FROM "FinancialRecord" r JOIN "Document" d ON d."id" = r."documentId", sep
                               WHERE r."businessId" = 9 AND r."date" >= sep.lo AND r."date" < sep.hi AND d."contentHashSha256" IS NULL)
  UNION ALL SELECT 12, NULL, (SELECT count(*) FROM "FinancialRecord" r JOIN "Document" d ON d."id" = r."documentId", sep
                               WHERE r."businessId" = 9 AND r."date" >= sep.lo AND r."date" < sep.hi AND d."contentHashSha256" IS NOT NULL)
)
SELECT n, flag, observed_count FROM lines ORDER BY n;

ROLLBACK;
