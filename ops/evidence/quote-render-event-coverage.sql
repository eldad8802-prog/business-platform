-- ============================================================================
-- quote-render-event-coverage.sql
--
-- Read-only coverage of the BILLING_QUOTE_PDF_RENDERED audit event over the quotes that exist, for the 4a T3 rule
-- "a quote sent before the transition keeps the issuer it was sent with" (#1273). The rule relies on a quote's FIRST
-- render event; a quote without one is never guessed and keeps the live issuer (today's behaviour).
-- Evidence that a quote's PDF was produced (so it may have reached the customer): pdfRenderedAt, pdfHash or
-- pdfStorageKey set, or pdfRenderStatus = RENDERED.
-- OUTPUT: n | result (PASS/FAIL/INFO) | observed_count. SELECT only. Counts only, no row values, no business ids.
-- ============================================================================
\echo '== quote render-event coverage: legend (n -> check) =='
\echo ' 1 INFO quotes in total (observed = rows)'
\echo ' 2 INFO quotes WITH at least one BILLING_QUOTE_PDF_RENDERED event (observed = quotes)'
\echo ' 3 INFO quotes WITHOUT the event and with NO evidence of a produced PDF: never produced (observed = quotes)'
\echo ' 4 quotes WITHOUT the event but WITH evidence of a produced PDF: the gap (PASS = 0) (observed = quotes)'
\echo ' 5 INFO of check 3, quotes that carry a number anyway (numbered by conversion only) (observed = quotes)'
\echo ' 6 INFO of check 4, quotes of businesses whose profile is EXEMPT_DEALER today (observed = quotes)'
\echo ' 7 INFO BusinessKindTransition rows (observed = rows)'
\echo ' 8 INFO quotes with evidence of a produced PDF (observed = quotes)'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';

WITH
ev AS (
  SELECT DISTINCT e."billingDocumentId" AS id FROM "BillingAuditEvent" e
   WHERE e."eventType" = 'BILLING_QUOTE_PDF_RENDERED' AND e."billingDocumentId" IS NOT NULL
),
q AS (
  SELECT d."id", d."businessId", d."documentNumber",
         (d."pdfRenderedAt" IS NOT NULL OR d."pdfHash" IS NOT NULL OR d."pdfStorageKey" IS NOT NULL
          OR d."pdfRenderStatus"::text = 'RENDERED') AS produced,
         (ev.id IS NOT NULL) AS has_event
    FROM "BillingDocument" d
    LEFT JOIN ev ON ev.id = d."id"
   WHERE d."documentType"::text = 'QUOTE'
),
gap AS (SELECT * FROM q WHERE NOT has_event AND produced),
never AS (SELECT * FROM q WHERE NOT has_event AND NOT produced),
checks(n, result, observed_count) AS (
  SELECT 1, NULL::boolean, (SELECT count(*) FROM q)
  UNION ALL SELECT 2, NULL, (SELECT count(*) FROM q WHERE has_event)
  UNION ALL SELECT 3, NULL, (SELECT count(*) FROM never)
  UNION ALL SELECT 4, (SELECT count(*) FROM gap) = 0, (SELECT count(*) FROM gap)
  UNION ALL SELECT 5, NULL, (SELECT count(*) FROM never WHERE "documentNumber" IS NOT NULL)
  UNION ALL SELECT 6, NULL, (SELECT count(*) FROM gap g JOIN "BusinessProfile" p ON p."businessId" = g."businessId"
                              WHERE p."billingBusinessKind"::text = 'EXEMPT_DEALER')
  UNION ALL SELECT 7, NULL, (SELECT count(*) FROM "BusinessKindTransition")
  UNION ALL SELECT 8, NULL, (SELECT count(*) FROM q WHERE produced)
)
SELECT n, CASE WHEN result IS NULL THEN 'INFO' WHEN result THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
