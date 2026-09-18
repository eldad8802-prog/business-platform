-- Accounts Payable Phase 3 — cheques and the accounts money leaves FROM.
--
-- EXPAND-ONLY. Nothing is dropped, renamed, repurposed or emptied.
--
-- ── Bank coordinates are never stored in the clear ──────────────────────────
--
-- `BusinessBankAccount` keeps the three-column AES-256-GCM pattern already
-- proven for payment-provider credentials and authority tokens: ciphertext, IV
-- and auth tag, plus `encryptionKeyId` so a future rotation can tell rows
-- apart. The AAD binds each row to its tenant and purpose, so a row lifted into
-- another business fails to decrypt rather than yielding someone else's number.
--
-- Two columns are deliberately NOT encrypted, and each earns it:
--
--   accountLast4   four digits. It is what a list shows, and it is what a list
--                  HAS — the full number never reaches a list query at all, so
--                  a client that ignores the mask still cannot reveal anything.
--
--   fingerprint    a KEYED HMAC-SHA-256, not a hash. An Israeli account is a
--                  2-digit bank, a 3-digit branch and a number usually under 9
--                  digits; a plain SHA-256 column over that input space is
--                  brute-forceable on a laptop, so it would BE the account
--                  numbers. Keyed, the column is inert without a secret that
--                  lives outside the database.
--
--                  Its input begins with the businessId, so two businesses
--                  banking at the same account produce DIFFERENT fingerprints.
--                  The column therefore cannot correlate tenants — "who else
--                  pays this supplier" is not a question this schema should be
--                  able to answer — and uniqueness over it is naturally
--                  per-tenant.
--
-- ── Cheques ────────────────────────────────────────────────────────────────
--
-- `chequeNumber` is TEXT and nothing here assumes it is sequential, numeric, or
-- densely allocated. Israeli chequebooks are issued in blocks, a replacement
-- comes from wherever the book is now, and inferring "the next cheque" from
-- arithmetic would invent facts about paper the business is holding.
--
-- CLEARED is owner-asserted and says so in the column name. There is no bank
-- feed in this phase, so `clearedSource` has exactly one legal value today,
-- OWNER_ASSERTED, and the enum exists so that a future verified source is a new
-- value rather than a silent reinterpretation of the old rows.

CREATE TYPE "ChequeStatus" AS ENUM (
  'PLANNED',
  'ISSUED',
  'DELIVERED',
  'PRESENTED',
  'CLEARED',
  'BOUNCED',
  'CANCELLED',
  'REPLACED'
);

CREATE TYPE "ChequeClearedSource" AS ENUM ('OWNER_ASSERTED');

-- ── 1. The account money leaves FROM ───────────────────────────────────────

