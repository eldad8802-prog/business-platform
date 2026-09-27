-- Read-only Production evidence: M1 inbound reconciliation, QA tenant only.
--
-- WHY THIS EXISTS
--
-- M1 claims that a payment CardCom took is recorded exactly once even when its
-- webhook never reaches the processing path. The Production proof is one
-- CardCom TEST-terminal payment on the QA tenant whose checkout was issued with
-- the callback pointed at a path nothing processes (audited on the request as
-- PAYMENT_REQUEST_QA_WEBHOOK_SUPPRESSED). This file shows, from Production's
-- own rows, that reconciliation alone discovered it and that exactly one money
-- row, one settlement, one automatic receipt, one allocation and one money-in
-- event followed. Running it again after a second reconciliation run must show
-- the same figures.
--
-- SCOPE AND PRIVACY. Only business 38, the permanent QA tenant (synthetic, see
-- ops/tenant/collection-qa-tenant.identity.env). Ids of its own synthetic rows
-- are shown so two runs can be compared; no name, contact or card detail.
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

\echo '== M1-Q1: QA requests issued with the callback suppressed, and what followed =='
\echo '   expected per paid request: webhook_events 0 · incoming_tx 1 · settled 1 of 1 · issued_receipts 1 · money_in_events 1 · verified_by RECONCILIATION'
WITH qa AS (
  SELECT pr.id, pr.status::text AS status, pr.amount, pr.currency,
         pr."providerRequestId", pr."billingDocumentId", pr."createdAt", pr."paidAt"
  FROM "PaymentRequest" pr
  WHERE pr."businessId" = 38
    AND EXISTS (
      SELECT 1 FROM "PaymentAuditEvent" e
      WHERE e."paymentRequestId" = pr.id
        AND e."eventType" = 'PAYMENT_REQUEST_QA_WEBHOOK_SUPPRESSED'
    )
),
money AS (
  SELECT t.id, t."paymentRequestId", t.amount, t.currency, t."providerTransactionId"
  FROM "PaymentTransaction" t
  JOIN qa ON qa.id = t."paymentRequestId"
  WHERE t.status = 'PAID' AND t.amount > 0
)
SELECT qa.id                                                                  AS request_id,
       qa.status                                                              AS request_status,
       qa.amount                                                              AS requested,
       qa.currency                                                            AS requested_currency,
       (SELECT count(*) FROM "PaymentWebhookEvent" w
         WHERE w.provider = 'CARDCOM'
           AND (w."providerEventId" = qa."providerRequestId"
                OR w."providerEventId" IN (SELECT m."providerTransactionId" FROM money m WHERE m."paymentRequestId" = qa.id))) AS webhook_events,
       (SELECT count(*) FROM money m WHERE m."paymentRequestId" = qa.id)      AS incoming_tx,
       (SELECT sum(m.amount) FROM money m WHERE m."paymentRequestId" = qa.id) AS incoming_amount,
       (SELECT min(m.currency) FROM money m WHERE m."paymentRequestId" = qa.id) AS incoming_currency,
       (SELECT count(*) FROM "PaymentAccountingSettlement" s
          JOIN money m ON m.id = s."paymentTransactionId"
         WHERE m."paymentRequestId" = qa.id AND s.status = 'SETTLED')         AS settled,
       (SELECT count(*) FROM "PaymentAccountingSettlement" s
          JOIN money m ON m.id = s."paymentTransactionId"
         WHERE m."paymentRequestId" = qa.id)                                  AS settlements,
       (SELECT count(*) FROM "BillingDocument" d
          JOIN money m ON m.id = d."sourcePaymentTransactionId"
         WHERE m."paymentRequestId" = qa.id AND d.status = 'ISSUED'
           AND d."documentType" = 'RECEIPT')                                  AS issued_receipts,
       (SELECT sum(d."totalAmount") FROM "BillingDocument" d
          JOIN money m ON m.id = d."sourcePaymentTransactionId"
         WHERE m."paymentRequestId" = qa.id AND d.status = 'ISSUED')          AS receipt_total,
       (SELECT count(*) FROM "BillingDocument" d
          JOIN money m ON m.id = d."sourcePaymentTransactionId"
         WHERE m."paymentRequestId" = qa.id AND d."issuedByUserId" IS NOT NULL) AS receipts_by_a_person,
       (SELECT sum(a."allocatedAmount") FROM "BillingPaymentAllocation" a
          JOIN "BillingDocument" d ON d.id = a."receiptDocumentId" AND d."businessId" = a."businessId"
          JOIN money m ON m.id = d."sourcePaymentTransactionId"
         WHERE m."paymentRequestId" = qa.id AND d.status = 'ISSUED')          AS allocated,
       (SELECT count(*) FROM "FinancialEvent" f
         WHERE f."businessId" = 38 AND f."sourceType"::text = 'PAYMENT'
           AND f."sourceKey" IN (SELECT m.id::text FROM money m WHERE m."paymentRequestId" = qa.id)) AS money_in_events,
       (SELECT e.metadata->>'source' FROM "PaymentAuditEvent" e
         WHERE e."paymentRequestId" = qa.id AND e."eventType" = 'PAYMENT_VERIFIED_PAID'
         ORDER BY e.id LIMIT 1)                                               AS verified_by,
       (SELECT count(*) FROM "PaymentAuditEvent" e
         WHERE e."paymentRequestId" = qa.id AND e."eventType" = 'PAYMENT_VERIFIED_PAID') AS verified_audits,
       qa."createdAt"                                                         AS request_created_at,
       qa."paidAt"                                                            AS request_paid_at
