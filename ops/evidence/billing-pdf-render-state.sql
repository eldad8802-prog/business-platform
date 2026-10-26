-- ============================================================================
-- billing-pdf-render-state.sql
--
-- Read-only Production evidence: are invoice / receipt PDFs rendering in Production?
--
-- Billing PDFs are produced on demand (GET /api/billing/documents/[id]/pdf → getOrRenderBillingPdf → the
-- HTML renderer → playwright chromium.launch). The accountant PDF report failed in Production on
-- 2026-10-25 because no Chromium browser exists in the Vercel function; this file asks whether the
-- billing PDFs are affected the same way. It reads statuses, dates and counts only. The stored failure
-- reason (pdfRenderError) is NEVER printed: it is only matched against the known "browser missing" text,
-- and the answer is a flag.
--
-- Flags and counts only (scripts/ci/evidence-redact.mjs): no id, name, amount, number or text.
--
-- OUTPUT: n | flag | observed_count. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== billing PDF render state (issued documents): legend =='
\echo ' 1 issued billing documents, all time (count)'
\echo ' 2 ... whose PDF is RENDERED (count)'
\echo ' 3 ... whose PDF is FAILED (count)'
\echo ' 4 ... whose PDF is PENDING (never rendered yet) (count)'
\echo ' 5 businesses with at least one FAILED PDF (count)'
\echo ' 6 FAILED PDFs whose stored reason is the missing browser ("Executable doesn''t exist") (count)'
\echo ' 7 FAILED PDFs whose stored reason mentions browserType.launch (count)'
\echo ' 8 days since the most recent successful render (count; null = never)'
\echo ' 9 days since the most recent issued document (count; null = none)'
\echo '10 RENDERED PDFs rendered in the last 30 days (count)'
\echo '11 BILLING_PDF_RENDER_FAILED audit events in the last 30 days (count)'
\echo '12 BILLING_PDF_RENDER_FAILED audit events, all time (count)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
issued AS (SELECT d."businessId", d."pdfRenderStatus"::text AS s, d."pdfRenderError" AS e, d."pdfRenderedAt" AS r, d."issuedAt" AS i
             FROM "BillingDocument" d WHERE d."status"::text = 'ISSUED'),
lines(n, flag, observed_count) AS (
            SELECT 1, NULL::boolean, (SELECT count(*) FROM issued)
  UNION ALL SELECT 2, NULL, (SELECT count(*) FROM issued WHERE s = 'RENDERED')
  UNION ALL SELECT 3, NULL, (SELECT count(*) FROM issued WHERE s = 'FAILED')
  UNION ALL SELECT 4, NULL, (SELECT count(*) FROM issued WHERE s = 'PENDING')
  UNION ALL SELECT 5, NULL, (SELECT count(DISTINCT "businessId") FROM issued WHERE s = 'FAILED')
  UNION ALL SELECT 6, NULL, (SELECT count(*) FROM issued WHERE s = 'FAILED' AND e ILIKE '%Executable doesn''t exist%')
  UNION ALL SELECT 7, NULL, (SELECT count(*) FROM issued WHERE s = 'FAILED' AND e ILIKE '%browserType.launch%')
  UNION ALL SELECT 8, NULL, (SELECT (current_date - max(r)::date)::bigint FROM issued WHERE s = 'RENDERED' AND r IS NOT NULL)
  UNION ALL SELECT 9, NULL, (SELECT (current_date - max(i)::date)::bigint FROM issued WHERE i IS NOT NULL)
  UNION ALL SELECT 10, NULL, (SELECT count(*) FROM issued WHERE s = 'RENDERED' AND r >= now() - interval '30 days')
  UNION ALL SELECT 11, NULL, (SELECT count(*) FROM "BillingAuditEvent" a WHERE a."eventType" = 'BILLING_PDF_RENDER_FAILED' AND a."occurredAt" >= now() - interval '30 days')
  UNION ALL SELECT 12, NULL, (SELECT count(*) FROM "BillingAuditEvent" a WHERE a."eventType" = 'BILLING_PDF_RENDER_FAILED')
)
SELECT n, flag, observed_count FROM lines ORDER BY n;

ROLLBACK;
