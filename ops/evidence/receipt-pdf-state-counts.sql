-- ============================================================================
-- receipt-pdf-state-counts.sql
--
-- Read-only Production evidence for #1108 / #1130 (historical receipts): how many ISSUED receipts are in each of
-- the three states the owner defined, as far as the database alone can tell.
--
--   A  issued, a PDF was stored: status RENDERED with a storage key and a recorded hash.
--      The database proves the record only. Whether the stored object still exists and still matches the hash is
--      NOT visible to SQL (rows 3-5 are "A by the record"; a storage read is a separate, unapproved step).
--   B  issued, no PDF was ever stored: status PENDING (never rendered) or FAILED (a render was tried, nothing
--      stored), with no storage key.
--   C  issued, the record is inconsistent: RENDERED without a storage key or without a hash.
--   ?  not classifiable from the record: PENDING / FAILED that still carry a storage key.
--
-- Row 13 checks that A + B + C + ? equals all issued receipts (nothing missed, nothing counted twice).
-- The template version splits state A by how the stored file was produced (the restore path depends on it):
--   billing-v1-html           the HTML template before #1108 (frozen in #1130 as receipt-v1)
--   billing-v1                pdfmake (its file id depends on the millisecond: no byte-exact re-render)
--   billing-v1-receipt2-html  the #1108 template (must be 0 in Production today: #1108 is not merged)
--
-- PRIVACY: counts only (scripts/ci/evidence-redact.mjs). No id, number, name, amount, key, hash or text.
-- OUTPUT: n | result (PASS / FAIL, empty = informational) | observed_count. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== receipt PDF state (issued receipts): legend =='
\echo ' 1 issued receipts (RECEIPT), all time'
\echo ' 2 state A by the record: RENDERED + storage key + hash'
\echo ' 3   ... of which template billing-v1-html (pre-#1108 HTML)'
\echo ' 4   ... of which template billing-v1 (pdfmake)'
\echo ' 5   ... of which another or no template version'
\echo ' 6 state B: PENDING, no storage key (never rendered)'
\echo ' 7 state B: FAILED, no storage key (render tried, nothing stored)'
\echo ' 8 state C by the record: RENDERED without a storage key or without a hash'
\echo ' 9 not classifiable: PENDING or FAILED that carry a storage key'
\echo '10 template billing-v1-receipt2-html anywhere (must be 0: #1108 is not in Production)'
\echo '11 state A that also hold a signed PDF artifact (informational)'
\echo '12 issued TAX_INVOICE_RECEIPT (informational: not changed by #1108 / #1130)'
\echo '13 reconciliation: rows 2+6+7+8+9 equal row 1 (1 = yes)'
\echo '14 state B receipts issued more than 30 days ago (informational)'
\echo '15 businesses that hold at least one state B receipt (informational)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
r AS (SELECT d."businessId" AS b, d."pdfRenderStatus"::text AS s, d."pdfStorageKey" IS NOT NULL AS has_key,
             d."pdfHash" IS NOT NULL AS has_hash, d."pdfTemplateVersion" AS v, d."signedPdfStorageKey" IS NOT NULL AS signed,
             d."issuedAt" AS i
        FROM "BillingDocument" d
       WHERE d."status"::text = 'ISSUED' AND d."documentType"::text = 'RECEIPT'),
k AS (SELECT
        (SELECT count(*) FROM r) AS all_n,
        (SELECT count(*) FROM r WHERE s = 'RENDERED' AND has_key AND has_hash) AS a_n,
        (SELECT count(*) FROM r WHERE s = 'PENDING' AND NOT has_key) AS b1_n,
        (SELECT count(*) FROM r WHERE s = 'FAILED' AND NOT has_key) AS b2_n,
        (SELECT count(*) FROM r WHERE s = 'RENDERED' AND NOT (has_key AND has_hash)) AS c_n,
        (SELECT count(*) FROM r WHERE s IN ('PENDING', 'FAILED') AND has_key) AS u_n),
lines(n, result, observed_count) AS (
            SELECT 1, NULL::text, (SELECT all_n FROM k)
  UNION ALL SELECT 2, NULL, (SELECT a_n FROM k)
  UNION ALL SELECT 3, NULL, (SELECT count(*) FROM r WHERE s = 'RENDERED' AND has_key AND has_hash AND v = 'billing-v1-html')
  UNION ALL SELECT 4, NULL, (SELECT count(*) FROM r WHERE s = 'RENDERED' AND has_key AND has_hash AND v = 'billing-v1')
  UNION ALL SELECT 5, NULL, (SELECT count(*) FROM r WHERE s = 'RENDERED' AND has_key AND has_hash
                                 AND (v IS NULL OR v NOT IN ('billing-v1-html', 'billing-v1')))
  UNION ALL SELECT 6, NULL, (SELECT b1_n FROM k)
  UNION ALL SELECT 7, NULL, (SELECT b2_n FROM k)
  UNION ALL SELECT 8, NULL, (SELECT c_n FROM k)
  UNION ALL SELECT 9, NULL, (SELECT u_n FROM k)
  UNION ALL SELECT 10, CASE WHEN (SELECT count(*) FROM "BillingDocument" WHERE "pdfTemplateVersion" = 'billing-v1-receipt2-html') = 0
                            THEN 'PASS' ELSE 'FAIL' END,
                       (SELECT count(*) FROM "BillingDocument" WHERE "pdfTemplateVersion" = 'billing-v1-receipt2-html')
  UNION ALL SELECT 11, NULL, (SELECT count(*) FROM r WHERE s = 'RENDERED' AND has_key AND has_hash AND signed)
  UNION ALL SELECT 12, NULL, (SELECT count(*) FROM "BillingDocument" WHERE "status"::text = 'ISSUED'
                                 AND "documentType"::text = 'TAX_INVOICE_RECEIPT')
  UNION ALL SELECT 13, CASE WHEN (SELECT a_n + b1_n + b2_n + c_n + u_n = all_n FROM k) THEN 'PASS' ELSE 'FAIL' END,
                       (SELECT CASE WHEN a_n + b1_n + b2_n + c_n + u_n = all_n THEN 1 ELSE 0 END FROM k)
  UNION ALL SELECT 14, NULL, (SELECT count(*) FROM r WHERE NOT has_key AND s IN ('PENDING', 'FAILED')
                                 AND i < now() - interval '30 days')
  UNION ALL SELECT 15, NULL, (SELECT count(DISTINCT b) FROM r WHERE NOT has_key AND s IN ('PENDING', 'FAILED'))
)
SELECT n, result, observed_count FROM lines ORDER BY n;

ROLLBACK;
