-- C3 — verified payment → accounting settlement: the schema it stands on.
--
-- PR-1 of the migration-first rule: this file only. No schema.prisma, no
-- runtime code; the application change follows once this is applied.
-- Expand-only. No backfill. Every existing row keeps its meaning, and code
-- that has never heard of these objects keeps working unchanged.
--
-- THREE THINGS, ONE REASON
--
-- A customer who pays through Dubiz today leaves a verified PaymentTransaction,
-- a PAID request and a FinancialEvent — and no receipt, no allocation, and an
-- invoice that still looks unpaid. C3 closes that, and needs:
--
--   1. BillingDocument.sourcePaymentTransactionId
--      The receipt's durable link to the money it evidences. UNIQUE, so one
--      verified settlement can produce at most one receipt — enforced by the
--      database, not by a lookup that two concurrent attempts can both pass.
--      Nullable: every existing document, and every manual receipt, has none.
--
--   2. BillingDocument.unappliedAmount
--      Money a receipt evidences but applies to no debt. A payment of 1,000
--      against an invoice with 600 economically remaining becomes ONE receipt
--      of 1,000 that allocates 600 and states 400 unapplied — both truths, in
--      one legal record, instead of an invalid 1,000 allocation or a receipt
--      that forgets the invoice. The issuance invariant becomes
--          Σ allocations + unappliedAmount = total   (exactly)
--      with the ad-hoc receipt (no allocation, nothing unapplied) unchanged.
--      DEFAULT 0 makes every existing row, and every manual receipt, mean
--      exactly what it meant before.
--
--   3. PaymentAccountingSettlement
--      One row per verified positive incoming payment that C3 must settle.
--      It is the durable forward-only boundary (a transaction recorded before
--      C3 has no row and is never settled automatically), the recovery queue
--      (PENDING rows are resumable from local state, without a provider
--      redelivering anything), and the place REQUIRES_ATTENTION lives — a
--      pause on blind retries, not a terminal state: once the owner resolves
--      the cause the row returns to PENDING and runs through the same
--      idempotent settlement, producing no second accounting effect.
--
-- PRIVILEGES — measured in Production (evidence run 35650673108), not assumed.
-- app_runtime_prod holds table-wide SELECT/INSERT/UPDATE on BillingDocument
-- and no column-scoped ACL, so the two new columns are usable by the runtime
-- as soon as they exist. New tables created by neondb_owner hand app_runtime
-- SELECT/INSERT/UPDATE/DELETE by default; the settlement table's privileges are
-- therefore stated explicitly below and DELETE is taken back — a settlement
-- record is never removed.

-- ============================================================
-- 1. The receipt's link to the settlement it evidences
-- ============================================================
ALTER TABLE "BillingDocument"
  ADD COLUMN "sourcePaymentTransactionId" INTEGER;

CREATE UNIQUE INDEX "BillingDocument_sourcePaymentTransactionId_key"
  ON "BillingDocument"("sourcePaymentTransactionId");

-- RESTRICT: both sides are fiscal records retained under erasure. A payment
-- that a receipt evidences must never disappear from under it.
ALTER TABLE "BillingDocument"
  ADD CONSTRAINT "BillingDocument_sourcePaymentTransactionId_fkey"
  FOREIGN KEY ("sourcePaymentTransactionId") REFERENCES "PaymentTransaction"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================
-- 2. Money a receipt evidences but applies to no debt
-- ============================================================
ALTER TABLE "BillingDocument"
  ADD COLUMN "unappliedAmount" DECIMAL(18,2) NOT NULL DEFAULT 0;

ALTER TABLE "BillingDocument"
  ADD CONSTRAINT "BillingDocument_unappliedAmount_nonnegative"
  CHECK ("unappliedAmount" >= 0);

-- ============================================================
-- 3. The settlement ledger: boundary, recovery queue, attention
-- ============================================================
CREATE TYPE "PaymentAccountingSettlementStatus" AS ENUM (
  'PENDING',
  'SETTLED',
  'REQUIRES_ATTENTION'
);

