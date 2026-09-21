-- Read-only Production evidence: allocation integrity before C2.5.
--
-- WHY THIS EXISTS
--
-- A runtime battery against current main proved two integrity failures the
-- Billing write path can produce today:
--
--   F   Two receipts allocate the same invoice concurrently. The over-allocation
--       guard reads, then writes, with nothing held between the two, so both
--       pass. Once both are issued the invoice carries 2,000 of authoritative
--       allocations against a 1,000 total.
--
--   E4  A draft receipt is allocated 1,000, then its payment lines are swapped
--       for 300. Nothing re-reads the allocations and issuance never checks
--       them, so an issued receipt of 300 settles 1,000 of debt.
--
-- C2.5 will close both at the DRAFT to ISSUED transition. This file measures
-- whether Production already holds either state, so that correction is known
-- to be forward-only before it is designed.
--
-- DOMAIN DEFINITIONS (taken from current main, not restated)
--
--   Authoritative allocation   an allocation row whose receipt is ISSUED and
--                              belongs to the same business as the row
--                              (billing-allocation-authority.ts). All three
--                              debt readers use this, and nothing else.
--
--   Invoice authority          an ISSUED TAX_INVOICE's "totalAmount" (VAT
--                              inclusive). Only such a document may receive an
--                              allocation (assertInvoiceAllocatable).
--
--   Credit-note effect         the "totalAmount" of ISSUED CREDIT_NOTE rows
--                              whose "referenceDocumentId" is the invoice. The
--                              collection list and the payments store subtract
--                              it; the invoice settlement-state reader does
--                              not. So F is reported twice: against the gross
--                              total (F1), and against total minus issued
--                              credit (F2). F2 alone is not proof of the race:
--                              the credit guard never looks at payments, so a
--                              fully paid invoice may legitimately be credited
--                              afterwards. It is sized separately so it is
--                              never mistaken for F1.
--
--   Receipt authority          a pure RECEIPT's "totalAmount", which issuance
--                              requires to equal the sum of its payment lines
--                              (assertIssuableShape). E4 compares allocations
--                              to that figure. An ISSUED receipt with no
--                              allocation at all is a legitimate ad-hoc receipt
--                              and is excluded from E4; it is counted only as
--                              context.
--
--   Currency                   allocation rows carry the receipt currency, and
--                              the service requires it to equal the invoice
--                              currency. Money is grouped by currency and never
--                              summed across currencies. Rows that break the
--                              currency rule are counted separately.
--
-- PRIVACY. Counts and money only. No identifier of any business, customer,
-- document or row is selected, and no name, email, phone, address, document
-- number, invoice content or credential.
--
-- SELECT-only. Wrapped in a READ ONLY transaction that always rolls back, with
-- a session read-only guard and a statement timeout. A CI guard rejects this
-- file before it reaches any database if it bears a writing keyword anywhere,
-- prose included.

SET statement_timeout = '30s';
SET default_transaction_read_only = on;
BEGIN TRANSACTION READ ONLY;

\echo '== F1: invoices whose authoritative allocations exceed the invoice total =='
WITH inv_alloc AS (
  SELECT inv."id"                        AS invoice_id,
         inv."businessId"                AS business_id,
         inv."currency"                  AS currency,
         inv."totalAmount"               AS invoice_total,
         count(a."id")                   AS allocation_rows,
         sum(a."allocatedAmount")        AS allocated
  FROM "BillingDocument" inv
  JOIN "BillingPaymentAllocation" a
    ON a."invoiceDocumentId" = inv."id"
   AND a."businessId" = inv."businessId"
  JOIN "BillingDocument" r
    ON r."id" = a."receiptDocumentId"
   AND r."businessId" = a."businessId"
   AND r."status" = 'ISSUED'
  WHERE inv."documentType" = 'TAX_INVOICE'
    AND inv."status" = 'ISSUED'
  GROUP BY inv."id", inv."businessId", inv."currency", inv."totalAmount"
)
SELECT currency,
       count(*)                          AS affected_invoice_count,
       count(DISTINCT business_id)       AS affected_business_count,
       sum(allocation_rows)              AS affected_allocation_rows,
       sum(allocated - invoice_total)    AS excess_allocated_amount
FROM inv_alloc
WHERE allocated > invoice_total
GROUP BY currency
ORDER BY currency;

