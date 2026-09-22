-- Accounts Payable Phases 4–6 — where money goes, preparing a payment, what the
-- bank observed, and asking a provider to move money.
--
-- EXPAND-ONLY. Five new tables, one nullable column on PaymentEvidence, eight
-- enums. Nothing is dropped, renamed, repurposed or emptied, and no existing row
-- is written.
--
-- ONE ACCOUNTING TRUTH. None of these tables holds money that counts. The only
-- figure that settles anything remains PaymentAllocation.allocatedAmount on a
-- RECORDED Payment. Each table below either PRECEDES a Payment (a destination,
-- a preparation, an execution request) or OBSERVES one (an external
-- transaction) — and every path that ends in money having moved converges on the
-- one canonical Payment, linked, never duplicated:
--
--   PaymentPreparation.paymentId   UNIQUE — one preparation, at most one Payment
--   OutboundExecution.paymentId    UNIQUE — one execution, at most one Payment
--   PaymentEvidence.externalTransactionId  UNIQUE while active — one bank line
--                                  evidences at most one Payment at a time
--
-- ── 1. PaymentDestination — money goes TO (Phase 4) ─────────────────────────
--
-- Same storage contract as BusinessBankAccount (Phase 3, programme §11): AES-256-
-- GCM ciphertext + IV + tag + key id, the last four digits, and a KEYED HMAC
-- fingerprint. No plaintext coordinate column exists. The two tables share a
-- crypto helper under different PURPOSES and are never merged (§11.8).
--
-- Uniqueness is per PAYEE (§11.5): two payees of one business may legitimately
-- share an account (parent / subsidiary), so the key is (business, payee,
-- fingerprint), with a separate non-unique index for matching by coordinate.
--
-- Provenance is two orthogonal fields (§11.7). Typing an account number is an
-- ORIGIN, never a verification — so a CHECK pins verification to NONE. No UI may
-- say "מאומת" while it is, and relaxing this CHECK is a deliberate future
-- migration, not an application flag.
--
-- ── 2. PaymentPreparation — "הכן תשלום" (Phase 4) ───────────────────────────
--
-- A prepared payment is an INTENTION: amount, payee, source, destination,
-- reference, and the obligation it serves. Preparing, approving or cancelling it
-- moves no money and settles nothing. When money has actually moved — reported
-- by the owner, settled by a provider, or observed at the bank — it becomes ONE
-- canonical Payment and `paymentId` records which.
--
-- Approval FREEZES what will be paid: the approved amount, the destination's and
-- source's fingerprints, and a hash over the whole snapshot. An execution must
-- carry the same snapshot, so a destination swapped after approval is refused
-- rather than silently paid.
--
-- ── 3. ExternalTransaction — what the bank / a provider reported (Phase 5) ───
--
-- An observation, never a payment. Idempotent by (business, source, externalId);
-- its facts are IMMUTABLE after insert (trigger), because a re-delivered or
-- re-uploaded line must be recognised as the same line, not quietly edited.
-- Reconciliation attaches it to an existing Payment as PaymentEvidence
-- (kind BANK_TRANSACTION), exactly as a receipt attaches in Phase 2.
--
-- ── 4. OutboundExecution — asking a provider to move money (Phase 6) ─────────
--
-- Provider-independent. No outbound provider is connected today, and nothing here
-- implies one is. Idempotent by (business, idempotencyKey); one LIVE attempt per
-- preparation; one SETTLED attempt per preparation. Acceptance is not settlement:
-- only SETTLED may carry a Payment.

-- ── enums ────────────────────────────────────────────────────────────────────