CREATE TABLE "BusinessBankAccount" (
  "id"                   SERIAL       NOT NULL,
  "businessId"           INTEGER      NOT NULL,
  "label"                TEXT         NOT NULL,

  "coordinatesEncrypted" TEXT         NOT NULL,
  "coordinatesIv"        TEXT         NOT NULL,
  "coordinatesTag"       TEXT         NOT NULL,
  "encryptionKeyId"      TEXT         NOT NULL,

  "accountLast4"         TEXT         NOT NULL,
  "fingerprint"          TEXT         NOT NULL,

  "isActive"             BOOLEAN      NOT NULL DEFAULT true,
  "isDefault"            BOOLEAN      NOT NULL DEFAULT false,
  "note"                 TEXT,
  "createdByUserId"      INTEGER,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BusinessBankAccount_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "BusinessBankAccount"
  ADD CONSTRAINT "BusinessBankAccount_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The same account entered twice is one account. Tenant-scoped by construction
-- because the fingerprint input already begins with the businessId; the pair is
-- kept explicit so the intent survives a reader who does not know that.
CREATE UNIQUE INDEX "BusinessBankAccount_businessId_fingerprint_key"
  ON "BusinessBankAccount"("businessId", "fingerprint");

-- At most ONE default per business, and only among active accounts — an
-- archived account must not keep the default slot occupied.
CREATE UNIQUE INDEX "BusinessBankAccount_one_active_default"
  ON "BusinessBankAccount"("businessId")
  WHERE "isDefault" = true AND "isActive" = true;

CREATE INDEX "BusinessBankAccount_businessId_isActive_idx"
  ON "BusinessBankAccount"("businessId", "isActive");

-- ── 2. Cheques ─────────────────────────────────────────────────────────────

CREATE TABLE "Cheque" (
  "id"                  SERIAL              NOT NULL,
  "businessId"          INTEGER             NOT NULL,

  "payeeId"             INTEGER,
  "payeeNameSnapshot"   TEXT                NOT NULL,

  "amount"              DECIMAL(18,2)       NOT NULL,
  "currency"            TEXT                NOT NULL DEFAULT 'ILS',

  -- TEXT, and never assumed sequential. See the header.
  "chequeNumber"        TEXT                NOT NULL,
  "issueDate"           TIMESTAMP(3)        NOT NULL,
  "dueDate"             TIMESTAMP(3)        NOT NULL,

  "sourceBankAccountId" INTEGER             NOT NULL,
  -- The instalment this cheque is meant to settle, when it is written against
  -- a plan. Nullable: a cheque may be written before anyone decides which
  -- instalment it covers.
  "installmentId"       INTEGER,
  "commitmentId"        INTEGER,

  "status"              "ChequeStatus"      NOT NULL DEFAULT 'PLANNED',

  -- Owner-asserted clearing, named so it can never be mistaken for a bank
  -- confirmation the product does not have.
  "clearedAssertedAt"   TIMESTAMP(3),
  "clearedSource"       "ChequeClearedSource",
  "clearedAssertedBy"   INTEGER,

  "cancelledAt"         TIMESTAMP(3),
  "cancellationReason"  TEXT,

  -- Replacement is a LINK, not an edit. Cancelling #500105 and issuing #500220
  -- leaves both rows, and the chain says which replaced which.
  "replacesChequeId"    INTEGER,

  "note"                TEXT,
  "createdByUserId"     INTEGER,
  "createdAt"           TIMESTAMP(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3)        NOT NULL,

  CONSTRAINT "Cheque_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Cheque"
  ADD CONSTRAINT "Cheque_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Cheque"
  ADD CONSTRAINT "Cheque_payeeId_fkey"
  FOREIGN KEY ("payeeId") REFERENCES "Payee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Cheque"
  ADD CONSTRAINT "Cheque_sourceBankAccountId_fkey"
  FOREIGN KEY ("sourceBankAccountId") REFERENCES "BusinessBankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Cheque"
  ADD CONSTRAINT "Cheque_installmentId_fkey"
  FOREIGN KEY ("installmentId") REFERENCES "Installment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Cheque"
  ADD CONSTRAINT "Cheque_commitmentId_fkey"
  FOREIGN KEY ("commitmentId") REFERENCES "Commitment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Cheque"
  ADD CONSTRAINT "Cheque_replacesChequeId_fkey"
  FOREIGN KEY ("replacesChequeId") REFERENCES "Cheque"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One live cheque per number per chequebook. PARTIAL on not-cancelled, for the
-- same reason every other guard here is partial: a bank that reissues a
-- cancelled number must not be impossible to record.
CREATE UNIQUE INDEX "Cheque_active_number_key"
  ON "Cheque"("businessId", "sourceBankAccountId", "chequeNumber")
  WHERE "cancelledAt" IS NULL;

-- A replacement replaces exactly one cheque, so the chain cannot fork into two
-- successors claiming the same predecessor.
CREATE UNIQUE INDEX "Cheque_replaces_key"
  ON "Cheque"("replacesChequeId")
  WHERE "replacesChequeId" IS NOT NULL;

CREATE INDEX "Cheque_businessId_dueDate_idx"    ON "Cheque"("businessId", "dueDate");
CREATE INDEX "Cheque_businessId_status_idx"     ON "Cheque"("businessId", "status");
CREATE INDEX "Cheque_businessId_installment_idx" ON "Cheque"("businessId", "installmentId");

-- ── 3. Tenant RLS — the same fail-closed predicate as every payables table ──

ALTER TABLE "BusinessBankAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessBankAccount" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payables_p3_tenant ON "BusinessBankAccount";
CREATE POLICY payables_p3_tenant ON "BusinessBankAccount"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "Cheque" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Cheque" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payables_p3_tenant ON "Cheque";
CREATE POLICY payables_p3_tenant ON "Cheque"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
