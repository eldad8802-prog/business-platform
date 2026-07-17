-- Read-only Production evidence for historical billing documents that predate
-- the authority-approval wiring (PR #115).
--
-- Goal: anonymous grouped COUNTS only, to size the population of ISSUED,
-- authority-eligible documents that have no BillingAuthoritySubmission row and
-- would be affected by the new PDF delivery guard.
--
-- SELECT-only. Wrapped in a READ ONLY transaction that always rolls back, with a
-- session read-only guard and a statement timeout. No row-level data, no ids, no
-- names, no tax numbers, no snapshots — grouped counts only. A CI static guard
-- rejects any write keyword before this file ever reaches the database.

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;

-- Affected set: status ISSUED, authority-eligible type, no submission row.
-- Q1 by type and issued month.
WITH affected AS (
  SELECT bd.id,
         bd."documentType" AS dtype, bd."issuedAt" AS issued_at,
         bd."allocationNumber" AS alloc, bd."allocationApprovedAt" AS alloc_at,
         bd."pdfRenderStatus" AS pdf_status,
         (bd."pdfStorageKey" IS NOT NULL) AS has_key,
         (bd."pdfHash" IS NOT NULL) AS has_hash,
         bd."subtotalAmount" AS subtotal, bd."vatAmount" AS vat, bd.currency AS ccy,
         bd."businessId" AS biz
  FROM "BillingDocument" bd
  WHERE bd.status = 'ISSUED'
    AND bd."documentType" IN ('TAX_INVOICE','CREDIT_NOTE')
    AND NOT EXISTS (SELECT 1 FROM "BillingAuthoritySubmission" s
                    WHERE s."billingDocumentId" = bd.id)
)
SELECT 'Q1' AS q, dtype,
       to_char(date_trunc('month', issued_at), 'YYYY-MM') AS ym, count(*) AS n
FROM affected GROUP BY dtype, ym ORDER BY ym, dtype;

-- Q2 allocation projection anomalies.
WITH affected AS (
  SELECT bd."allocationNumber" AS alloc, bd."allocationApprovedAt" AS alloc_at
  FROM "BillingDocument" bd
  WHERE bd.status='ISSUED' AND bd."documentType" IN ('TAX_INVOICE','CREDIT_NOTE')
    AND NOT EXISTS (SELECT 1 FROM "BillingAuthoritySubmission" s WHERE s."billingDocumentId"=bd.id))
SELECT 'Q2' AS q,
  count(*) FILTER (WHERE alloc IS NOT NULL) AS with_alloc,
  count(*) FILTER (WHERE alloc IS NULL) AS without_alloc,
  count(*) FILTER (WHERE alloc_at IS NOT NULL) AS with_alloc_at,
  count(*) FILTER (WHERE alloc IS NOT NULL AND alloc_at IS NULL) AS alloc_without_date,
  count(*) FILTER (WHERE alloc_at IS NOT NULL AND alloc IS NULL) AS date_without_alloc
FROM affected;

-- Q3 PDF state.
WITH affected AS (
  SELECT bd."pdfRenderStatus" AS pdf_status,
         (bd."pdfStorageKey" IS NOT NULL) AS has_key, (bd."pdfHash" IS NOT NULL) AS has_hash
  FROM "BillingDocument" bd
  WHERE bd.status='ISSUED' AND bd."documentType" IN ('TAX_INVOICE','CREDIT_NOTE')
    AND NOT EXISTS (SELECT 1 FROM "BillingAuthoritySubmission" s WHERE s."billingDocumentId"=bd.id))
SELECT 'Q3' AS q, pdf_status, count(*) AS n,
  count(*) FILTER (WHERE has_key) AS with_storage_key,
  count(*) FILTER (WHERE has_hash) AS with_hash
FROM affected GROUP BY pdf_status ORDER BY pdf_status;

-- Q4 readiness classification from frozen columns + canonical threshold
-- (Jerusalem date; 25000 through 2024, 20000 in 2025, 10000 2026-H1, 5000 from 2026-06).
WITH affected AS (
  SELECT bd."documentType" AS dtype, bd."issuedAt" AS issued_at,
         bd."subtotalAmount" AS subtotal, bd."vatAmount" AS vat, bd.currency AS ccy
  FROM "BillingDocument" bd
  WHERE bd.status='ISSUED' AND bd."documentType" IN ('TAX_INVOICE','CREDIT_NOTE')
    AND NOT EXISTS (SELECT 1 FROM "BillingAuthoritySubmission" s WHERE s."billingDocumentId"=bd.id))
SELECT 'Q4' AS q,
  count(*) FILTER (WHERE cls='DEFINITE_NOT_REQUIRED') AS definite_not_required,
  count(*) FILTER (WHERE cls='AMBIGUOUS') AS ambiguous,
  count(*) FILTER (WHERE cls='UNCLASSIFIABLE') AS unclassifiable
FROM (
  SELECT CASE
    WHEN dtype='CREDIT_NOTE' THEN 'DEFINITE_NOT_REQUIRED'
    WHEN subtotal IS NULL OR vat IS NULL OR ccy IS NULL THEN 'UNCLASSIFIABLE'
    WHEN vat <= 0 THEN 'DEFINITE_NOT_REQUIRED'
    WHEN ccy <> 'ILS' THEN 'DEFINITE_NOT_REQUIRED'
    WHEN subtotal < (CASE
        WHEN (issued_at AT TIME ZONE 'Asia/Jerusalem')::date >= DATE '2026-06-01' THEN 5000
        WHEN (issued_at AT TIME ZONE 'Asia/Jerusalem')::date >= DATE '2026-01-01' THEN 10000
        WHEN (issued_at AT TIME ZONE 'Asia/Jerusalem')::date >= DATE '2025-01-01' THEN 20000
        ELSE 25000 END) THEN 'DEFINITE_NOT_REQUIRED'
    ELSE 'AMBIGUOUS' END AS cls
  FROM affected) t;

-- Q5 time span + regulatory-era buckets.
WITH affected AS (
  SELECT bd."issuedAt" AS issued_at FROM "BillingDocument" bd
  WHERE bd.status='ISSUED' AND bd."documentType" IN ('TAX_INVOICE','CREDIT_NOTE')
    AND NOT EXISTS (SELECT 1 FROM "BillingAuthoritySubmission" s WHERE s."billingDocumentId"=bd.id))
SELECT 'Q5' AS q, min(issued_at) AS earliest, max(issued_at) AS latest,
  count(*) FILTER (WHERE (issued_at AT TIME ZONE 'Asia/Jerusalem')::date < DATE '2026-01-01') AS before_2026,
  count(*) FILTER (WHERE (issued_at AT TIME ZONE 'Asia/Jerusalem')::date >= DATE '2026-01-01'
                     AND (issued_at AT TIME ZONE 'Asia/Jerusalem')::date <= DATE '2026-05-31') AS jan_may_2026,
  count(*) FILTER (WHERE (issued_at AT TIME ZONE 'Asia/Jerusalem')::date >= DATE '2026-06-01') AS from_jun_2026
FROM affected;

-- Q6 affected businesses (anonymous distribution; no id returned).
WITH affected AS (
  SELECT bd."businessId" AS biz FROM "BillingDocument" bd
  WHERE bd.status='ISSUED' AND bd."documentType" IN ('TAX_INVOICE','CREDIT_NOTE')
    AND NOT EXISTS (SELECT 1 FROM "BillingAuthoritySubmission" s WHERE s."billingDocumentId"=bd.id)),
per_biz AS (SELECT biz, count(*) AS n FROM affected GROUP BY biz)
SELECT 'Q6' AS q, count(*) AS affected_businesses,
  count(*) FILTER (WHERE n = 1) AS biz_1,
  count(*) FILTER (WHERE n BETWEEN 2 AND 5) AS biz_2_5,
  count(*) FILTER (WHERE n BETWEEN 6 AND 20) AS biz_6_20,
  count(*) FILTER (WHERE n > 20) AS biz_over_20
FROM per_biz;

ROLLBACK;
