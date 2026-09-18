-- Accounts Payable Phase 2 — document evidence and match decisions.
--
-- EXPAND-ONLY. Nothing is dropped, renamed, repurposed or emptied.
--
-- ── What this exists to make possible ───────────────────────────────────────
--
-- A receipt is EVIDENCE that a payment happened. It is not itself a second
-- payment. Phase 1a already shipped `PaymentEvidence` with a DOCUMENT kind, but
-- with no way to say WHICH document — so "is this document already attached to
-- a payment?" had no answer, and the double-count invariant was unenforceable
-- in the only place that can actually enforce it: the database.
--
-- ── The double-count guard ──────────────────────────────────────────────────
--
-- The partial unique index below is the whole point. One document may evidence
-- AT MOST ONE payment at a time. It is partial on `revokedAt IS NULL` for the
-- same reason the allocation index is partial on `reversedAt IS NULL`: a plain
-- unique constraint would forbid ever re-attaching a document after a
-- legitimate, audited revocation, which would make reconciliation a one-way
-- door.
--
-- ── What is deliberately NOT stored ─────────────────────────────────────────
--
-- Match CANDIDATES are not a table. They are derived at read time from facts
-- that already exist (amount, date, vendorName, direction) exactly as balances
-- are derived from allocations. A stored candidate is a second source of truth
-- that goes stale the moment a payment or an instalment changes, and it would
-- start competing with the ledger for authority.
--
-- Only an owner DECISION is persisted: a confirmation becomes PaymentEvidence,
-- and a rejection becomes a row below so a dismissed suggestion does not come
-- back to nag. Nothing here scores anything; scoring lives in code and is
-- recomputed from current facts every time.

-- ── 1. PaymentEvidence learns which document, and how to be undone ─────────

ALTER TABLE "PaymentEvidence" ADD COLUMN "documentId" INTEGER;
ALTER TABLE "PaymentEvidence" ADD COLUMN "financialRecordId" INTEGER;

-- Reversibility, recorded rather than deleted — the same contract as an
-- allocation reversal. A revoked row keeps its history and stops counting.
ALTER TABLE "PaymentEvidence" ADD COLUMN "revokedAt" TIMESTAMP(3);
ALTER TABLE "PaymentEvidence" ADD COLUMN "revokedByUserId" INTEGER;
ALTER TABLE "PaymentEvidence" ADD COLUMN "revocationReason" TEXT;

-- The evidence must not outlive the document it points at, and a document
-- belongs to exactly one tenant, so the FK is safe and deliberate.
ALTER TABLE "PaymentEvidence"
  ADD CONSTRAINT "PaymentEvidence_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- THE double-count guard. Unique only across ACTIVE document evidence.
CREATE UNIQUE INDEX "PaymentEvidence_active_document_key"
  ON "PaymentEvidence"("businessId", "documentId")
  WHERE "revokedAt" IS NULL AND "documentId" IS NOT NULL;

CREATE INDEX "PaymentEvidence_businessId_documentId_idx"
  ON "PaymentEvidence"("businessId", "documentId");

-- ── 2. A rejected suggestion stays rejected ────────────────────────────────

CREATE TABLE "PayablesMatchRejection" (
  "id"              SERIAL       NOT NULL,
  "businessId"      INTEGER      NOT NULL,
  "documentId"      INTEGER      NOT NULL,
  -- The thing the owner said NO to. A rejection is scoped to a specific
  -- pairing: saying "this receipt is not for the electricity bill" must not suppress a
  -- correct suggestion against a different commitment.
  "commitmentId"    INTEGER,
  "installmentId"   INTEGER,
  "paymentId"       INTEGER,
  "reason"          TEXT,
  "rejectedByUserId" INTEGER,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PayablesMatchRejection_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PayablesMatchRejection"
  ADD CONSTRAINT "PayablesMatchRejection_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PayablesMatchRejection"
  ADD CONSTRAINT "PayablesMatchRejection_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PayablesMatchRejection"
  ADD CONSTRAINT "PayablesMatchRejection_commitmentId_fkey"
  FOREIGN KEY ("commitmentId") REFERENCES "Commitment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PayablesMatchRejection"
  ADD CONSTRAINT "PayablesMatchRejection_installmentId_fkey"
  FOREIGN KEY ("installmentId") REFERENCES "Installment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PayablesMatchRejection"
  ADD CONSTRAINT "PayablesMatchRejection_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Re-rejecting the same pairing is a no-op rather than a duplicate row.
-- COALESCE keeps the key usable when the pairing names a commitment but no
-- instalment or payment, which is the common case.
CREATE UNIQUE INDEX "PayablesMatchRejection_pair_key"
  ON "PayablesMatchRejection"(
    "businessId", "documentId",
    COALESCE("commitmentId", 0), COALESCE("installmentId", 0), COALESCE("paymentId", 0)
  );

CREATE INDEX "PayablesMatchRejection_businessId_documentId_idx"
  ON "PayablesMatchRejection"("businessId", "documentId");

-- ── 3. Tenant RLS — same fail-closed predicate as every Phase 1a table ─────

ALTER TABLE "PayablesMatchRejection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PayablesMatchRejection" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payables_p2_tenant ON "PayablesMatchRejection";
CREATE POLICY payables_p2_tenant ON "PayablesMatchRejection"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
