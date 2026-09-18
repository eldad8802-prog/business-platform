-- Read-only Production evidence: unissued receipts whose allocations already
-- reduce an invoice balance.
--
-- WHY THIS EXISTS
--
-- Allocations are written while a receipt is still a draft, and every reader of
-- outstanding sums them without asking whether that receipt was ever issued.
-- The collection loader applies the opposite rule to the other instrument — it
-- counts only ISSUED credit notes, on the stated ground that a draft is an
-- intention and must not remove a real debt. Both rules cannot be right.
--
-- C2 will make the two agree by counting only an ISSUED receipt's allocations.
-- The moment that ships, every invoice currently being reduced by an unissued
-- receipt becomes owed again. This file measures how many such invoices exist
-- before anything changes, so the question is answered from Production rather
-- than from an assumption in either direction.
--
-- POPULATION
--
--   "BillingDocument"."documentType" = 'RECEIPT'
--   AND "BillingDocument"."status" IN ('DRAFT','PENDING_REVIEW')
--   AND at least one "BillingPaymentAllocation" row points at it
--
-- Both statuses are measured because the immutability guard refuses only
-- ISSUED: a receipt awaiting review can hold allocations exactly as a draft
-- one can, and the read model treats them alike. They are reported side by
-- side and never summed together.
--
-- PRIVACY. Counts and money only. No name, email, phone, address, business
-- name, document number, invoice content or credential is selected here.
-- Currencies are grouped, never combined into a single figure.
--
-- SELECT-only. Wrapped in a READ ONLY transaction that always rolls back, with
-- a session read-only guard and a statement timeout. A CI guard rejects this
-- file before it reaches any database if it bears a writing keyword anywhere,
-- prose included.

SET statement_timeout = '30s';
SET default_transaction_read_only = on;
BEGIN TRANSACTION READ ONLY;

\echo '== Q1: affected unissued receipts, by status =='
SELECT r."status"                                AS receipt_status,
       count(DISTINCT r."id")                    AS affected_receipt_count,
       count(a."id")                             AS affected_allocation_count,
       count(DISTINCT r."businessId")            AS affected_business_count
FROM "BillingDocument" r
JOIN "BillingPaymentAllocation" a
  ON a."receiptDocumentId" = r."id"
WHERE r."documentType" = 'RECEIPT'
  AND r."status" IN ('DRAFT', 'PENDING_REVIEW')
GROUP BY r."status"
ORDER BY r."status";

\echo '== Q2: allocated money, by status and currency (never combined) =='
SELECT r."status"                                AS receipt_status,
       a."currency"                              AS currency,
       count(a."id")                             AS allocation_count,
       sum(a."allocatedAmount")                  AS total_allocated_amount
FROM "BillingDocument" r
JOIN "BillingPaymentAllocation" a
  ON a."receiptDocumentId" = r."id"
WHERE r."documentType" = 'RECEIPT'
  AND r."status" IN ('DRAFT', 'PENDING_REVIEW')
GROUP BY r."status", a."currency"
ORDER BY r."status", a."currency";

\echo '== Q3: the subset that actually hides a visible debt =='
-- Only allocations aimed at an ISSUED TAX_INVOICE reduce a balance anyone can
-- see. An allocation pointing anywhere else changes no visible debt, so this is
-- the figure that sizes the real impact of the C2 rule change.
SELECT r."status"                                AS receipt_status,
       inv."currency"                            AS currency,
       count(DISTINCT r."id")                    AS affected_receipt_count,
       count(a."id")                             AS affected_allocation_count,
       count(DISTINCT r."businessId")            AS affected_business_count,
       count(DISTINCT inv."id")                  AS affected_invoice_count,
       sum(a."allocatedAmount")                  AS total_allocated_amount
FROM "BillingDocument" r
JOIN "BillingPaymentAllocation" a
  ON a."receiptDocumentId" = r."id"
JOIN "BillingDocument" inv
  ON inv."id" = a."invoiceDocumentId"
WHERE r."documentType" = 'RECEIPT'
  AND r."status" IN ('DRAFT', 'PENDING_REVIEW')
  AND inv."documentType" = 'TAX_INVOICE'
  AND inv."status" = 'ISSUED'
GROUP BY r."status", inv."currency"
ORDER BY r."status", inv."currency";

ROLLBACK;
