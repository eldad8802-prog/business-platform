-- Accounts Payable — Phase 1a foundation.
--
-- EXPAND-ONLY. This migration creates new types, tables and indexes and does
-- NOT drop, rename or repurpose anything. `BusinessObligation` is untouched and
-- keeps serving today's Secretary reminders; the backfill into the new ledger is
-- a separate, later migration so that this one can be reviewed on its own.
--
-- Architecture: docs/dubiz-accounts-payable-commitments-programme-v1.md

-- ── enums ────────────────────────────────────────────────────────────────────

CREATE TYPE "PayeeKind" AS ENUM (
  'SUPPLIER', 'AUTHORITY', 'UTILITY', 'LANDLORD',
  'EMPLOYEE', 'LENDER', 'INSURER', 'OTHER'
);

CREATE TYPE "CommitmentScheduleKind" AS ENUM ('ONE_OFF', 'RECURRING', 'INSTALLMENT_PLAN');

CREATE TYPE "CommitmentStatus" AS ENUM ('ACTIVE', 'CLOSED', 'RELEASED');

CREATE TYPE "InstallmentStatus" AS ENUM ('SCHEDULED', 'CANCELLED', 'SETTLED_LEGACY');

CREATE TYPE "PaymentStatus" AS ENUM ('RECORDED', 'VOID');

CREATE TYPE "PaymentEvidenceKind" AS ENUM (
  'MANUAL', 'DOCUMENT', 'BANK_TRANSACTION', 'PAYMENT_PROVIDER', 'CHEQUE'
);

-- Additive enum extension. The new values are not USED anywhere in this
-- migration, which is what makes adding them inside its transaction safe.
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'DIRECT_DEBIT';
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'STANDING_ORDER';

-- ── Payee ────────────────────────────────────────────────────────────────────