CREATE TYPE "PaymentDestinationKind" AS ENUM ('IL_BANK_ACCOUNT');
CREATE TYPE "PaymentDestinationOrigin" AS ENUM ('OWNER_ENTERED', 'DOCUMENT_DERIVED', 'PROVIDER_SUPPLIED');
CREATE TYPE "PaymentDestinationVerification" AS ENUM ('NONE', 'MICRO_DEPOSIT', 'PROVIDER_CONFIRMED', 'BANK_CONFIRMED');
CREATE TYPE "PaymentPreparationStatus" AS ENUM ('PREPARED', 'APPROVED', 'SUBMITTED', 'COMPLETED', 'FAILED', 'CANCELLED');
CREATE TYPE "PaymentCompletionSource" AS ENUM ('OWNER_REPORTED', 'PROVIDER_SETTLED', 'BANK_OBSERVED');
CREATE TYPE "ExternalTransactionSource" AS ENUM ('OWNER_ENTRY', 'OWNER_UPLOAD', 'BANK_FEED', 'PROVIDER');
CREATE TYPE "ExternalTransactionDirection" AS ENUM ('DEBIT', 'CREDIT');
CREATE TYPE "OutboundExecutionStatus" AS ENUM ('REQUESTED', 'SUBMITTED', 'ACKNOWLEDGED', 'SETTLED', 'FAILED', 'CANCELLED');

-- ── 1. PaymentDestination ────────────────────────────────────────────────────

CREATE TABLE "PaymentDestination" (
  "id"                    SERIAL                           NOT NULL,
  "businessId"            INTEGER                          NOT NULL,
  "payeeId"               INTEGER                          NOT NULL,
  "kind"                  "PaymentDestinationKind"         NOT NULL DEFAULT 'IL_BANK_ACCOUNT',
  "label"                 TEXT                             NOT NULL,
  -- The name the bank transfer is made out to (שם המוטב).
  "beneficiaryName"       TEXT                             NOT NULL,

  "coordinatesEncrypted"  TEXT                             NOT NULL,
  "coordinatesIv"         TEXT                             NOT NULL,
  "coordinatesTag"        TEXT                             NOT NULL,
  "encryptionKeyId"       TEXT                             NOT NULL,
  "accountLast4"          TEXT                             NOT NULL,
  "fingerprint"           TEXT                             NOT NULL,

  "origin"                "PaymentDestinationOrigin"       NOT NULL DEFAULT 'OWNER_ENTERED',
  "verification"          "PaymentDestinationVerification" NOT NULL DEFAULT 'NONE',

  "isActive"              BOOLEAN                          NOT NULL DEFAULT true,
  "isDefault"             BOOLEAN                          NOT NULL DEFAULT false,
  -- Replacement is a LINK: the new destination names the one it replaces.
  "replacesDestinationId" INTEGER,
  "note"                  TEXT,
  "createdByUserId"       INTEGER,
  "createdAt"             TIMESTAMP(3)                     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3)                     NOT NULL,

  CONSTRAINT "PaymentDestination_pkey" PRIMARY KEY ("id"),
  -- Nothing verifies a destination yet. Claiming otherwise must be a migration.
  CONSTRAINT "PaymentDestination_verification_none_check" CHECK ("verification" = 'NONE')
);

ALTER TABLE "PaymentDestination"
  ADD CONSTRAINT "PaymentDestination_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentDestination"
  ADD CONSTRAINT "PaymentDestination_payeeId_fkey"
  FOREIGN KEY ("payeeId") REFERENCES "Payee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentDestination"
  ADD CONSTRAINT "PaymentDestination_replacesDestinationId_fkey"
  FOREIGN KEY ("replacesDestinationId") REFERENCES "PaymentDestination"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "PaymentDestination_businessId_payeeId_fingerprint_key"
  ON "PaymentDestination"("businessId", "payeeId", "fingerprint");
CREATE INDEX "PaymentDestination_businessId_fingerprint_idx"
  ON "PaymentDestination"("businessId", "fingerprint");
CREATE INDEX "PaymentDestination_businessId_payeeId_isActive_idx"
  ON "PaymentDestination"("businessId", "payeeId", "isActive");
-- At most one active default per PAYEE.
CREATE UNIQUE INDEX "PaymentDestination_one_active_default"
  ON "PaymentDestination"("businessId", "payeeId")
  WHERE "isDefault" = true AND "isActive" = true;