CREATE TABLE "PaymentAccountingSettlement" (
  "id"                   SERIAL                              NOT NULL,
  "businessId"           INTEGER                             NOT NULL,
  "paymentTransactionId" INTEGER                             NOT NULL,
  "status"               "PaymentAccountingSettlementStatus" NOT NULL DEFAULT 'PENDING',
  -- A code, never free text about a person: NO_CUSTOMER,
  -- BILLING_IDENTITY_INCOMPLETE, RETRY_EXHAUSTED, …
  "attentionReason"      TEXT,
  "attemptCount"         INTEGER                             NOT NULL DEFAULT 0,
  "lastAttemptAt"        TIMESTAMP(3),
  "nextAttemptAt"        TIMESTAMP(3),
  -- Diagnostic only, written by the application without personal data, and
  -- bounded here so it can never become a place to keep payloads.
  "lastError"            TEXT,
  "settledAt"            TIMESTAMP(3),
  "createdAt"            TIMESTAMP(3)                        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3)                        NOT NULL,
  CONSTRAINT "PaymentAccountingSettlement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentAccountingSettlement_attemptCount_nonnegative"
    CHECK ("attemptCount" >= 0),
  CONSTRAINT "PaymentAccountingSettlement_lastError_bounded"
    CHECK ("lastError" IS NULL OR char_length("lastError") <= 500),
  -- Both sides of each equality are NOT NULL booleans ("status" is NOT NULL,
  -- IS [NOT] NULL never yields NULL), so neither check can pass vacuously.
  CONSTRAINT "PaymentAccountingSettlement_settled_iff_settledAt"
    CHECK (("status" = 'SETTLED') = ("settledAt" IS NOT NULL)),
  CONSTRAINT "PaymentAccountingSettlement_attention_iff_reason"
    CHECK (("status" = 'REQUIRES_ATTENTION') = ("attentionReason" IS NOT NULL))
);

-- One settlement per verified payment. With the receipt-side UNIQUE above,
-- webhook, scheduled recovery and a manual retry can all run at once and still
-- produce exactly one accounting effect.
CREATE UNIQUE INDEX "PaymentAccountingSettlement_paymentTransactionId_key"
  ON "PaymentAccountingSettlement"("paymentTransactionId");

-- The recovery scan: per tenant, what is due.
CREATE INDEX "PaymentAccountingSettlement_businessId_status_nextAttemptAt_idx"
  ON "PaymentAccountingSettlement"("businessId", "status", "nextAttemptAt");

ALTER TABLE "PaymentAccountingSettlement"
  ADD CONSTRAINT "PaymentAccountingSettlement_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PaymentAccountingSettlement"
  ADD CONSTRAINT "PaymentAccountingSettlement_paymentTransactionId_fkey"
  FOREIGN KEY ("paymentTransactionId") REFERENCES "PaymentTransaction"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ------------------------------------------------------------
-- Tenant isolation. Same predicate as BillingDocument, one policy per verb,
-- and deliberately no DELETE policy: a settlement record is never removed.
-- ------------------------------------------------------------
ALTER TABLE "PaymentAccountingSettlement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentAccountingSettlement" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS c3_settlement_tenant_read ON "PaymentAccountingSettlement";
CREATE POLICY c3_settlement_tenant_read ON "PaymentAccountingSettlement" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

DROP POLICY IF EXISTS c3_settlement_tenant_insert ON "PaymentAccountingSettlement";
CREATE POLICY c3_settlement_tenant_insert ON "PaymentAccountingSettlement" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

DROP POLICY IF EXISTS c3_settlement_tenant_update ON "PaymentAccountingSettlement";
CREATE POLICY c3_settlement_tenant_update ON "PaymentAccountingSettlement" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ------------------------------------------------------------
-- Runtime privileges, stated rather than inherited. Guarded so the migration
-- stays portable to databases without the role (labs, CI).
-- ------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON "PaymentAccountingSettlement" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "PaymentAccountingSettlement_id_seq" TO app_runtime;

    -- Not granting DELETE is not the same as not having it: Production's
    -- default privileges hand app_runtime DELETE on every new table (measured,
    -- evidence run 35650673108). RLS has no DELETE policy either, but the
    -- record's permanence should not rest on one mechanism.
    REVOKE DELETE ON "PaymentAccountingSettlement" FROM app_runtime;
  END IF;
END
$$;