FROM qa
ORDER BY qa.id;

\echo '== M1-Q2: the invoice each suppressed request collects against (total, settled, credited, remaining) =='
SELECT inv.id                                                   AS invoice_id,
       inv."totalAmount"                                        AS invoice_total,
       coalesce((SELECT sum(a."allocatedAmount") FROM "BillingPaymentAllocation" a
                   JOIN "BillingDocument" r ON r.id = a."receiptDocumentId" AND r."businessId" = a."businessId"
                  WHERE a."invoiceDocumentId" = inv.id AND a."businessId" = inv."businessId"
                    AND r.status = 'ISSUED'), 0)                AS settled_by_issued_receipts,
       coalesce((SELECT sum(c."totalAmount") FROM "BillingDocument" c
                  WHERE c."referenceDocumentId" = inv.id AND c."businessId" = inv."businessId"
                    AND c."documentType" = 'CREDIT_NOTE' AND c.status = 'ISSUED'), 0) AS credited,
       greatest(0, inv."totalAmount"
         - coalesce((SELECT sum(a."allocatedAmount") FROM "BillingPaymentAllocation" a
                       JOIN "BillingDocument" r ON r.id = a."receiptDocumentId" AND r."businessId" = a."businessId"
                      WHERE a."invoiceDocumentId" = inv.id AND a."businessId" = inv."businessId"
                        AND r.status = 'ISSUED'), 0)
         - coalesce((SELECT sum(c."totalAmount") FROM "BillingDocument" c
                      WHERE c."referenceDocumentId" = inv.id AND c."businessId" = inv."businessId"
                        AND c."documentType" = 'CREDIT_NOTE' AND c.status = 'ISSUED'), 0)) AS remaining
FROM "BillingDocument" inv
WHERE inv."businessId" = 38
  AND inv.id IN (
    SELECT pr."billingDocumentId" FROM "PaymentRequest" pr
    WHERE pr."businessId" = 38 AND pr."billingDocumentId" IS NOT NULL
      AND EXISTS (SELECT 1 FROM "PaymentAuditEvent" e
                   WHERE e."paymentRequestId" = pr.id
                     AND e."eventType" = 'PAYMENT_REQUEST_QA_WEBHOOK_SUPPRESSED')
  )
ORDER BY inv.id;

\echo '== M1-Q3: exactly-once across the whole QA tenant (expected: all zero) =='
SELECT count(*) FILTER (WHERE n > 1)            AS provider_tx_recorded_twice,
       (SELECT count(*) FROM "PaymentAccountingSettlement" s
         WHERE s."businessId" = 38 AND s.status = 'SETTLED'
           AND (SELECT count(*) FROM "BillingDocument" d
                 WHERE d."sourcePaymentTransactionId" = s."paymentTransactionId" AND d.status = 'ISSUED') <> 1) AS settled_without_exactly_one_receipt,
       (SELECT count(*) FROM "PaymentTransaction" t
          JOIN "PaymentRequest" pr ON pr.id = t."paymentRequestId"
         WHERE pr."businessId" = 38 AND t.status = 'PAID' AND t.amount > 0
           AND pr.status <> 'PAID')                    AS money_on_a_request_not_paid
FROM (
  SELECT t."providerTransactionId", count(*) AS n
  FROM "PaymentTransaction" t
  JOIN "PaymentRequest" pr ON pr.id = t."paymentRequestId"
  WHERE pr."businessId" = 38 AND t."providerTransactionId" IS NOT NULL
  GROUP BY t."providerTransactionId"
) x;

\echo '== M1-Q4: QA audit trail of the proof (event types and sources, no content) =='
SELECT e."eventType" AS event_type, e.source AS source, e.metadata->>'source' AS path, count(*) AS events
FROM "PaymentAuditEvent" e
WHERE e."businessId" = 38
  AND e."eventType" IN ('PAYMENT_REQUEST_QA_WEBHOOK_SUPPRESSED', 'PAYMENT_VERIFIED_PAID',
                        'PAYMENT_ACCOUNTING_SETTLED', 'PAYMENT_PAID_AFTER_REQUEST_CLOSED',
                        'PAYMENT_VERIFIED_AMOUNT_MISMATCH', 'PAYMENT_VERIFIED_CURRENCY_MISMATCH',
                        'PAYMENT_VERIFIED_WITHOUT_TRANSACTION_ID', 'PAYMENT_VERIFIED_WITHOUT_AMOUNT',
                        'PAYMENT_PROVIDER_TRANSACTION_CONFLICT')
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;

ROLLBACK;