-- A replacement chain cannot fork.
CREATE UNIQUE INDEX "PaymentDestination_replaces_key"
  ON "PaymentDestination"("replacesDestinationId")
  WHERE "replacesDestinationId" IS NOT NULL;

-- ── 2. PaymentPreparation ────────────────────────────────────────────────────

CREATE TABLE "PaymentPreparation" (
  "id"                           SERIAL                     NOT NULL,
  "businessId"                   INTEGER                    NOT NULL,
  "commitmentId"                 INTEGER                    NOT NULL,
  "installmentId"                INTEGER,
  "payeeId"                      INTEGER,
  "payeeNameSnapshot"            TEXT                       NOT NULL,
  "amount"                       DECIMAL(18,2)              NOT NULL,
  "currency"                     TEXT                       NOT NULL DEFAULT 'ILS',
  "method"                       "PaymentMethod"            NOT NULL,
  "sourceBankAccountId"          INTEGER,
  "destinationId"                INTEGER,
  "reference"                    TEXT,
  "note"                         TEXT,
  "status"                       "PaymentPreparationStatus" NOT NULL DEFAULT 'PREPARED',

  -- The frozen snapshot. Set once, at approval.
  "approvedAt"                   TIMESTAMP(3),
  "approvedByUserId"             INTEGER,
  "approvalHash"                 TEXT,
  "frozenDestinationFingerprint" TEXT,
  "frozenSourceFingerprint"      TEXT,

  "cancelledAt"                  TIMESTAMP(3),
  "cancelledByUserId"            INTEGER,
  "cancellationReason"           TEXT,

  "completedAt"                  TIMESTAMP(3),
  "completionSource"             "PaymentCompletionSource",
  "paymentId"                    INTEGER,

  "createdByUserId"              INTEGER,
  "createdAt"                    TIMESTAMP(3)               NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                    TIMESTAMP(3)               NOT NULL,

  CONSTRAINT "PaymentPreparation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentPreparation_amount_positive_check" CHECK ("amount" > 0),
  -- Anything past PREPARED (other than a cancellation of an unapproved one)
  -- carries the frozen approval.
  CONSTRAINT "PaymentPreparation_approved_snapshot_check" CHECK (
    "status" IN ('PREPARED', 'CANCELLED')
    OR ("approvedAt" IS NOT NULL AND "approvalHash" IS NOT NULL)
  ),
  -- COMPLETED means money moved, which means a canonical Payment exists.
  CONSTRAINT "PaymentPreparation_completed_payment_check" CHECK (
    "status" <> 'COMPLETED'
    OR ("paymentId" IS NOT NULL AND "completedAt" IS NOT NULL AND "completionSource" IS NOT NULL)
  )
);

ALTER TABLE "PaymentPreparation"
  ADD CONSTRAINT "PaymentPreparation_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentPreparation"
  ADD CONSTRAINT "PaymentPreparation_commitmentId_fkey"
  FOREIGN KEY ("commitmentId") REFERENCES "Commitment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentPreparation"
  ADD CONSTRAINT "PaymentPreparation_installmentId_fkey"
  FOREIGN KEY ("installmentId") REFERENCES "Installment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PaymentPreparation"
  ADD CONSTRAINT "PaymentPreparation_payeeId_fkey"
  FOREIGN KEY ("payeeId") REFERENCES "Payee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PaymentPreparation"
  ADD CONSTRAINT "PaymentPreparation_sourceBankAccountId_fkey"
  FOREIGN KEY ("sourceBankAccountId") REFERENCES "BusinessBankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentPreparation"
  ADD CONSTRAINT "PaymentPreparation_destinationId_fkey"
  FOREIGN KEY ("destinationId") REFERENCES "PaymentDestination"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentPreparation"
  ADD CONSTRAINT "PaymentPreparation_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "PaymentPreparation_businessId_status_idx"
  ON "PaymentPreparation"("businessId", "status");
