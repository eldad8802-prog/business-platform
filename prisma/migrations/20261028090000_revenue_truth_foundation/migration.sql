-- Revenue truth — data foundation (milestone A, migration only)
--
-- WHY
--   Dubiz has four places that each count as "income" today (BillingDocument, PaymentTransaction,
--   FinancialRecord, FinancialEvent — the last already books an invoice AND its payment as two INCOME rows,
--   harmless only because nothing reads it). POS sales, Z reports, card settlements and bank deposits are
--   about to arrive. Each of them describes the SAME money at a different stage, so each is stored here as
--   evidence of one layer, never as a new income event:
--
--     1. sale        "RevenueSale"                 a sale / refund / void from a register or an accounting app
--                    "RevenueDailyClose" (+ tender, + VAT lines)   the Z report that closes a register day
--     2. receipt     "RevenueReceipt"              money taken (or paid back) at the till, by method
--     3. settlement  "RevenueSettlement"           an acquirer / provider credit: gross, fee, net, installment
--     4. deposit     "ExternalTransaction"         EXISTING bank lines (CREDIT) — reused, not copied, not changed
--
--   "RevenueLink" connects layers (sale = Dubiz document, tender → settlement, settlement → deposit, cash →
--   deposit) as a PROPOSAL; "RevenueDecision" is the append-only journal of the owner's / system's
--   confirm / reject / revoke on a link, or on a Z report read from a photo. Revenue is recognised at the sale
--   layer only, from one authoritative source per register day (lib/revenue-truth, application PR); a settlement or
--   a deposit can only CLOSE what a sale already opened.
--
-- WHAT IT DOES NOT DO
--   No existing table, column, index, policy, trigger or grant is changed. FinancialEvent, FinancialRecord,
--   BillingDocument, PaymentTransaction and ExternalTransaction keep their behaviour; nothing reads or writes
--   the new tables until a separately approved consumer exists. No flag row, no data, no backfill.
--
-- MONEY
--   Integer minor units (BIGINT, agorot / cents) — never Float, never a decimal that is summed in JS. Every row
--   carries its currency, limited to the platform's supported set (lib/money/currency.ts: ILS, USD, EUR — all
--   exponent 2). Amounts are stored as the source reported them; the layer's arithmetic is enforced by CHECK
--   (sale total = gross − discount; Z total = gross − discount − refunds − voids; settlement net = gross − fee
--   − other deductions). VAT is stored, not recomputed.
--
-- HISTORY
--   Every table is append-only for every role, the owner included (trigger; TRUNCATE refused). A correction is
--   a new row: a refund / void is a new sale row that names the original; a corrected Z is revision n+1 naming
--   the revision it supersedes; a changed mind on a link is a new decision. Deletion happens only as a cascade
--   of the business itself (or of a bank line it links to).
--
-- NO FREE TEXT
--   Every text column is a CHECK-limited token (ids, scopes, codes). No customer name, no description, no card
--   number field exists, so no personal data can be stored here by construction.
--
-- TENANCY
--   ENABLE + FORCE RLS, per-command SELECT / INSERT policies on app.current_business_id, no UPDATE / DELETE
--   policy. Cross-business references are refused by the database: composite (businessId, x) foreign keys for
--   every reference between the new tables and to "Document" / "AcquisitionConnection" (their tenant keys
--   exist); a trigger for "ExternalTransaction" and "BillingDocument", which have no (businessId, id) key —
--   adding one would change an existing table, which this milestone does not do.
--
-- PRIVILEGES
--   Production's migration role carries DEFAULT PRIVILEGES that hand app_runtime a,r,w,d on every new table.
--   Every privilege on the new tables and sequences, held by anyone but the owner, is revoked first; then
--   exactly SELECT, INSERT (and sequence USAGE, SELECT) is granted to app_runtime.
--
-- Additive only. A rollback (.rev/rollback.sql) removes every object this migration creates.

-- ── 1. Enums ─────────────────────────────────────────────────────────────────────────────────────

CREATE TYPE "RevenueSourceKind" AS ENUM ('POS', 'ACCOUNTING_APP', 'ACQUIRER', 'PAYMENT_PROVIDER', 'OWNER');
CREATE TYPE "RevenueCapture" AS ENUM ('API_PUSH', 'API_PULL', 'FILE_STRUCTURED', 'FILE_EXTRACTED', 'MANUAL');
CREATE TYPE "RevenueSaleKind" AS ENUM ('SALE', 'REFUND', 'VOID');
CREATE TYPE "RevenueTenderMethod" AS ENUM ('CASH', 'CARD', 'CHEQUE', 'BANK_TRANSFER', 'DIGITAL_WALLET', 'VOUCHER', 'OTHER');
CREATE TYPE "RevenueReceiptDirection" AS ENUM ('IN', 'OUT');
CREATE TYPE "RevenueVatCategory" AS ENUM ('STANDARD', 'ZERO_RATED', 'EXEMPT');
CREATE TYPE "RevenueValidation" AS ENUM ('PASSED', 'WARNINGS', 'FAILED');
CREATE TYPE "RevenueLinkKind" AS ENUM ('SALE_SAME_AS_DOCUMENT', 'TENDER_SETTLED_BY', 'SETTLEMENT_DEPOSITED_AS', 'CASH_DEPOSITED_AS');
CREATE TYPE "RevenueLinkBasis" AS ENUM ('SOURCE_REFERENCE', 'RULE_EXACT', 'RULE_TOLERANCE', 'OWNER_MANUAL');
CREATE TYPE "RevenueActor" AS ENUM ('OWNER_USER', 'SYSTEM');
CREATE TYPE "RevenueDecisionKind" AS ENUM ('CONFIRMED', 'REJECTED', 'REVOKED');

-- ── 2. RevenueSale — layer 1: a sale, refund or void as its source reported it ───────────────────

