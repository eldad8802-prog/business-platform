-- Read-only Production evidence for the completed CardCom Sandbox E2E.
--
-- Verifies that the standalone Payments flow produced a FinancialEvent(PAYMENT)
-- and that billing isolation held (no BillingDocument / invoice / receipt).
--
-- SELECT-only. Wrapped in a READ ONLY transaction that always ROLLBACKs, with a
-- session read-only guard and a statement timeout. This file must never contain
-- a write statement; a CI guard rejects it before it ever reaches the database.
--
-- Known identifiers (from the browser E2E):
--   PaymentRequestId            = 1
--   Provider TransactionId      = 253736273   (CardCom)
--   Amount / currency           = 10 / ILS
--   Expected final status       = PAID
-- NOTE: FinancialEvent.sourceKey is the INTERNAL PaymentTransaction.id::text,
--       not the provider id 253736273 and not the paymentRequestId.

SET statement_timeout = '30s';
SET default_transaction_read_only = on;
BEGIN TRANSACTION READ ONLY;

\echo '== Q1: PaymentRequest id 1 =='
SELECT id,"businessId","customerId","billingDocumentId",provider,amount,currency,status,"paidAt","createdAt"
FROM "PaymentRequest" WHERE id = 1;

\echo '== Q2: PaymentTransaction providerTransactionId 253736273 (its id is the sourceKey) =='
SELECT id,"paymentRequestId",provider,"providerTransactionId",amount,currency,status,"createdAt"
FROM "PaymentTransaction" WHERE "providerTransactionId" = '253736273';

\echo '== Q3: PaymentAuditEvent PAYMENT_VERIFIED_PAID for request 1 =='
SELECT id,"businessId","paymentRequestId","eventType",source,"occurredAt","createdAt"
FROM "PaymentAuditEvent"
WHERE "paymentRequestId" = 1 AND "eventType" = 'PAYMENT_VERIFIED_PAID'
ORDER BY "occurredAt";

\echo '== Q4: FinancialEvent PAYMENT, sourceKey = PaymentTransaction.id::text =='
SELECT fe.id,fe."businessId",fe.direction,fe.category,fe."sourceType",fe."sourceKey",
       fe.amount,fe.currency,fe.status,fe."billingDocumentId",fe."occurredAt",fe."createdAt"
FROM "FinancialEvent" fe
WHERE fe."sourceType" = 'PAYMENT'
  AND fe."sourceKey" = (SELECT id::text FROM "PaymentTransaction"
                        WHERE "providerTransactionId" = '253736273');

\echo '== Q5: billingDocumentId null on both request and financial event =='
SELECT
  (SELECT "billingDocumentId" FROM "PaymentRequest" WHERE id = 1) AS request_billingdocid,
  (SELECT fe."billingDocumentId" FROM "FinancialEvent" fe
     WHERE fe."sourceType" = 'PAYMENT'
       AND fe."sourceKey" = (SELECT id::text FROM "PaymentTransaction"
                             WHERE "providerTransactionId" = '253736273')
  ) AS financialevent_billingdocid;

\echo '== Q6: BillingDocuments for this business (context only — the payment flow produces none) =='
SELECT id,"businessId","documentType",status,"documentNumberFormatted",totalAmount,currency,"createdAt"
FROM "BillingDocument"
WHERE "businessId" = (SELECT "businessId" FROM "PaymentRequest" WHERE id = 1)
ORDER BY "createdAt" DESC
LIMIT 20;

ROLLBACK;