CREATE INDEX "PaymentPreparation_businessId_commitmentId_idx"
  ON "PaymentPreparation"("businessId", "commitmentId");
CREATE INDEX "PaymentPreparation_businessId_installmentId_idx"
  ON "PaymentPreparation"("businessId", "installmentId");
-- One preparation produces at most one Payment, and one Payment completes at
-- most one preparation.
CREATE UNIQUE INDEX "PaymentPreparation_paymentId_key"
  ON "PaymentPreparation"("paymentId")
  WHERE "paymentId" IS NOT NULL;

-- ── 3. ExternalTransaction ───────────────────────────────────────────────────

CREATE TABLE "ExternalTransaction" (
  "id"                  SERIAL                         NOT NULL,
  "businessId"          INTEGER                        NOT NULL,
  "source"              "ExternalTransactionSource"    NOT NULL,
  -- The identity the source gave the line, or a deterministic digest of its
  -- facts when the source gives none (an uploaded statement). Never random.
  "externalId"          TEXT                           NOT NULL,
  "sourceBankAccountId" INTEGER,
  "direction"           "ExternalTransactionDirection" NOT NULL,
  "amount"              DECIMAL(18,2)                  NOT NULL,
  "currency"            TEXT                           NOT NULL DEFAULT 'ILS',
  "bookedAt"            TIMESTAMP(3)                   NOT NULL,
  "valueDate"           TIMESTAMP(3),
  "counterpartyName"    TEXT,
  "reference"           TEXT,
  "description"         TEXT,
  "importBatchId"       TEXT,

  -- The owner's decision that this line is not a payable (a salary, a fee).
  -- Recorded, never deleted.
  "dismissedAt"         TIMESTAMP(3),
  "dismissedByUserId"   INTEGER,
  "dismissReason"       TEXT,

  "createdByUserId"     INTEGER,
  "createdAt"           TIMESTAMP(3)                   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3)                   NOT NULL,

  CONSTRAINT "ExternalTransaction_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ExternalTransaction_amount_positive_check" CHECK ("amount" > 0)
);

ALTER TABLE "ExternalTransaction"
  ADD CONSTRAINT "ExternalTransaction_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExternalTransaction"
  ADD CONSTRAINT "ExternalTransaction_sourceBankAccountId_fkey"
  FOREIGN KEY ("sourceBankAccountId") REFERENCES "BusinessBankAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Idempotent ingestion: the same line from the same source is ONE row.
CREATE UNIQUE INDEX "ExternalTransaction_businessId_source_externalId_key"
  ON "ExternalTransaction"("businessId", "source", "externalId");
CREATE INDEX "ExternalTransaction_businessId_bookedAt_idx"
  ON "ExternalTransaction"("businessId", "bookedAt");
CREATE INDEX "ExternalTransaction_businessId_amount_idx"
  ON "ExternalTransaction"("businessId", "amount");

-- The observed facts cannot be edited after insert. Only the owner's dismissal
-- (and updatedAt) may change.
CREATE OR REPLACE FUNCTION payables_external_transaction_facts_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."businessId"          IS DISTINCT FROM OLD."businessId"
  OR NEW."source"              IS DISTINCT FROM OLD."source"
  OR NEW."externalId"          IS DISTINCT FROM OLD."externalId"
  OR NEW."sourceBankAccountId" IS DISTINCT FROM OLD."sourceBankAccountId"
  OR NEW."direction"           IS DISTINCT FROM OLD."direction"
  OR NEW."amount"              IS DISTINCT FROM OLD."amount"
  OR NEW."currency"            IS DISTINCT FROM OLD."currency"
  OR NEW."bookedAt"            IS DISTINCT FROM OLD."bookedAt"
  OR NEW."valueDate"           IS DISTINCT FROM OLD."valueDate"
  OR NEW."counterpartyName"    IS DISTINCT FROM OLD."counterpartyName"
  OR NEW."reference"           IS DISTINCT FROM OLD."reference"
  OR NEW."description"         IS DISTINCT FROM OLD."description"
  OR NEW."importBatchId"       IS DISTINCT FROM OLD."importBatchId"
  OR NEW."createdAt"           IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'ExternalTransaction facts are immutable (id %)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ExternalTransaction_facts_immutable"
  BEFORE UPDATE ON "ExternalTransaction"
  FOR EACH ROW EXECUTE FUNCTION payables_external_transaction_facts_immutable();