CREATE TABLE "RevenueSale" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "sourceKind" "RevenueSourceKind" NOT NULL,
  "capture" "RevenueCapture" NOT NULL,
  "sourceScope" TEXT NOT NULL,
  "connectionId" INTEGER,
  "externalId" TEXT NOT NULL,
  "kind" "RevenueSaleKind" NOT NULL,
  "originalSaleId" INTEGER,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "businessDay" DATE NOT NULL,
  "registerKey" TEXT,
  "currency" TEXT NOT NULL,
  "grossMinor" BIGINT NOT NULL,
  "discountMinor" BIGINT NOT NULL DEFAULT 0,
  "totalMinor" BIGINT NOT NULL,
  "vatMinor" BIGINT NOT NULL,
  "sourcePayloadHash" TEXT,
  "ingestRef" TEXT,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RevenueSale_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RevenueSale_tokens" CHECK (
        "sourceScope" ~ '^[a-z][a-z0-9_.:-]{0,79}$'
    AND "externalId" ~ '^[A-Za-z0-9:_.#/-]{1,200}$'
    AND ("registerKey" IS NULL OR "registerKey" ~ '^[A-Za-z0-9:_.-]{1,64}$')
    AND ("sourcePayloadHash" IS NULL OR "sourcePayloadHash" ~ '^[0-9a-f]{64}$')
    AND ("ingestRef" IS NULL OR "ingestRef" ~ '^[A-Za-z0-9:_.#/-]{1,200}$')
  ),
  CONSTRAINT "RevenueSale_currency" CHECK ("currency" IN ('ILS', 'USD', 'EUR')),
  CONSTRAINT "RevenueSale_amounts" CHECK (
        "grossMinor" >= 0 AND "discountMinor" >= 0 AND "discountMinor" <= "grossMinor"
    AND "totalMinor" = "grossMinor" - "discountMinor"
    AND "vatMinor" >= 0 AND "vatMinor" <= "totalMinor"
  ),
  -- A sale names no original; a refund / void may (a Z-level refund often cannot).
  CONSTRAINT "RevenueSale_original" CHECK ("kind" <> 'SALE' OR "originalSaleId" IS NULL)
);
CREATE UNIQUE INDEX "RevenueSale_businessId_id_key" ON "RevenueSale"("businessId", "id");
CREATE UNIQUE INDEX "RevenueSale_businessId_sourceScope_externalId_key" ON "RevenueSale"("businessId", "sourceScope", "externalId");
CREATE INDEX "RevenueSale_businessId_businessDay_idx" ON "RevenueSale"("businessId", "businessDay");
ALTER TABLE "RevenueSale" ADD CONSTRAINT "RevenueSale_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "RevenueSale" ADD CONSTRAINT "RevenueSale_connectionId_tenant_fkey"
  FOREIGN KEY ("connectionId", "businessId") REFERENCES "AcquisitionConnection"("id", "businessId")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "RevenueSale" ADD CONSTRAINT "RevenueSale_originalSaleId_tenant_fkey"
  FOREIGN KEY ("businessId", "originalSaleId") REFERENCES "RevenueSale"("businessId", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ── 3. RevenueReceipt — layer 2: money taken in (or paid back) at the till ───────────────────────

CREATE TABLE "RevenueReceipt" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "sourceKind" "RevenueSourceKind" NOT NULL,
  "capture" "RevenueCapture" NOT NULL,
  "sourceScope" TEXT NOT NULL,
  "connectionId" INTEGER,
  "externalId" TEXT NOT NULL,
  "saleId" INTEGER,
  "direction" "RevenueReceiptDirection" NOT NULL,
  "method" "RevenueTenderMethod" NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL,
  "businessDay" DATE NOT NULL,
  "registerKey" TEXT,
  "currency" TEXT NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "cardBrand" TEXT,
  "acquirer" TEXT,
  "installmentCount" SMALLINT,
  "sourcePayloadHash" TEXT,
  "ingestRef" TEXT,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RevenueReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RevenueReceipt_tokens" CHECK (
        "sourceScope" ~ '^[a-z][a-z0-9_.:-]{0,79}$'
    AND "externalId" ~ '^[A-Za-z0-9:_.#/-]{1,200}$'
    AND ("registerKey" IS NULL OR "registerKey" ~ '^[A-Za-z0-9:_.-]{1,64}$')
    AND ("cardBrand" IS NULL OR "cardBrand" ~ '^[a-z][a-z0-9_]{0,39}$')
    AND ("acquirer" IS NULL OR "acquirer" ~ '^[a-z][a-z0-9_]{0,39}$')
    AND ("sourcePayloadHash" IS NULL OR "sourcePayloadHash" ~ '^[0-9a-f]{64}$')
    AND ("ingestRef" IS NULL OR "ingestRef" ~ '^[A-Za-z0-9:_.#/-]{1,200}$')
  ),
  CONSTRAINT "RevenueReceipt_currency" CHECK ("currency" IN ('ILS', 'USD', 'EUR')),
  CONSTRAINT "RevenueReceipt_amounts" CHECK (
        "amountMinor" > 0
    AND ("installmentCount" IS NULL OR ("installmentCount" BETWEEN 1 AND 99 AND "method" = 'CARD'))
  )
);
CREATE UNIQUE INDEX "RevenueReceipt_businessId_id_key" ON "RevenueReceipt"("businessId", "id");
CREATE UNIQUE INDEX "RevenueReceipt_businessId_sourceScope_externalId_key" ON "RevenueReceipt"("businessId", "sourceScope", "externalId");
CREATE INDEX "RevenueReceipt_businessId_businessDay_idx" ON "RevenueReceipt"("businessId", "businessDay");
ALTER TABLE "RevenueReceipt" ADD CONSTRAINT "RevenueReceipt_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "RevenueReceipt" ADD CONSTRAINT "RevenueReceipt_connectionId_tenant_fkey"
  FOREIGN KEY ("connectionId", "businessId") REFERENCES "AcquisitionConnection"("id", "businessId")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "RevenueReceipt" ADD CONSTRAINT "RevenueReceipt_saleId_tenant_fkey"
  FOREIGN KEY ("businessId", "saleId") REFERENCES "RevenueSale"("businessId", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- ── 4. RevenueDailyClose — the Z report: closes one register day ────────────────────────────────

CREATE TABLE "RevenueDailyClose" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "sourceKind" "RevenueSourceKind" NOT NULL,
  "capture" "RevenueCapture" NOT NULL,
  "sourceScope" TEXT NOT NULL,
  "connectionId" INTEGER,
  "documentId" INTEGER,
  -- The sourceScope of the real-time sale stream this Z closes (NULL: the Z's own scope).
  "salesScope" TEXT,
  "registerKey" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "supersedesId" INTEGER,
  "zNumber" BIGINT,
  "businessDay" DATE NOT NULL,
  "periodStart" TIMESTAMP(3),
  "periodEnd" TIMESTAMP(3),
  "currency" TEXT NOT NULL,
  "grossMinor" BIGINT NOT NULL,
  "discountMinor" BIGINT NOT NULL DEFAULT 0,
  "refundMinor" BIGINT NOT NULL DEFAULT 0,
  "voidMinor" BIGINT NOT NULL DEFAULT 0,
  "totalMinor" BIGINT NOT NULL,
  "vatMinor" BIGINT NOT NULL,
  "grandTotalMinor" BIGINT,
  "transactionCount" INTEGER,
  "validation" "RevenueValidation" NOT NULL,
  "validationCodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "sourcePayloadHash" TEXT,
  "ingestRef" TEXT,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RevenueDailyClose_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RevenueDailyClose_tokens" CHECK (
        "sourceScope" ~ '^[a-z][a-z0-9_.:-]{0,79}$'
    AND ("salesScope" IS NULL OR "salesScope" ~ '^[a-z][a-z0-9_.:-]{0,79}$')
    AND "registerKey" ~ '^[A-Za-z0-9:_.-]{1,64}$'
    AND "externalId" ~ '^[A-Za-z0-9:_.#/-]{1,200}$'
    AND cardinality("validationCodes") <= 32
    AND array_to_string("validationCodes", ',') ~ '^([A-Z][A-Z0-9_]{0,63}(,[A-Z][A-Z0-9_]{0,63})*)?$'
    AND ("sourcePayloadHash" IS NULL OR "sourcePayloadHash" ~ '^[0-9a-f]{64}$')
    AND ("ingestRef" IS NULL OR "ingestRef" ~ '^[A-Za-z0-9:_.#/-]{1,200}$')
  ),
  CONSTRAINT "RevenueDailyClose_currency" CHECK ("currency" IN ('ILS', 'USD', 'EUR')),
  CONSTRAINT "RevenueDailyClose_amounts" CHECK (
        "grossMinor" >= 0 AND "discountMinor" >= 0 AND "refundMinor" >= 0 AND "voidMinor" >= 0
    AND "totalMinor" = "grossMinor" - "discountMinor" - "refundMinor" - "voidMinor"
    AND "vatMinor" >= 0
    AND ("zNumber" IS NULL OR "zNumber" >= 0)
    AND ("transactionCount" IS NULL OR "transactionCount" >= 0)
  ),
  CONSTRAINT "RevenueDailyClose_revision" CHECK (
        "revision" >= 1 AND (("revision" = 1) = ("supersedesId" IS NULL))
  ),
  CONSTRAINT "RevenueDailyClose_period" CHECK (
        "periodStart" IS NULL OR "periodEnd" IS NULL OR "periodEnd" >= "periodStart"
  )
);
CREATE UNIQUE INDEX "RevenueDailyClose_businessId_id_key" ON "RevenueDailyClose"("businessId", "id");
CREATE UNIQUE INDEX "RevenueDailyClose_source_key"
  ON "RevenueDailyClose"("businessId", "sourceScope", "registerKey", "externalId", "revision");