\echo '== F2: invoices whose authoritative allocations plus issued credit exceed the invoice total (context, see header) =='
WITH inv_alloc AS (
  SELECT inv."id"                        AS invoice_id,
         inv."businessId"                AS business_id,
         inv."currency"                  AS currency,
         inv."totalAmount"               AS invoice_total,
         count(a."id")                   AS allocation_rows,
         sum(a."allocatedAmount")        AS allocated
  FROM "BillingDocument" inv
  JOIN "BillingPaymentAllocation" a
    ON a."invoiceDocumentId" = inv."id"
   AND a."businessId" = inv."businessId"
  JOIN "BillingDocument" r
    ON r."id" = a."receiptDocumentId"
   AND r."businessId" = a."businessId"
   AND r."status" = 'ISSUED'
  WHERE inv."documentType" = 'TAX_INVOICE'
    AND inv."status" = 'ISSUED'
  GROUP BY inv."id", inv."businessId", inv."currency", inv."totalAmount"
),
inv_credit AS (
  SELECT cn."referenceDocumentId"        AS invoice_id,
         sum(cn."totalAmount")           AS credited
  FROM "BillingDocument" cn
  WHERE cn."documentType" = 'CREDIT_NOTE'
    AND cn."status" = 'ISSUED'
    AND cn."referenceDocumentId" IS NOT NULL
  GROUP BY cn."referenceDocumentId"
)
SELECT ia.currency,
       count(*)                                                    AS affected_invoice_count,
       count(DISTINCT ia.business_id)                              AS affected_business_count,
       sum(ia.allocation_rows)                                     AS affected_allocation_rows,
       count(*) FILTER (WHERE ia.allocated > ia.invoice_total)     AS of_which_also_f1,
       sum(ia.allocated + coalesce(ic.credited, 0) - ia.invoice_total)
                                                                   AS excess_amount
FROM inv_alloc ia
LEFT JOIN inv_credit ic ON ic.invoice_id = ia.invoice_id
WHERE ia.allocated + coalesce(ic.credited, 0) > ia.invoice_total
GROUP BY ia.currency
ORDER BY ia.currency;

\echo '== E4: issued pure receipts whose allocations differ from the receipt total =='
WITH rcpt AS (
  SELECT r."id"                          AS receipt_id,
         r."businessId"                  AS business_id,
         r."currency"                    AS currency,
         r."totalAmount"                 AS receipt_total,
         count(a."id")                   AS allocation_rows,
         sum(a."allocatedAmount")        AS allocated
  FROM "BillingDocument" r
  JOIN "BillingPaymentAllocation" a
    ON a."receiptDocumentId" = r."id"
   AND a."businessId" = r."businessId"
  WHERE r."documentType" = 'RECEIPT'
    AND r."status" = 'ISSUED'
  GROUP BY r."id", r."businessId", r."currency", r."totalAmount"
)
SELECT currency,
       CASE WHEN allocated > receipt_total THEN 'OVER_ALLOCATED'
            ELSE 'UNDER_ALLOCATED' END   AS direction,
       count(*)                          AS affected_receipt_count,
       count(DISTINCT business_id)       AS affected_business_count,
       sum(allocation_rows)              AS affected_allocation_rows,
       sum(abs(allocated - receipt_total)) AS mismatch_amount
FROM rcpt
WHERE allocated <> receipt_total
GROUP BY currency, direction
ORDER BY currency, direction;

\echo '== Integrity context: rows that break a rule the readers assume =='
SELECT 'allocation_currency_differs_from_invoice'       AS check_name,
       count(*)                                         AS row_count
FROM "BillingPaymentAllocation" a
JOIN "BillingDocument" inv ON inv."id" = a."invoiceDocumentId"
WHERE a."currency" <> inv."currency"
UNION ALL
SELECT 'allocation_currency_differs_from_receipt',
       count(*)
FROM "BillingPaymentAllocation" a
JOIN "BillingDocument" r ON r."id" = a."receiptDocumentId"
WHERE a."currency" <> r."currency"
UNION ALL
SELECT 'allocation_business_differs_from_receipt_or_invoice',
       count(*)
FROM "BillingPaymentAllocation" a
JOIN "BillingDocument" r   ON r."id"   = a."receiptDocumentId"
JOIN "BillingDocument" inv ON inv."id" = a."invoiceDocumentId"
WHERE a."businessId" <> r."businessId"
   OR a."businessId" <> inv."businessId"
UNION ALL
SELECT 'allocation_target_not_issued_tax_invoice',
       count(*)
FROM "BillingPaymentAllocation" a
JOIN "BillingDocument" inv ON inv."id" = a."invoiceDocumentId"
WHERE inv."documentType" <> 'TAX_INVOICE'
   OR inv."status" <> 'ISSUED'
UNION ALL
SELECT 'allocation_source_not_pure_receipt',
       count(*)
FROM "BillingPaymentAllocation" a
JOIN "BillingDocument" r ON r."id" = a."receiptDocumentId"
WHERE r."documentType" <> 'RECEIPT';

\echo '== Population context (denominators) =='
SELECT 'issued_pure_receipts_total'                     AS measure,
       count(*)                                         AS value
FROM "BillingDocument"
WHERE "documentType" = 'RECEIPT' AND "status" = 'ISSUED'
UNION ALL
SELECT 'issued_pure_receipts_with_allocations',
       count(DISTINCT a."receiptDocumentId")
FROM "BillingPaymentAllocation" a
JOIN "BillingDocument" r ON r."id" = a."receiptDocumentId"
WHERE r."documentType" = 'RECEIPT' AND r."status" = 'ISSUED'
UNION ALL
SELECT 'issued_invoices_with_authoritative_allocations',
       count(DISTINCT a."invoiceDocumentId")
FROM "BillingPaymentAllocation" a
JOIN "BillingDocument" r
  ON r."id" = a."receiptDocumentId"
 AND r."businessId" = a."businessId"
 AND r."status" = 'ISSUED'
UNION ALL
SELECT 'allocation_rows_total',
       count(*)
FROM "BillingPaymentAllocation";

ROLLBACK;