-- ── 3b. PaymentEvidence gains the bank line it may point at ──────────────────

ALTER TABLE "PaymentEvidence" ADD COLUMN "externalTransactionId" INTEGER;
ALTER TABLE "PaymentEvidence"
  ADD CONSTRAINT "PaymentEvidence_externalTransactionId_fkey"
  FOREIGN KEY ("externalTransactionId") REFERENCES "ExternalTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- The double-count guard for bank lines, same shape as the Phase 2 document
-- guard: one line evidences at most one Payment at a time; revocation frees it.
CREATE UNIQUE INDEX "PaymentEvidence_active_external_transaction_key"
  ON "PaymentEvidence"("businessId", "externalTransactionId")
  WHERE "revokedAt" IS NULL AND "externalTransactionId" IS NOT NULL;
CREATE INDEX "PaymentEvidence_businessId_externalTransactionId_idx"
  ON "PaymentEvidence"("businessId", "externalTransactionId");

-- ── 3c. ExternalTransactionMatchRejection ────────────────────────────────────

CREATE TABLE "ExternalTransactionMatchRejection" (
  "id"                    SERIAL       NOT NULL,
  "businessId"            INTEGER      NOT NULL,
  "externalTransactionId" INTEGER      NOT NULL,
  "paymentId"             INTEGER,
  "installmentId"         INTEGER,
  "reason"                TEXT,
  "rejectedByUserId"      INTEGER,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExternalTransactionMatchRejection_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ExternalTransactionMatchRejection"
  ADD CONSTRAINT "ExternalTransactionMatchRejection_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExternalTransactionMatchRejection"
  ADD CONSTRAINT "ExternalTransactionMatchRejection_externalTransactionId_fkey"
  FOREIGN KEY ("externalTransactionId") REFERENCES "ExternalTransaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExternalTransactionMatchRejection"
  ADD CONSTRAINT "ExternalTransactionMatchRejection_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExternalTransactionMatchRejection"
  ADD CONSTRAINT "ExternalTransactionMatchRejection_installmentId_fkey"
  FOREIGN KEY ("installmentId") REFERENCES "Installment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "ExternalTransactionMatchRejection_pair_key"
  ON "ExternalTransactionMatchRejection"(
    "businessId", "externalTransactionId", COALESCE("paymentId", 0), COALESCE("installmentId", 0)
  );
CREATE INDEX "ExternalTransactionMatchRejection_businessId_externalTransactionId_idx"
  ON "ExternalTransactionMatchRejection"("businessId", "externalTransactionId");

-- ── 4. OutboundExecution ─────────────────────────────────────────────────────

CREATE TABLE "OutboundExecution" (
  "id"                     SERIAL                    NOT NULL,
  "businessId"             INTEGER                   NOT NULL,
  "preparationId"          INTEGER                   NOT NULL,
  -- Which adapter. Text, not an enum: no outbound provider exists yet, and one
  -- arriving must not need a migration merely to be named.
  "provider"               TEXT                      NOT NULL,
  "idempotencyKey"         TEXT                      NOT NULL,
  "status"                 "OutboundExecutionStatus" NOT NULL DEFAULT 'REQUESTED',

  -- The frozen request. Must equal the preparation's approval snapshot.
  "amount"                 DECIMAL(18,2)             NOT NULL,
  "currency"               TEXT                      NOT NULL DEFAULT 'ILS',
  "sourceFingerprint"      TEXT,
  "destinationFingerprint" TEXT                      NOT NULL,
  "approvalHash"           TEXT                      NOT NULL,

  "providerReference"      TEXT,
  "providerStatusCode"     TEXT,
  "failureCode"            TEXT,
  "failureMessage"         TEXT,

  "requestedByUserId"      INTEGER,
  "requestedAt"            TIMESTAMP(3)              NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "submittedAt"            TIMESTAMP(3),
  "acknowledgedAt"         TIMESTAMP(3),
  "settledAt"              TIMESTAMP(3),
  "failedAt"               TIMESTAMP(3),
  "cancelledAt"            TIMESTAMP(3),
  "paymentId"              INTEGER,

  "createdAt"              TIMESTAMP(3)              NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"              TIMESTAMP(3)              NOT NULL,

  CONSTRAINT "OutboundExecution_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OutboundExecution_amount_positive_check" CHECK ("amount" > 0),
  -- Acceptance is not settlement: only a SETTLED execution may carry a Payment,
  -- and a SETTLED one must.
  CONSTRAINT "OutboundExecution_payment_only_when_settled_check" CHECK (
    ("status" = 'SETTLED' AND "paymentId" IS NOT NULL AND "settledAt" IS NOT NULL)
    OR ("status" <> 'SETTLED' AND "paymentId" IS NULL)
  )
);

ALTER TABLE "OutboundExecution"
  ADD CONSTRAINT "OutboundExecution_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OutboundExecution"
  ADD CONSTRAINT "OutboundExecution_preparationId_fkey"
  FOREIGN KEY ("preparationId") REFERENCES "PaymentPreparation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OutboundExecution"
  ADD CONSTRAINT "OutboundExecution_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A browser, server or provider retry of the same request is ONE row.
CREATE UNIQUE INDEX "OutboundExecution_businessId_idempotencyKey_key"
  ON "OutboundExecution"("businessId", "idempotencyKey");
-- A provider reference names one attempt.
CREATE UNIQUE INDEX "OutboundExecution_provider_reference_key"
  ON "OutboundExecution"("businessId", "provider", "providerReference")
  WHERE "providerReference" IS NOT NULL;
-- At most one attempt in flight per preparation…
CREATE UNIQUE INDEX "OutboundExecution_one_live_per_preparation"
  ON "OutboundExecution"("preparationId")
  WHERE "status" IN ('REQUESTED', 'SUBMITTED', 'ACKNOWLEDGED');
-- …and at most one that settled.
CREATE UNIQUE INDEX "OutboundExecution_one_settled_per_preparation"
  ON "OutboundExecution"("preparationId")
  WHERE "status" = 'SETTLED';
CREATE UNIQUE INDEX "OutboundExecution_paymentId_key"
  ON "OutboundExecution"("paymentId")
  WHERE "paymentId" IS NOT NULL;
CREATE INDEX "OutboundExecution_businessId_status_idx"
  ON "OutboundExecution"("businessId", "status");

-- ── 5. Tenant RLS — the same fail-closed predicate as every payables table ───

ALTER TABLE "PaymentDestination" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentDestination" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payables_p46_tenant ON "PaymentDestination";
CREATE POLICY payables_p46_tenant ON "PaymentDestination"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "PaymentPreparation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentPreparation" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payables_p46_tenant ON "PaymentPreparation";
CREATE POLICY payables_p46_tenant ON "PaymentPreparation"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "ExternalTransaction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExternalTransaction" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payables_p46_tenant ON "ExternalTransaction";
CREATE POLICY payables_p46_tenant ON "ExternalTransaction"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "ExternalTransactionMatchRejection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExternalTransactionMatchRejection" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payables_p46_tenant ON "ExternalTransactionMatchRejection";
CREATE POLICY payables_p46_tenant ON "ExternalTransactionMatchRejection"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "OutboundExecution" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OutboundExecution" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payables_p46_tenant ON "OutboundExecution";
CREATE POLICY payables_p46_tenant ON "OutboundExecution"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