CREATE INDEX "RevenueDailyClose_businessId_businessDay_idx" ON "RevenueDailyClose"("businessId", "businessDay");
-- A revision is superseded at most once: corrections form a chain, never a fork.
CREATE UNIQUE INDEX "RevenueDailyClose_supersedes_once" ON "RevenueDailyClose"("businessId", "supersedesId")
  WHERE "supersedesId" IS NOT NULL;
ALTER TABLE "RevenueDailyClose" ADD CONSTRAINT "RevenueDailyClose_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "RevenueDailyClose" ADD CONSTRAINT "RevenueDailyClose_connectionId_tenant_fkey"
  FOREIGN KEY ("connectionId", "businessId") REFERENCES "AcquisitionConnection"("id", "businessId")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "RevenueDailyClose" ADD CONSTRAINT "RevenueDailyClose_documentId_tenant_fkey"
  FOREIGN KEY ("businessId", "documentId") REFERENCES "Document"("businessId", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "RevenueDailyClose" ADD CONSTRAINT "RevenueDailyClose_supersedesId_tenant_fkey"
  FOREIGN KEY ("businessId", "supersedesId") REFERENCES "RevenueDailyClose"("businessId", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ── 5. Z report lines: tenders and VAT ──────────────────────────────────────────────────────────

CREATE TABLE "RevenueDailyCloseTender" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "dailyCloseId" INTEGER NOT NULL,
  "method" "RevenueTenderMethod" NOT NULL,
  -- '' or a token (e.g. a card brand). Not NULL, so (close, method, label) is a real key.
  "label" TEXT NOT NULL DEFAULT '',
  -- Net taken by this method over the day; may be negative (cash paid back exceeding cash taken).
  "amountMinor" BIGINT NOT NULL,
  "count" INTEGER,
  CONSTRAINT "RevenueDailyCloseTender_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RevenueDailyCloseTender_tokens" CHECK ("label" ~ '^([a-z][a-z0-9_]{0,39})?$'),
  CONSTRAINT "RevenueDailyCloseTender_count" CHECK ("count" IS NULL OR "count" >= 0)
);
CREATE UNIQUE INDEX "RevenueDailyCloseTender_businessId_id_key" ON "RevenueDailyCloseTender"("businessId", "id");
CREATE UNIQUE INDEX "RevenueDailyCloseTender_dailyCloseId_method_label_key" ON "RevenueDailyCloseTender"("dailyCloseId", "method", "label");
ALTER TABLE "RevenueDailyCloseTender" ADD CONSTRAINT "RevenueDailyCloseTender_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "RevenueDailyCloseTender" ADD CONSTRAINT "RevenueDailyCloseTender_dailyCloseId_businessId_fkey"
  FOREIGN KEY ("businessId", "dailyCloseId") REFERENCES "RevenueDailyClose"("businessId", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

CREATE TABLE "RevenueDailyCloseVat" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "dailyCloseId" INTEGER NOT NULL,
  "category" "RevenueVatCategory" NOT NULL,
  "rateBasisPoints" INTEGER NOT NULL,
  "taxableMinor" BIGINT NOT NULL,
  "vatMinor" BIGINT NOT NULL,
  CONSTRAINT "RevenueDailyCloseVat_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RevenueDailyCloseVat_rate" CHECK (
        "rateBasisPoints" BETWEEN 0 AND 10000
    AND ("category" = 'STANDARD' OR ("rateBasisPoints" = 0 AND "vatMinor" = 0))
  )
);
CREATE UNIQUE INDEX "RevenueDailyCloseVat_businessId_id_key" ON "RevenueDailyCloseVat"("businessId", "id");
CREATE UNIQUE INDEX "RevenueDailyCloseVat_dailyCloseId_category_rateBasisPoints_key" ON "RevenueDailyCloseVat"("dailyCloseId", "category", "rateBasisPoints");
ALTER TABLE "RevenueDailyCloseVat" ADD CONSTRAINT "RevenueDailyCloseVat_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "RevenueDailyCloseVat" ADD CONSTRAINT "RevenueDailyCloseVat_dailyCloseId_businessId_fkey"
  FOREIGN KEY ("businessId", "dailyCloseId") REFERENCES "RevenueDailyClose"("businessId", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- ── 6. RevenueSettlement — layer 3: an acquirer / provider credit ───────────────────────────────

CREATE TABLE "RevenueSettlement" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "sourceKind" "RevenueSourceKind" NOT NULL,
  "capture" "RevenueCapture" NOT NULL,
  "sourceScope" TEXT NOT NULL,
  "connectionId" INTEGER,
  "documentId" INTEGER,
  "externalId" TEXT NOT NULL,
  "acquirer" TEXT NOT NULL,
  "valueDate" DATE NOT NULL,
  "currency" TEXT NOT NULL,
  "grossMinor" BIGINT NOT NULL,
  "feeMinor" BIGINT NOT NULL DEFAULT 0,
  "otherDeductionsMinor" BIGINT NOT NULL DEFAULT 0,
  "netMinor" BIGINT NOT NULL,
  "installmentNumber" SMALLINT,
  "installmentCount" SMALLINT,
  "validation" "RevenueValidation" NOT NULL,
  "validationCodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "sourcePayloadHash" TEXT,
  "ingestRef" TEXT,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RevenueSettlement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RevenueSettlement_source" CHECK ("sourceKind" IN ('ACQUIRER', 'PAYMENT_PROVIDER')),
  CONSTRAINT "RevenueSettlement_tokens" CHECK (
        "sourceScope" ~ '^[a-z][a-z0-9_.:-]{0,79}$'
    AND "externalId" ~ '^[A-Za-z0-9:_.#/-]{1,200}$'
    AND "acquirer" ~ '^[a-z][a-z0-9_]{0,39}$'
    AND cardinality("validationCodes") <= 32
    AND array_to_string("validationCodes", ',') ~ '^([A-Z][A-Z0-9_]{0,63}(,[A-Z][A-Z0-9_]{0,63})*)?$'
    AND ("sourcePayloadHash" IS NULL OR "sourcePayloadHash" ~ '^[0-9a-f]{64}$')
    AND ("ingestRef" IS NULL OR "ingestRef" ~ '^[A-Za-z0-9:_.#/-]{1,200}$')
  ),
  CONSTRAINT "RevenueSettlement_currency" CHECK ("currency" IN ('ILS', 'USD', 'EUR')),
  CONSTRAINT "RevenueSettlement_amounts" CHECK (
        "grossMinor" >= 0 AND "feeMinor" >= 0 AND "otherDeductionsMinor" >= 0
    AND "netMinor" = "grossMinor" - "feeMinor" - "otherDeductionsMinor"
  ),
  CONSTRAINT "RevenueSettlement_installment" CHECK (
        ("installmentNumber" IS NULL AND "installmentCount" IS NULL)
     OR ("installmentCount" BETWEEN 1 AND 99 AND "installmentNumber" BETWEEN 1 AND "installmentCount")
  )
);
CREATE UNIQUE INDEX "RevenueSettlement_businessId_id_key" ON "RevenueSettlement"("businessId", "id");
CREATE UNIQUE INDEX "RevenueSettlement_businessId_sourceScope_externalId_key" ON "RevenueSettlement"("businessId", "sourceScope", "externalId");
CREATE INDEX "RevenueSettlement_businessId_valueDate_idx" ON "RevenueSettlement"("businessId", "valueDate");
ALTER TABLE "RevenueSettlement" ADD CONSTRAINT "RevenueSettlement_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "RevenueSettlement" ADD CONSTRAINT "RevenueSettlement_connectionId_tenant_fkey"
  FOREIGN KEY ("connectionId", "businessId") REFERENCES "AcquisitionConnection"("id", "businessId")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "RevenueSettlement" ADD CONSTRAINT "RevenueSettlement_documentId_tenant_fkey"
  FOREIGN KEY ("businessId", "documentId") REFERENCES "Document"("businessId", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ── 7. RevenueLink — a proposed connection between two layers ───────────────────────────────────

CREATE TABLE "RevenueLink" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "linkKind" "RevenueLinkKind" NOT NULL,
  "saleId" INTEGER,
  "receiptId" INTEGER,
  "dailyCloseTenderId" INTEGER,
  "settlementId" INTEGER,
  "externalTransactionId" INTEGER,
  "billingDocumentId" INTEGER,
  -- The part of the money this link accounts for (partial settlements / deposits); NULL only for
  -- SALE_SAME_AS_DOCUMENT, which says "these two are one sale" and moves no money.
  "amountMinor" BIGINT,
  "currency" TEXT NOT NULL,
  "basis" "RevenueLinkBasis" NOT NULL,
  "proposedBy" "RevenueActor" NOT NULL,
  "score" SMALLINT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RevenueLink_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RevenueLink_currency" CHECK ("currency" IN ('ILS', 'USD', 'EUR')),
  CONSTRAINT "RevenueLink_score" CHECK ("score" IS NULL OR "score" BETWEEN 0 AND 100),
  CONSTRAINT "RevenueLink_shape" CHECK (
    CASE "linkKind"
      WHEN 'SALE_SAME_AS_DOCUMENT' THEN
            "saleId" IS NOT NULL AND "billingDocumentId" IS NOT NULL AND "amountMinor" IS NULL
        AND num_nonnulls("receiptId", "dailyCloseTenderId", "settlementId", "externalTransactionId") = 0
      WHEN 'TENDER_SETTLED_BY' THEN
            num_nonnulls("receiptId", "dailyCloseTenderId") = 1 AND "settlementId" IS NOT NULL
        AND "amountMinor" > 0
        AND num_nonnulls("saleId", "externalTransactionId", "billingDocumentId") = 0
      WHEN 'SETTLEMENT_DEPOSITED_AS' THEN
            "settlementId" IS NOT NULL AND "externalTransactionId" IS NOT NULL AND "amountMinor" > 0
        AND num_nonnulls("saleId", "receiptId", "dailyCloseTenderId", "billingDocumentId") = 0
      WHEN 'CASH_DEPOSITED_AS' THEN
            num_nonnulls("receiptId", "dailyCloseTenderId") = 1 AND "externalTransactionId" IS NOT NULL
        AND "amountMinor" > 0
        AND num_nonnulls("saleId", "settlementId", "billingDocumentId") = 0
    END
  )
);
CREATE UNIQUE INDEX "RevenueLink_businessId_id_key" ON "RevenueLink"("businessId", "id");
CREATE INDEX "RevenueLink_businessId_linkKind_idx" ON "RevenueLink"("businessId", "linkKind");
-- One proposal per pair: a rejected pair is remembered, never proposed again.
CREATE UNIQUE INDEX "RevenueLink_one_sale_document" ON "RevenueLink"("businessId", "saleId", "billingDocumentId")
  WHERE "linkKind" = 'SALE_SAME_AS_DOCUMENT';
CREATE UNIQUE INDEX "RevenueLink_one_tender_settlement" ON "RevenueLink"
  ("businessId", COALESCE("receiptId", 0), COALESCE("dailyCloseTenderId", 0), "settlementId")
  WHERE "linkKind" = 'TENDER_SETTLED_BY';
CREATE UNIQUE INDEX "RevenueLink_one_settlement_deposit" ON "RevenueLink"("businessId", "settlementId", "externalTransactionId")
  WHERE "linkKind" = 'SETTLEMENT_DEPOSITED_AS';
CREATE UNIQUE INDEX "RevenueLink_one_cash_deposit" ON "RevenueLink"
  ("businessId", COALESCE("receiptId", 0), COALESCE("dailyCloseTenderId", 0), "externalTransactionId")
  WHERE "linkKind" = 'CASH_DEPOSITED_AS';
ALTER TABLE "RevenueLink" ADD CONSTRAINT "RevenueLink_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "RevenueLink" ADD CONSTRAINT "RevenueLink_saleId_tenant_fkey"
  FOREIGN KEY ("businessId", "saleId") REFERENCES "RevenueSale"("businessId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "RevenueLink" ADD CONSTRAINT "RevenueLink_receiptId_tenant_fkey"
  FOREIGN KEY ("businessId", "receiptId") REFERENCES "RevenueReceipt"("businessId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "RevenueLink" ADD CONSTRAINT "RevenueLink_dailyCloseTenderId_tenant_fkey"
  FOREIGN KEY ("businessId", "dailyCloseTenderId") REFERENCES "RevenueDailyCloseTender"("businessId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "RevenueLink" ADD CONSTRAINT "RevenueLink_settlementId_tenant_fkey"
  FOREIGN KEY ("businessId", "settlementId") REFERENCES "RevenueSettlement"("businessId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;
-- No (businessId, id) key on these two (adding one would change an existing table): plain keys, and the
-- same-business rule is enforced by "RevenueLink_guard" below.
ALTER TABLE "RevenueLink" ADD CONSTRAINT "RevenueLink_externalTransactionId_ref_fkey"
  FOREIGN KEY ("externalTransactionId") REFERENCES "ExternalTransaction"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "RevenueLink" ADD CONSTRAINT "RevenueLink_billingDocumentId_ref_fkey"
  FOREIGN KEY ("billingDocumentId") REFERENCES "BillingDocument"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ── 8. RevenueDecision — the append-only journal of decisions ───────────────────────────────────

CREATE TABLE "RevenueDecision" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "linkId" INTEGER,
  "dailyCloseId" INTEGER,
  "decision" "RevenueDecisionKind" NOT NULL,
  "actor" "RevenueActor" NOT NULL,
  "reasonCode" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RevenueDecision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RevenueDecision_subject" CHECK (num_nonnulls("linkId", "dailyCloseId") = 1),
  CONSTRAINT "RevenueDecision_tokens" CHECK (
        "idempotencyKey" ~ '^[A-Za-z0-9:_#-]{8,200}$'
    AND ("reasonCode" IS NULL OR "reasonCode" ~ '^[A-Z][A-Z0-9_]{0,63}$')
  )
);
CREATE UNIQUE INDEX "RevenueDecision_businessId_idempotencyKey_key" ON "RevenueDecision"("businessId", "idempotencyKey");
CREATE INDEX "RevenueDecision_businessId_linkId_idx" ON "RevenueDecision"("businessId", "linkId");
CREATE INDEX "RevenueDecision_businessId_dailyCloseId_idx" ON "RevenueDecision"("businessId", "dailyCloseId");
ALTER TABLE "RevenueDecision" ADD CONSTRAINT "RevenueDecision_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "RevenueDecision" ADD CONSTRAINT "RevenueDecision_linkId_tenant_fkey"
  FOREIGN KEY ("businessId", "linkId") REFERENCES "RevenueLink"("businessId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "RevenueDecision" ADD CONSTRAINT "RevenueDecision_dailyCloseId_tenant_fkey"
  FOREIGN KEY ("businessId", "dailyCloseId") REFERENCES "RevenueDailyClose"("businessId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ── 9. The link guard: what a composite key cannot say ──────────────────────────────────────────
-- SECURITY INVOKER on purpose: it reads as the inserting role, under that role's row-level security, so a
-- row of another business is simply not there to be found.

CREATE OR REPLACE FUNCTION public.revenue_link_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_currency text;
  v_amount bigint;
  v_method "RevenueTenderMethod";
BEGIN
  IF NEW."externalTransactionId" IS NOT NULL THEN
    -- Bank amounts are NUMERIC(18,2); every supported currency has exponent 2.
    SELECT et."currency", (et."amount" * 100)::bigint INTO v_currency, v_amount
      FROM "ExternalTransaction" et
     WHERE et."id" = NEW."externalTransactionId"
       AND et."businessId" = NEW."businessId"
       AND et."direction" = 'CREDIT';
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'DZR02',
        MESSAGE = 'REVENUE_LINK_BANK_LINE: the bank line must be an incoming (CREDIT) line of the same business';
    END IF;
    IF v_currency <> NEW."currency" OR NEW."amountMinor" > v_amount THEN
      RAISE EXCEPTION USING ERRCODE = 'DZR03',
        MESSAGE = 'REVENUE_LINK_AMOUNT: the link must be in the bank line''s currency and not exceed it';
    END IF;
  END IF;

  IF NEW."billingDocumentId" IS NOT NULL THEN
    SELECT bd."currency" INTO v_currency
      FROM "BillingDocument" bd
     WHERE bd."id" = NEW."billingDocumentId"
       AND bd."businessId" = NEW."businessId"
       AND bd."status" = 'ISSUED'
       AND bd."documentType" IN ('TAX_INVOICE', 'TAX_INVOICE_RECEIPT');
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'DZR02',
        MESSAGE = 'REVENUE_LINK_DOCUMENT: the document must be an issued tax invoice (or invoice-receipt) of the same business';
    END IF;
    IF v_currency <> NEW."currency" THEN
      RAISE EXCEPTION USING ERRCODE = 'DZR03', MESSAGE = 'REVENUE_LINK_AMOUNT: currency differs from the document';
    END IF;
  END IF;

  IF NEW."saleId" IS NOT NULL THEN
    SELECT s."currency" INTO v_currency FROM "RevenueSale" s
     WHERE s."businessId" = NEW."businessId" AND s."id" = NEW."saleId" AND s."kind" = 'SALE';
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'DZR02', MESSAGE = 'REVENUE_LINK_SALE: only a sale (not a refund / void) is linked to a document';
    END IF;
    IF v_currency <> NEW."currency" THEN
      RAISE EXCEPTION USING ERRCODE = 'DZR03', MESSAGE = 'REVENUE_LINK_AMOUNT: currency differs from the sale';
    END IF;
  END IF;

  IF NEW."receiptId" IS NOT NULL THEN
    SELECT r."currency", r."amountMinor", r."method" INTO v_currency, v_amount, v_method FROM "RevenueReceipt" r
     WHERE r."businessId" = NEW."businessId" AND r."id" = NEW."receiptId" AND r."direction" = 'IN';
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'DZR02', MESSAGE = 'REVENUE_LINK_RECEIPT: only money taken in is settled or deposited';
    END IF;
    IF v_currency <> NEW."currency" OR NEW."amountMinor" > v_amount THEN
      RAISE EXCEPTION USING ERRCODE = 'DZR03', MESSAGE = 'REVENUE_LINK_AMOUNT: the link must be in the receipt''s currency and not exceed it';
    END IF;
  END IF;

  IF NEW."dailyCloseTenderId" IS NOT NULL THEN
    SELECT c."currency", t."amountMinor", t."method" INTO v_currency, v_amount, v_method
      FROM "RevenueDailyCloseTender" t
      JOIN "RevenueDailyClose" c ON c."businessId" = t."businessId" AND c."id" = t."dailyCloseId"
     WHERE t."businessId" = NEW."businessId" AND t."id" = NEW."dailyCloseTenderId";
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'DZR02', MESSAGE = 'REVENUE_LINK_TENDER: the Z tender must belong to the same business';
    END IF;
    IF v_currency <> NEW."currency" OR NEW."amountMinor" > v_amount THEN
      RAISE EXCEPTION USING ERRCODE = 'DZR03', MESSAGE = 'REVENUE_LINK_AMOUNT: the link must be in the tender''s currency and not exceed it';
    END IF;
  END IF;

  IF NEW."linkKind" = 'TENDER_SETTLED_BY' AND v_method <> 'CARD' THEN
    RAISE EXCEPTION USING ERRCODE = 'DZR02', MESSAGE = 'REVENUE_LINK_METHOD: only card tenders are settled by an acquirer';
  END IF;
  IF NEW."linkKind" = 'CASH_DEPOSITED_AS' AND v_method <> 'CASH' THEN
    RAISE EXCEPTION USING ERRCODE = 'DZR02', MESSAGE = 'REVENUE_LINK_METHOD: only cash is deposited as cash';
  END IF;

  IF NEW."settlementId" IS NOT NULL THEN
    SELECT st."currency",
           CASE WHEN NEW."linkKind" = 'SETTLEMENT_DEPOSITED_AS' THEN st."netMinor" ELSE st."grossMinor" END
      INTO v_currency, v_amount
      FROM "RevenueSettlement" st
     WHERE st."businessId" = NEW."businessId" AND st."id" = NEW."settlementId";
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'DZR02', MESSAGE = 'REVENUE_LINK_SETTLEMENT: the settlement must belong to the same business';
    END IF;
    IF v_currency <> NEW."currency" OR NEW."amountMinor" > v_amount THEN
      RAISE EXCEPTION USING ERRCODE = 'DZR03',
        MESSAGE = 'REVENUE_LINK_AMOUNT: the link must be in the settlement''s currency and not exceed its gross (tender) / net (deposit)';
    END IF;
  END IF;

  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.revenue_link_guard() FROM PUBLIC;

CREATE TRIGGER "RevenueLink_guard" BEFORE INSERT ON "RevenueLink"
  FOR EACH ROW EXECUTE FUNCTION public.revenue_link_guard();

-- ── 10. Append-only, for every role ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.revenue_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  -- A cascade (the business, or a bank line a link names) is the only way a row leaves.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = 'DZR01',
    MESSAGE = format('REVENUE_APPEND_ONLY: %s on %I is refused; revenue evidence is append-only — record a correction instead', TG_OP, TG_TABLE_NAME);
END
$fn$;
REVOKE ALL ON FUNCTION public.revenue_append_only_guard() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.revenue_truncate_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'DZR01',
    MESSAGE = format('REVENUE_APPEND_ONLY: TRUNCATE on %I is refused', TG_TABLE_NAME);
END
$fn$;
REVOKE ALL ON FUNCTION public.revenue_truncate_guard() FROM PUBLIC;

CREATE TRIGGER "RevenueSale_append_only" BEFORE UPDATE OR DELETE ON "RevenueSale"
  FOR EACH ROW EXECUTE FUNCTION public.revenue_append_only_guard();
CREATE TRIGGER "RevenueSale_no_truncate" BEFORE TRUNCATE ON "RevenueSale"
  FOR EACH STATEMENT EXECUTE FUNCTION public.revenue_truncate_guard();
CREATE TRIGGER "RevenueReceipt_append_only" BEFORE UPDATE OR DELETE ON "RevenueReceipt"
  FOR EACH ROW EXECUTE FUNCTION public.revenue_append_only_guard();
CREATE TRIGGER "RevenueReceipt_no_truncate" BEFORE TRUNCATE ON "RevenueReceipt"
  FOR EACH STATEMENT EXECUTE FUNCTION public.revenue_truncate_guard();
CREATE TRIGGER "RevenueDailyClose_append_only" BEFORE UPDATE OR DELETE ON "RevenueDailyClose"
  FOR EACH ROW EXECUTE FUNCTION public.revenue_append_only_guard();
CREATE TRIGGER "RevenueDailyClose_no_truncate" BEFORE TRUNCATE ON "RevenueDailyClose"
  FOR EACH STATEMENT EXECUTE FUNCTION public.revenue_truncate_guard();
CREATE TRIGGER "RevenueDailyCloseTender_append_only" BEFORE UPDATE OR DELETE ON "RevenueDailyCloseTender"
  FOR EACH ROW EXECUTE FUNCTION public.revenue_append_only_guard();
CREATE TRIGGER "RevenueDailyCloseTender_no_truncate" BEFORE TRUNCATE ON "RevenueDailyCloseTender"
  FOR EACH STATEMENT EXECUTE FUNCTION public.revenue_truncate_guard();
CREATE TRIGGER "RevenueDailyCloseVat_append_only" BEFORE UPDATE OR DELETE ON "RevenueDailyCloseVat"
  FOR EACH ROW EXECUTE FUNCTION public.revenue_append_only_guard();
CREATE TRIGGER "RevenueDailyCloseVat_no_truncate" BEFORE TRUNCATE ON "RevenueDailyCloseVat"
  FOR EACH STATEMENT EXECUTE FUNCTION public.revenue_truncate_guard();
CREATE TRIGGER "RevenueSettlement_append_only" BEFORE UPDATE OR DELETE ON "RevenueSettlement"
  FOR EACH ROW EXECUTE FUNCTION public.revenue_append_only_guard();
CREATE TRIGGER "RevenueSettlement_no_truncate" BEFORE TRUNCATE ON "RevenueSettlement"
  FOR EACH STATEMENT EXECUTE FUNCTION public.revenue_truncate_guard();
CREATE TRIGGER "RevenueLink_append_only" BEFORE UPDATE OR DELETE ON "RevenueLink"
  FOR EACH ROW EXECUTE FUNCTION public.revenue_append_only_guard();
CREATE TRIGGER "RevenueLink_no_truncate" BEFORE TRUNCATE ON "RevenueLink"
  FOR EACH STATEMENT EXECUTE FUNCTION public.revenue_truncate_guard();
CREATE TRIGGER "RevenueDecision_append_only" BEFORE UPDATE OR DELETE ON "RevenueDecision"
  FOR EACH ROW EXECUTE FUNCTION public.revenue_append_only_guard();
CREATE TRIGGER "RevenueDecision_no_truncate" BEFORE TRUNCATE ON "RevenueDecision"
  FOR EACH STATEMENT EXECUTE FUNCTION public.revenue_truncate_guard();

-- ── 11. Row-level security — per command, SELECT and INSERT only ────────────────────────────────

ALTER TABLE "RevenueSale" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RevenueSale" FORCE ROW LEVEL SECURITY;
CREATE POLICY revenue_sale_tenant_select ON "RevenueSale" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY revenue_sale_tenant_insert ON "RevenueSale" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "RevenueReceipt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RevenueReceipt" FORCE ROW LEVEL SECURITY;
CREATE POLICY revenue_receipt_tenant_select ON "RevenueReceipt" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY revenue_receipt_tenant_insert ON "RevenueReceipt" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "RevenueDailyClose" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RevenueDailyClose" FORCE ROW LEVEL SECURITY;
CREATE POLICY revenue_daily_close_tenant_select ON "RevenueDailyClose" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY revenue_daily_close_tenant_insert ON "RevenueDailyClose" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "RevenueDailyCloseTender" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RevenueDailyCloseTender" FORCE ROW LEVEL SECURITY;
CREATE POLICY revenue_daily_close_tender_tenant_select ON "RevenueDailyCloseTender" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY revenue_daily_close_tender_tenant_insert ON "RevenueDailyCloseTender" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "RevenueDailyCloseVat" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RevenueDailyCloseVat" FORCE ROW LEVEL SECURITY;
CREATE POLICY revenue_daily_close_vat_tenant_select ON "RevenueDailyCloseVat" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY revenue_daily_close_vat_tenant_insert ON "RevenueDailyCloseVat" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "RevenueSettlement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RevenueSettlement" FORCE ROW LEVEL SECURITY;
CREATE POLICY revenue_settlement_tenant_select ON "RevenueSettlement" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY revenue_settlement_tenant_insert ON "RevenueSettlement" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "RevenueLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RevenueLink" FORCE ROW LEVEL SECURITY;
CREATE POLICY revenue_link_tenant_select ON "RevenueLink" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY revenue_link_tenant_insert ON "RevenueLink" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "RevenueDecision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RevenueDecision" FORCE ROW LEVEL SECURITY;
CREATE POLICY revenue_decision_tenant_select ON "RevenueDecision" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY revenue_decision_tenant_insert ON "RevenueDecision" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── 12. Privileges — named explicitly ───────────────────────────────────────────────────────────

-- Whatever DEFAULT PRIVILEGES handed out when the tables and sequences were created goes, from every grantee
-- but the owner — then exactly what the runtime needs comes back.
DO $do$
DECLARE
  g record;
BEGIN
  FOR g IN
    SELECT c.oid::regclass AS rel, pg_get_userbyid(x.grantee) AS grantee, c.relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      CROSS JOIN LATERAL aclexplode(c.relacl) x
     WHERE c.relname IN ('RevenueSale', 'RevenueReceipt', 'RevenueDailyClose', 'RevenueDailyCloseTender',
                         'RevenueDailyCloseVat', 'RevenueSettlement', 'RevenueLink', 'RevenueDecision',
                         'RevenueSale_id_seq', 'RevenueReceipt_id_seq', 'RevenueDailyClose_id_seq',
                         'RevenueDailyCloseTender_id_seq', 'RevenueDailyCloseVat_id_seq', 'RevenueSettlement_id_seq',
                         'RevenueLink_id_seq', 'RevenueDecision_id_seq')
       AND x.grantee <> c.relowner AND x.grantee <> 0
  LOOP
    IF g.relkind = 'S' THEN
      EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM %I', g.rel, g.grantee);
    ELSE
      EXECUTE format('REVOKE ALL ON TABLE %s FROM %I', g.rel, g.grantee);
    END IF;
  END LOOP;
END
$do$;

REVOKE ALL ON "RevenueSale", "RevenueReceipt", "RevenueDailyClose", "RevenueDailyCloseTender", "RevenueDailyCloseVat",
              "RevenueSettlement", "RevenueLink", "RevenueDecision" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "RevenueSale_id_seq", "RevenueReceipt_id_seq", "RevenueDailyClose_id_seq",
                       "RevenueDailyCloseTender_id_seq", "RevenueDailyCloseVat_id_seq", "RevenueSettlement_id_seq",
                       "RevenueLink_id_seq", "RevenueDecision_id_seq" FROM PUBLIC;

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    -- Append-only for the runtime: read and add, nothing else.
    GRANT SELECT, INSERT ON "RevenueSale" TO app_runtime;
    GRANT SELECT, INSERT ON "RevenueReceipt" TO app_runtime;
    GRANT SELECT, INSERT ON "RevenueDailyClose" TO app_runtime;
    GRANT SELECT, INSERT ON "RevenueDailyCloseTender" TO app_runtime;
    GRANT SELECT, INSERT ON "RevenueDailyCloseVat" TO app_runtime;
    GRANT SELECT, INSERT ON "RevenueSettlement" TO app_runtime;
    GRANT SELECT, INSERT ON "RevenueLink" TO app_runtime;
    GRANT SELECT, INSERT ON "RevenueDecision" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "RevenueSale_id_seq", "RevenueReceipt_id_seq", "RevenueDailyClose_id_seq",
                                    "RevenueDailyCloseTender_id_seq", "RevenueDailyCloseVat_id_seq",
                                    "RevenueSettlement_id_seq", "RevenueLink_id_seq", "RevenueDecision_id_seq"
      TO app_runtime;
  END IF;
END
$do$;
