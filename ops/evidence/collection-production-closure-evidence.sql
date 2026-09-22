-- Read-only Production evidence: collection programme closure.
--
-- WHY THIS EXISTS
--
-- The settlement engine, scheduled recovery and the /collection product are
-- deployed. Closure is claimed from Production's own state, not from CI: the
-- migration ledger is healthy, every automatic receipt obeys the accounting
-- invariants, no invoice is settled beyond what it is worth, no verified
-- payment has two receipts, and no settlement is stuck past the point where
-- scheduled recovery should have taken it.
--
-- PRIVACY. Counts and money totals only, grouped where money is summed. No
-- identifier, name or content of any business, customer or document.
--
-- SELECT-only. Wrapped in a READ ONLY transaction that always rolls back, with
-- a session read-only guard and a statement timeout. A CI guard rejects this
-- file before it reaches any database if it bears a writing keyword anywhere,
-- prose included.

SET statement_timeout = '30s';
SET default_transaction_read_only = on;
BEGIN TRANSACTION READ ONLY;

\echo '== L1: migration ledger health (expected: 0 unfinished, 0 rolled back) =='
SELECT count(*)                                                        AS ledger_rows,
       count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS unfinished,
       count(*) FILTER (WHERE rolled_back_at IS NOT NULL)              AS rolled_back,
       max(migration_name)                                             AS latest_migration
FROM "_prisma_migrations";

\echo '== S1: settlement rows by state =='
SELECT status::text                                    AS settlement_status,
       count(*)                                        AS settlements,
       count(*) FILTER (WHERE "attentionReason" IS NOT NULL) AS with_reason
FROM "PaymentAccountingSettlement"
GROUP BY status
ORDER BY status;

\echo '== S2: attention reasons (codes only) =='
SELECT "attentionReason" AS reason, count(*) AS settlements
FROM "PaymentAccountingSettlement"
WHERE status = 'REQUIRES_ATTENTION'
GROUP BY "attentionReason"
ORDER BY "attentionReason";

\echo '== S3: PENDING settlements overdue for recovery (expected: 0) =='
SELECT count(*) AS overdue_pending
FROM "PaymentAccountingSettlement"
WHERE status = 'PENDING'
  AND coalesce("nextAttemptAt", "createdAt") < (now() AT TIME ZONE 'UTC') - interval '30 minutes';

\echo '== S4: every SETTLED settlement has exactly one issued receipt (expected: 0 mismatches) =='
SELECT count(*) FILTER (WHERE receipts = 0) AS settled_without_receipt,
       count(*) FILTER (WHERE receipts > 1) AS settled_with_several_receipts
FROM (
  SELECT s."paymentTransactionId",
         (SELECT count(*) FROM "BillingDocument" d
           WHERE d."sourcePaymentTransactionId" = s."paymentTransactionId"
             AND d.status = 'ISSUED') AS receipts
  FROM "PaymentAccountingSettlement" s
  WHERE s.status = 'SETTLED'
) x;

\echo '== R1: automatic receipts obey Σ allocations + unapplied = total (expected: 0 violations) =='
SELECT count(*)                                                   AS automatic_receipts,
       count(*) FILTER (WHERE alloc + unapplied <> total
                          AND NOT (alloc = 0 AND unapplied = 0))  AS equality_violations,
       count(*) FILTER (WHERE issued_by IS NOT NULL)              AS attributed_to_a_person
FROM (
  SELECT d."totalAmount" AS total,
         d."unappliedAmount" AS unapplied,
         d."issuedByUserId" AS issued_by,
         coalesce((SELECT sum(a."allocatedAmount") FROM "BillingPaymentAllocation" a
                    WHERE a."receiptDocumentId" = d.id), 0) AS alloc
  FROM "BillingDocument" d
  WHERE d."documentType" = 'RECEIPT'
    AND d.status = 'ISSUED'
    AND d."sourcePaymentTransactionId" IS NOT NULL
) r;

\echo '== R2: automatic receipts total vs the verified money they evidence (expected: 0 mismatches) =='
SELECT count(*) FILTER (WHERE d."totalAmount" <> t.amount) AS receipt_amount_mismatch,
       count(*) FILTER (WHERE t.status::text <> 'PAID' OR t.amount <= 0) AS receipt_for_non_verified_money
FROM "BillingDocument" d
JOIN "PaymentTransaction" t ON t.id = d."sourcePaymentTransactionId"
WHERE d."documentType" = 'RECEIPT';

\echo '== F1: invoices settled beyond their total by issued receipts (expected: 0) =='
SELECT count(*) AS over_settled_invoices
FROM (
  SELECT inv.id
  FROM "BillingDocument" inv
  JOIN "BillingPaymentAllocation" a ON a."invoiceDocumentId" = inv.id AND a."businessId" = inv."businessId"
  JOIN "BillingDocument" r ON r.id = a."receiptDocumentId" AND r."businessId" = a."businessId" AND r.status = 'ISSUED'
  WHERE inv."documentType" = 'TAX_INVOICE' AND inv.status = 'ISSUED'
  GROUP BY inv.id, inv."totalAmount"
  HAVING sum(a."allocatedAmount") > inv."totalAmount"
) x;

\echo '== P1: verified incoming payments by accounting coverage =='
SELECT CASE WHEN s.id IS NULL THEN 'historical (no settlement row)' ELSE 'settlement row' END AS coverage,
       count(*)                  AS verified_payments,
       t.currency                AS currency,
       sum(t.amount)             AS verified_amount
FROM "PaymentTransaction" t
LEFT JOIN "PaymentAccountingSettlement" s ON s."paymentTransactionId" = t.id
WHERE t.status = 'PAID' AND t.amount > 0
GROUP BY 1, t.currency
ORDER BY 1, t.currency;

ROLLBACK;