CREATE TABLE "Payee" (
  "id"          SERIAL NOT NULL,
  "businessId"  INTEGER NOT NULL,
  "displayName" TEXT NOT NULL,
  "kind"        "PayeeKind" NOT NULL DEFAULT 'OTHER',
  "legalName"   TEXT,
  "taxId"       TEXT,
  "taxIdType"   "CustomerTaxIdType",
  "isActive"    BOOLEAN NOT NULL DEFAULT true,
  "note"        TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Payee_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Payee_businessId_isActive_idx"    ON "Payee"("businessId", "isActive");
CREATE INDEX "Payee_businessId_taxId_idx"       ON "Payee"("businessId", "taxId");
CREATE INDEX "Payee_businessId_displayName_idx" ON "Payee"("businessId", "displayName");

ALTER TABLE "Payee" ADD CONSTRAINT "Payee_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Commitment ───────────────────────────────────────────────────────────────

CREATE TABLE "Commitment" (
  "id"                   SERIAL NOT NULL,
  "businessId"           INTEGER NOT NULL,
  "title"                TEXT NOT NULL,
  "category"             TEXT,
  "payeeId"              INTEGER,
  "payeeNameSnapshot"    TEXT NOT NULL,
  "currency"             TEXT NOT NULL DEFAULT 'ILS',
  "totalAmount"          DECIMAL(18,2),
  "scheduleKind"         "CommitmentScheduleKind" NOT NULL,
  "recurrence"           TEXT NOT NULL DEFAULT 'NONE',
  "recurrenceSeriesId"   TEXT,
  "startAt"              TIMESTAMP(3),
  "endAt"                TIMESTAMP(3),
  "defaultPaymentMethod" "PaymentMethod",
  "status"               "CommitmentStatus" NOT NULL DEFAULT 'ACTIVE',
  "note"                 TEXT,
  "legacyObligationId"   INTEGER,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Commitment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Commitment_businessId_status_idx"             ON "Commitment"("businessId", "status");
CREATE INDEX "Commitment_businessId_payeeId_idx"            ON "Commitment"("businessId", "payeeId");
CREATE INDEX "Commitment_businessId_legacyObligationId_idx" ON "Commitment"("businessId", "legacyObligationId");

ALTER TABLE "Commitment" ADD CONSTRAINT "Commitment_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SetNull, not Cascade: deleting a payee must never delete payable history. The
-- Tier-1 `payeeNameSnapshot` is what keeps the record meaningful afterwards.
ALTER TABLE "Commitment" ADD CONSTRAINT "Commitment_payeeId_fkey"
  FOREIGN KEY ("payeeId") REFERENCES "Payee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Installment ──────────────────────────────────────────────────────────────

CREATE TABLE "Installment" (
  "id"                         SERIAL NOT NULL,
  "businessId"                 INTEGER NOT NULL,
  "commitmentId"               INTEGER NOT NULL,
  "sequence"                   INTEGER NOT NULL,
  "scheduledAmount"            DECIMAL(18,2) NOT NULL,
  "currency"                   TEXT NOT NULL DEFAULT 'ILS',
  "dueAt"                      TIMESTAMP(3) NOT NULL,
  "status"                     "InstallmentStatus" NOT NULL DEFAULT 'SCHEDULED',
  "cancelledAt"                TIMESTAMP(3),
  "legacySettlementAssertedBy" TEXT,
  "legacyMetAt"                TIMESTAMP(3),
  "note"                       TEXT,
  "createdAt"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Installment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Installment_commitmentId_sequence_key" ON "Installment"("commitmentId", "sequence");
CREATE INDEX "Installment_businessId_dueAt_idx"  ON "Installment"("businessId", "dueAt");
CREATE INDEX "Installment_businessId_status_idx" ON "Installment"("businessId", "status");
CREATE INDEX "Installment_commitmentId_idx"      ON "Installment"("commitmentId");

ALTER TABLE "Installment" ADD CONSTRAINT "Installment_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Installment" ADD CONSTRAINT "Installment_commitmentId_fkey"
  FOREIGN KEY ("commitmentId") REFERENCES "Commitment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Payment ──────────────────────────────────────────────────────────────────

CREATE TABLE "Payment" (
  "id"                SERIAL NOT NULL,
  "businessId"        INTEGER NOT NULL,
  "payeeId"           INTEGER,
  "payeeNameSnapshot" TEXT NOT NULL,
  "amount"            DECIMAL(18,2) NOT NULL,
  "currency"          TEXT NOT NULL DEFAULT 'ILS',
  "paidAt"            TIMESTAMP(3) NOT NULL,
  "method"            "PaymentMethod" NOT NULL,
  "externalReference" TEXT,
  "status"            "PaymentStatus" NOT NULL DEFAULT 'RECORDED',
  "idempotencyKey"    TEXT,
  "createdByUserId"   INTEGER,
  "voidedAt"          TIMESTAMP(3),
  "voidedByUserId"    INTEGER,
  "voidReason"        TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- NULL is distinct in Postgres, so payments recorded without a retry key are
-- unaffected by this constraint — exactly the behaviour PaymentTransaction
-- relies on for its provider-transaction uniqueness.
CREATE UNIQUE INDEX "Payment_businessId_idempotencyKey_key" ON "Payment"("businessId", "idempotencyKey");
CREATE INDEX "Payment_businessId_paidAt_idx"  ON "Payment"("businessId", "paidAt");
CREATE INDEX "Payment_businessId_payeeId_idx" ON "Payment"("businessId", "payeeId");
CREATE INDEX "Payment_businessId_status_idx"  ON "Payment"("businessId", "status");

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_payeeId_fkey"
  FOREIGN KEY ("payeeId") REFERENCES "Payee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── PaymentAllocation ────────────────────────────────────────────────────────

CREATE TABLE "PaymentAllocation" (
  "id"               SERIAL NOT NULL,
  "businessId"       INTEGER NOT NULL,
  "paymentId"        INTEGER NOT NULL,
  "installmentId"    INTEGER NOT NULL,
  "allocatedAmount"  DECIMAL(18,2) NOT NULL,
  "currency"         TEXT NOT NULL DEFAULT 'ILS',
  "createdByUserId"  INTEGER,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reversedAt"       TIMESTAMP(3),
  "reversedByUserId" INTEGER,
  "reversalReason"   TEXT,
  CONSTRAINT "PaymentAllocation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PaymentAllocation_businessId_installmentId_idx" ON "PaymentAllocation"("businessId", "installmentId");
CREATE INDEX "PaymentAllocation_businessId_paymentId_idx"     ON "PaymentAllocation"("businessId", "paymentId");
CREATE INDEX "PaymentAllocation_paymentId_installmentId_idx"  ON "PaymentAllocation"("paymentId", "installmentId");

-- THE PARTIAL UNIQUE INDEX.
--
-- One ACTIVE allocation per (payment, installment). A reversed row keeps its
-- place in history and must NOT block re-allocating the same pair later.
--
-- Prisma cannot express a partial unique index, so this is raw SQL and the
-- schema carries a comment forbidding its regeneration: `prisma db pull` would
-- silently drop the `WHERE` predicate and turn it into a plain `@@unique`,
-- which would make a legitimate re-allocation after reversal impossible. Same
-- class of hazard as the `secretHash` CHECK constraint already documented in
-- the schema.
--
-- NOTE for CI: `prisma db push` does NOT create this index, because it is not
-- expressible in the datamodel. The DB-backed suite creates it explicitly
-- before asserting on it — see the Phase 1a test workflow.
CREATE UNIQUE INDEX "PaymentAllocation_active_payment_installment_key"
  ON "PaymentAllocation"("paymentId", "installmentId")
  WHERE "reversedAt" IS NULL;

ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Restrict, not Cascade: accounting history is never removed by deleting one
-- side of it. A payment or installment that carries allocations cannot be
-- deleted at all — correction goes through VOID / reversal instead.
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_installmentId_fkey"
  FOREIGN KEY ("installmentId") REFERENCES "Installment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── PaymentEvidence ──────────────────────────────────────────────────────────

CREATE TABLE "PaymentEvidence" (
  "id"               SERIAL NOT NULL,
  "businessId"       INTEGER NOT NULL,
  "paymentId"        INTEGER NOT NULL,
  "kind"             "PaymentEvidenceKind" NOT NULL,
  "note"             TEXT,
  "assertedByUserId" INTEGER,
  "confirmedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentEvidence_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PaymentEvidence_businessId_paymentId_idx" ON "PaymentEvidence"("businessId", "paymentId");
CREATE INDEX "PaymentEvidence_businessId_kind_idx"      ON "PaymentEvidence"("businessId", "kind");

ALTER TABLE "PaymentEvidence" ADD CONSTRAINT "PaymentEvidence_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PaymentEvidence" ADD CONSTRAINT "PaymentEvidence_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── PayablesAuditEvent ───────────────────────────────────────────────────────

CREATE TABLE "PayablesAuditEvent" (
  "id"            SERIAL NOT NULL,
  "businessId"    INTEGER NOT NULL,
  "commitmentId"  INTEGER,
  "installmentId" INTEGER,
  "paymentId"     INTEGER,
  "allocationId"  INTEGER,
  "actorUserId"   INTEGER,
  "eventType"     TEXT NOT NULL,
  "source"        TEXT NOT NULL DEFAULT 'USER',
  "summary"       TEXT NOT NULL,
  "metadata"      JSONB,
  "eventHash"     TEXT NOT NULL,
  "occurredAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PayablesAuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PayablesAuditEvent_businessId_occurredAt_idx"               ON "PayablesAuditEvent"("businessId", "occurredAt");
CREATE INDEX "PayablesAuditEvent_businessId_commitmentId_occurredAt_idx"  ON "PayablesAuditEvent"("businessId", "commitmentId", "occurredAt");
CREATE INDEX "PayablesAuditEvent_businessId_paymentId_occurredAt_idx"     ON "PayablesAuditEvent"("businessId", "paymentId", "occurredAt");
CREATE INDEX "PayablesAuditEvent_eventType_occurredAt_idx"                ON "PayablesAuditEvent"("eventType", "occurredAt");

-- The audit trail deliberately holds no FK to the subjects it describes beyond
-- the tenant: an audit row must survive the thing it audited.
ALTER TABLE "PayablesAuditEvent" ADD CONSTRAINT "PayablesAuditEvent_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
