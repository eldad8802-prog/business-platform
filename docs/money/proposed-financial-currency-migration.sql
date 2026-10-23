-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- PROPOSED — NOT A MIGRATION. Lives under docs/ on purpose so no release gate can apply it.
-- NOT EXECUTED ANYWHERE YET (written without a database). Phase M1 must first apply it to an
-- ephemeral PG17 lab (pattern: .github/workflows/i18n-multicurrency-ci.yml step 5) and run §C + §D.
-- Design: docs/money/MULTI-CURRENCY-FINANCIAL-DESIGN.md (phase M1 = §A, phase M2 = §B tax-gated).
--
-- DEPENDS ON the settings + FX migration being finalised separately as
--   20261025090000_currency_settings_fx_rates
-- (proposal: docs/i18n-multicurrency/proposed-migration.sql) — it creates "FxRate" (the FK target of
-- "fxRateId") and "BusinessLocaleSettings" (the per-business base currency read by the backfill).
-- If that migration renames either object, rename here before promoting this file.
--
-- Compatibility: EXPAND-ONLY. Only ADD COLUMN / ADD CONSTRAINT / CREATE (function|trigger|index|table).
-- No existing column, row value, policy or grant is altered. Every ADD COLUMN has a constant default
-- or is nullable → metadata-only on PostgreSQL ≥ 11 (no table rewrite, no row trigger fired).
-- The only data change is the identity backfill (§A.4) on FinancialRecord / PaymentTransaction / Payment,
-- which writes ONLY the new columns. BillingDocument (fiscal-immutable) is never UPDATEd (§B inserts).
--
-- RLS: FinancialRecord, PaymentTransaction and Payment are already ENABLE + FORCE RLS with tenant
-- policies (p7w4d_tenant / payables + payments policies); new columns inherit them — policies are
-- row-level, not column-level. Grants to app_runtime on these tables are TABLE-level (no column-level
-- grant exists on them), so the new columns are covered without a GRANT. The new tables in §B carry
-- their own ENABLE + FORCE RLS, per-command policies and explicit grants (tenant-table-rls-guard R1/R2).
--
-- Rollback (§D) drops exactly what this file adds; original columns are untouched.
-- ════════════════════════════════════════════════════════════════════════════════════════════════


-- ════════════════════════ §A — phase M1 (not tax-gated) ════════════════════════════════════════

-- ── A.1 FinancialRecord: transaction currency + provenance + base snapshot ──────────────────────
ALTER TABLE "FinancialRecord"
  ADD COLUMN "currency"       TEXT NOT NULL DEFAULT 'ILS',
  -- Old rows were entered through a ₪-only UI and never stated a currency: say so.
  ADD COLUMN "currencySource" TEXT NOT NULL DEFAULT 'BACKFILL_ASSUMED',
  ADD COLUMN "baseCurrency"   TEXT,
  ADD COLUMN "baseAmount"     NUMERIC(18,2),
  ADD COLUMN "fxRate"         NUMERIC(20,10),
  ADD COLUMN "fxRateDate"     DATE,
  ADD COLUMN "fxRateKind"     TEXT,
  ADD COLUMN "fxRateSource"   TEXT,
  ADD COLUMN "fxRateId"       INTEGER,
  ADD COLUMN "baseStatus"     TEXT NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "basePostedAt"   TIMESTAMP(3);

ALTER TABLE "FinancialRecord"
  ADD CONSTRAINT "FinancialRecord_currency_iso"     CHECK ("currency" IN ('ILS','USD','EUR')),
  ADD CONSTRAINT "FinancialRecord_currency_source"  CHECK ("currencySource" IN ('BACKFILL_ASSUMED','OWNER_ENTERED','OCR_DETECTED'));

-- ── A.2 the same snapshot on the two other posting tables (currency already exists there) ─────────
ALTER TABLE "PaymentTransaction"
  ADD COLUMN "baseCurrency" TEXT,
  ADD COLUMN "baseAmount"   NUMERIC(18,2),
  ADD COLUMN "fxRate"       NUMERIC(20,10),
  ADD COLUMN "fxRateDate"   DATE,
  ADD COLUMN "fxRateKind"   TEXT,
  ADD COLUMN "fxRateSource" TEXT,
  ADD COLUMN "fxRateId"     INTEGER,
  ADD COLUMN "baseStatus"   TEXT NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "basePostedAt" TIMESTAMP(3);

ALTER TABLE "Payment"
  ADD COLUMN "baseCurrency" TEXT,
  ADD COLUMN "baseAmount"   NUMERIC(18,2),
  ADD COLUMN "fxRate"       NUMERIC(20,10),
  ADD COLUMN "fxRateDate"   DATE,
  ADD COLUMN "fxRateKind"   TEXT,
  ADD COLUMN "fxRateSource" TEXT,
  ADD COLUMN "fxRateId"     INTEGER,
  ADD COLUMN "baseStatus"   TEXT NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "basePostedAt" TIMESTAMP(3);

-- Snapshot invariants, identical on the three tables. `amount` is Float on FinancialRecord and
-- numeric(18,2) on the others; round(amount::numeric, 2) is exact for the latter.
DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['FinancialRecord','PaymentTransaction','Payment'] LOOP
    EXECUTE format($f$
      ALTER TABLE %1$I
        ADD CONSTRAINT %2$I CHECK ("baseStatus" IN ('PENDING','FROZEN','RATE_UNAVAILABLE')),
        ADD CONSTRAINT %3$I CHECK ("baseCurrency" IS NULL OR "baseCurrency" IN ('ILS','USD','EUR')),
        ADD CONSTRAINT %4$I CHECK ("fxRateKind" IS NULL OR "fxRateKind" IN ('IDENTITY','REPRESENTATIVE','TRANSACTION')),
        ADD CONSTRAINT %5$I CHECK ("fxRateSource" IS NULL OR "fxRateSource" IN ('IDENTITY','BANK_OF_ISRAEL','PAYMENT_PROVIDER','MANUAL')),
        ADD CONSTRAINT %6$I CHECK (("fxRateKind" = 'IDENTITY') IS NOT DISTINCT FROM ("fxRateSource" = 'IDENTITY')),
        ADD CONSTRAINT %7$I CHECK ("fxRateId" IS NULL OR "fxRateKind" = 'REPRESENTATIVE'),
        ADD CONSTRAINT %8$I CHECK ("fxRate" IS NULL OR "fxRate" > 0),
        -- FROZEN ⇒ complete snapshot
        ADD CONSTRAINT %9$I CHECK ("baseStatus" <> 'FROZEN' OR (
              "baseCurrency" IS NOT NULL AND "baseAmount" IS NOT NULL AND "fxRate" IS NOT NULL
          AND "fxRateDate" IS NOT NULL AND "fxRateKind" IS NOT NULL AND "fxRateSource" IS NOT NULL
          AND "basePostedAt" IS NOT NULL)),
        -- same currency ⇒ identity, exactly
        ADD CONSTRAINT %10$I CHECK ("baseStatus" <> 'FROZEN' OR "currency" <> "baseCurrency" OR (
              "fxRate" = 1 AND "fxRateKind" = 'IDENTITY' AND "baseAmount" = round("amount"::numeric, 2))),
        -- no rate ⇒ no base amount (reports say "unavailable", never a number)
        ADD CONSTRAINT %11$I CHECK ("baseStatus" <> 'RATE_UNAVAILABLE' OR "baseAmount" IS NULL)
    $f$, t,
      t || '_base_status', t || '_base_currency', t || '_fx_kind', t || '_fx_source', t || '_fx_identity_pair',
      t || '_fx_ref_kind', t || '_fx_positive', t || '_frozen_complete', t || '_frozen_identity', t || '_unavailable_null');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("fxRateId") REFERENCES "FxRate"("id") ON DELETE RESTRICT ON UPDATE RESTRICT',
                   t, t || '_fxRateId_fkey');
    -- the late-posting job reads only the non-frozen tail
    EXECUTE format('CREATE INDEX %I ON %I ("baseStatus") WHERE "baseStatus" <> %L', t || '_base_pending_idx', t, 'FROZEN');
  END LOOP;
END
$do$;

-- ── A.3 frozen is frozen ───────────────────────────────────────────────────────────────────────
-- A FROZEN snapshot (and the amount/currency it was computed from) can never change. The only
-- transitions allowed are PENDING → FROZEN | RATE_UNAVAILABLE and RATE_UNAVAILABLE → FROZEN.
CREATE OR REPLACE FUNCTION public.money_base_snapshot_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF OLD."baseStatus" = 'FROZEN' AND (
       NEW."baseStatus"   IS DISTINCT FROM OLD."baseStatus"
    OR NEW."baseCurrency" IS DISTINCT FROM OLD."baseCurrency"
    OR NEW."baseAmount"   IS DISTINCT FROM OLD."baseAmount"
    OR NEW."fxRate"       IS DISTINCT FROM OLD."fxRate"
    OR NEW."fxRateDate"   IS DISTINCT FROM OLD."fxRateDate"
    OR NEW."fxRateKind"   IS DISTINCT FROM OLD."fxRateKind"
    OR NEW."fxRateSource" IS DISTINCT FROM OLD."fxRateSource"
    OR NEW."fxRateId"     IS DISTINCT FROM OLD."fxRateId"
    OR NEW."basePostedAt" IS DISTINCT FROM OLD."basePostedAt"
    OR NEW."currency"     IS DISTINCT FROM OLD."currency"
    OR NEW."amount"       IS DISTINCT FROM OLD."amount") THEN
    RAISE EXCEPTION USING ERRCODE = 'DZ011',
      MESSAGE = format('BASE_SNAPSHOT_FROZEN: %s %s', TG_TABLE_NAME, OLD."id");
  END IF;
  IF OLD."baseStatus" = 'RATE_UNAVAILABLE' AND NEW."baseStatus" = 'PENDING' THEN
    RAISE EXCEPTION USING ERRCODE = 'DZ011',
      MESSAGE = format('BASE_SNAPSHOT_REGRESSION: %s %s', TG_TABLE_NAME, OLD."id");
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.money_base_snapshot_guard() FROM PUBLIC;
CREATE TRIGGER money_base_snapshot_guard BEFORE UPDATE ON "FinancialRecord"
  FOR EACH ROW EXECUTE FUNCTION public.money_base_snapshot_guard();
CREATE TRIGGER money_base_snapshot_guard BEFORE UPDATE ON "PaymentTransaction"
  FOR EACH ROW EXECUTE FUNCTION public.money_base_snapshot_guard();
CREATE TRIGGER money_base_snapshot_guard BEFORE UPDATE ON "Payment"
  FOR EACH ROW EXECUTE FUNCTION public.money_base_snapshot_guard();
-- NOTE for the app PR: payables `Payment` is voided by UPDATE (status/voidedAt…) — those columns are
-- not frozen, so voiding stays possible. FinancialRecord re-approval with IDENTICAL values (the
-- approved-mutation guard's idempotent path) changes nothing frozen and passes.

-- ── A.4 identity backfill (idempotent; exact only) ─────────────────────────────────────────────
-- Base currency per business = BusinessLocaleSettings.baseCurrency, absent ⇒ 'ILS'.
-- Only rows whose transaction currency equals that base AND whose amount is exactly representable
-- at 2 decimals are posted. Everything else stays PENDING (non-ILS → RATE_UNAVAILABLE) and is
-- COUNTED by the proof (§C), never guessed.
UPDATE "FinancialRecord" fr
   SET "baseCurrency" = 'ILS',
       "baseAmount"   = round(fr."amount"::numeric, 2),
       "fxRate"       = 1,
       "fxRateDate"   = (fr."date" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Jerusalem')::date,
       "fxRateKind"   = 'IDENTITY',
       "fxRateSource" = 'IDENTITY',
       "baseStatus"   = 'FROZEN',
       "basePostedAt" = CURRENT_TIMESTAMP
 WHERE fr."baseStatus" = 'PENDING'
   AND fr."currency" = 'ILS'
   AND abs(fr."amount"::numeric - round(fr."amount"::numeric, 2)) < 0.0000001
   AND COALESCE((SELECT s."baseCurrency" FROM "BusinessLocaleSettings" s WHERE s."businessId" = fr."businessId"), 'ILS') = 'ILS';

UPDATE "PaymentTransaction" pt
   SET "baseCurrency" = 'ILS', "baseAmount" = pt."amount", "fxRate" = 1,
       "fxRateDate"   = (pt."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Jerusalem')::date,
       "fxRateKind"   = 'IDENTITY', "fxRateSource" = 'IDENTITY',
       "baseStatus"   = 'FROZEN', "basePostedAt" = CURRENT_TIMESTAMP
  FROM "PaymentRequest" pr
 WHERE pr."id" = pt."paymentRequestId"
   AND pt."baseStatus" = 'PENDING' AND pt."status" = 'PAID' AND pt."currency" = 'ILS'
   AND COALESCE((SELECT s."baseCurrency" FROM "BusinessLocaleSettings" s WHERE s."businessId" = pr."businessId"), 'ILS') = 'ILS';
UPDATE "PaymentTransaction" SET "baseStatus" = 'RATE_UNAVAILABLE'
 WHERE "baseStatus" = 'PENDING' AND "status" = 'PAID' AND "currency" <> 'ILS';
-- Non-PAID transactions (PENDING/FAILED/…) are not postings and stay PENDING.

UPDATE "Payment" p
   SET "baseCurrency" = 'ILS', "baseAmount" = p."amount", "fxRate" = 1,
       "fxRateDate"   = (p."paidAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Jerusalem')::date,
       "fxRateKind"   = 'IDENTITY', "fxRateSource" = 'IDENTITY',
       "baseStatus"   = 'FROZEN', "basePostedAt" = CURRENT_TIMESTAMP
 WHERE p."baseStatus" = 'PENDING' AND p."currency" = 'ILS'
   AND COALESCE((SELECT s."baseCurrency" FROM "BusinessLocaleSettings" s WHERE s."businessId" = p."businessId"), 'ILS') = 'ILS';
UPDATE "Payment" SET "baseStatus" = 'RATE_UNAVAILABLE'
 WHERE "baseStatus" = 'PENDING' AND "currency" <> 'ILS';
-- Voided payments keep their snapshot (a void is a status, not an un-posting).


-- ════════════════════════ §B — phase M2, TAX-GATED (D-3) — DO NOT PROMOTE before the accountant rules ══
-- Issued BillingDocument rows are frozen by secf_fiscal_immutable; their base snapshot is a separate,
-- append-only row written in the issuing transaction. ILS documents in an ILS business get IDENTITY rows
-- (INSERT only — the document row is never UPDATEd).

CREATE TABLE "BillingDocumentFxSnapshot" (
  "billingDocumentId" INTEGER       NOT NULL,
  "businessId"        INTEGER       NOT NULL,
  "documentCurrency"  TEXT          NOT NULL,
  "baseCurrency"      TEXT          NOT NULL,
  "fxRate"            NUMERIC(20,10) NOT NULL,
  "fxRateDate"        DATE          NOT NULL,
  "fxRateKind"        TEXT          NOT NULL,
  "fxRateSource"      TEXT          NOT NULL,
  "fxRateId"          INTEGER,
  "baseSubtotal"      NUMERIC(18,2) NOT NULL,
  "baseVat"           NUMERIC(18,2) NOT NULL,
  "baseTotal"         NUMERIC(18,2) NOT NULL,
  "createdAt"         TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BillingDocumentFxSnapshot_pkey" PRIMARY KEY ("billingDocumentId"),
  CONSTRAINT "BillingDocumentFxSnapshot_cur" CHECK ("documentCurrency" IN ('ILS','USD','EUR') AND "baseCurrency" IN ('ILS','USD','EUR')),
  CONSTRAINT "BillingDocumentFxSnapshot_kind" CHECK ("fxRateKind" IN ('IDENTITY','REPRESENTATIVE')),
  CONSTRAINT "BillingDocumentFxSnapshot_src" CHECK ("fxRateSource" IN ('IDENTITY','BANK_OF_ISRAEL','MANUAL')),
  CONSTRAINT "BillingDocumentFxSnapshot_identity" CHECK (("documentCurrency" = "baseCurrency") = ("fxRateKind" = 'IDENTITY') AND ("fxRateKind" <> 'IDENTITY' OR "fxRate" = 1)),
  CONSTRAINT "BillingDocumentFxSnapshot_rate" CHECK ("fxRate" > 0)
);
ALTER TABLE "BillingDocumentFxSnapshot"
  ADD CONSTRAINT "BillingDocumentFxSnapshot_doc_fkey" FOREIGN KEY ("billingDocumentId") REFERENCES "BillingDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "BillingDocumentFxSnapshot_biz_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "BillingDocumentFxSnapshot_fx_fkey"  FOREIGN KEY ("fxRateId") REFERENCES "FxRate"("id") ON DELETE RESTRICT;

-- Realised exchange differences (allocation / refund in a foreign currency). Append-only.
CREATE TABLE "FxDifference" (
  "id"            SERIAL        NOT NULL,
  "businessId"    INTEGER       NOT NULL,
  "sourceKind"    TEXT          NOT NULL,   -- BILLING_ALLOCATION | PAYMENT_REFUND | PAYABLES_ALLOCATION
  "sourceId"      INTEGER       NOT NULL,
  "currency"      TEXT          NOT NULL,   -- transaction currency of the settled amount
  "amount"        NUMERIC(18,2) NOT NULL,   -- the settled amount, transaction currency
  "baseCurrency"  TEXT          NOT NULL,
  "baseAtOrigin"  NUMERIC(18,2) NOT NULL,   -- at the invoice/original rate
  "baseAtSettle"  NUMERIC(18,2) NOT NULL,   -- at the payment/refund rate
  "difference"    NUMERIC(18,2) NOT NULL,   -- baseAtSettle - baseAtOrigin (gain > 0)
  "createdAt"     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FxDifference_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FxDifference_math" CHECK ("difference" = "baseAtSettle" - "baseAtOrigin"),
  CONSTRAINT "FxDifference_kind" CHECK ("sourceKind" IN ('BILLING_ALLOCATION','PAYMENT_REFUND','PAYABLES_ALLOCATION')),
  CONSTRAINT "FxDifference_cur" CHECK ("currency" IN ('ILS','USD','EUR') AND "baseCurrency" IN ('ILS','USD','EUR') AND "currency" <> "baseCurrency")
);
CREATE UNIQUE INDEX "FxDifference_source" ON "FxDifference" ("businessId", "sourceKind", "sourceId");
ALTER TABLE "FxDifference" ADD CONSTRAINT "FxDifference_biz_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION public.money_append_only_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'DZ011', MESSAGE = format('APPEND_ONLY: %s %s refused', TG_OP, TG_TABLE_NAME);
END
$fn$;
REVOKE ALL ON FUNCTION public.money_append_only_guard() FROM PUBLIC;
CREATE TRIGGER money_append_only_guard BEFORE UPDATE OR DELETE ON "BillingDocumentFxSnapshot" FOR EACH ROW EXECUTE FUNCTION public.money_append_only_guard();
CREATE TRIGGER money_append_only_guard BEFORE UPDATE OR DELETE ON "FxDifference"             FOR EACH ROW EXECUTE FUNCTION public.money_append_only_guard();
-- (Business erasure: ON DELETE CASCADE from Business runs as the owner role through the erasure
--  path; confirm with the erasure contract (erasure-contract-ci) before promoting — DELETE is refused
--  by the trigger, so the erasure manifest must list these tables as CASCADE-by-owner or the trigger
--  must exempt the erasure role. OPEN QUESTION for the M2 PR.)

ALTER TABLE "BillingDocumentFxSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BillingDocumentFxSnapshot" FORCE ROW LEVEL SECURITY;
ALTER TABLE "FxDifference" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FxDifference" FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_fx_snapshot_tenant_select ON "BillingDocumentFxSnapshot" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY billing_fx_snapshot_tenant_insert ON "BillingDocumentFxSnapshot" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY fx_difference_tenant_select ON "FxDifference" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY fx_difference_tenant_insert ON "FxDifference" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
REVOKE ALL ON "BillingDocumentFxSnapshot", "FxDifference" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "FxDifference_id_seq" FROM PUBLIC;
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT ON "BillingDocumentFxSnapshot", "FxDifference" TO app_runtime;
    REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "BillingDocumentFxSnapshot", "FxDifference" FROM app_runtime;
    GRANT USAGE ON SEQUENCE "FxDifference_id_seq" TO app_runtime;
  END IF;
END
$do$;

-- Identity snapshots for existing ISSUED ILS documents (INSERT only; documents untouched).
INSERT INTO "BillingDocumentFxSnapshot" ("billingDocumentId","businessId","documentCurrency","baseCurrency","fxRate","fxRateDate",
                                          "fxRateKind","fxRateSource","baseSubtotal","baseVat","baseTotal")
SELECT d."id", d."businessId", 'ILS', 'ILS', 1, (COALESCE(d."issuedAt", d."createdAt") AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Jerusalem')::date,
       'IDENTITY', 'IDENTITY', d."subtotalAmount", d."vatAmount", d."totalAmount"
  FROM "BillingDocument" d
 WHERE d."status" = 'ISSUED' AND d."currency" = 'ILS'
   AND COALESCE((SELECT s."baseCurrency" FROM "BusinessLocaleSettings" s WHERE s."businessId" = d."businessId"), 'ILS') = 'ILS'
ON CONFLICT ("billingDocumentId") DO NOTHING;
-- Non-ILS issued documents (B1 receipts, if any exist) get NO identity row: they are listed by the
-- proof and posted with the representative rate of their issue date once the accountant rules exist.


-- ════════════════════════ §C — proof queries (read-only; aggregates and booleans only) ═════════════
-- Q1 distribution
--   SELECT "currency","currencySource","baseStatus", count(*) FROM "FinancialRecord" GROUP BY 1,2,3;
--   SELECT "currency","status"::text,"baseStatus", count(*) FROM "PaymentTransaction" GROUP BY 1,2,3;
--   SELECT "currency","baseStatus", count(*) FROM "Payment" GROUP BY 1,2;
-- Q2 identity exactness (expect 0 everywhere)
--   SELECT count(*) FROM "FinancialRecord" WHERE "baseStatus"='FROZEN' AND "currency"="baseCurrency"
--     AND ("fxRate" <> 1 OR "baseAmount" <> round("amount"::numeric,2));
--   (same for PaymentTransaction / Payment with "amount")
-- Q3 per-business totals preserved (expect 0)
--   SELECT count(*) FROM (SELECT "businessId", sum(round("amount"::numeric,2)) a, sum("baseAmount") b
--     FROM "FinancialRecord" WHERE "fxRateKind"='IDENTITY' GROUP BY 1) x WHERE a <> b;
-- Q4 what was NOT posted, by reason
--   SELECT CASE WHEN abs("amount"::numeric - round("amount"::numeric,2)) >= 0.0000001 THEN 'FLOAT_INEXACT'
--               WHEN "currency" <> 'ILS' THEN 'NON_ILS' ELSE 'BASE_NOT_ILS_OR_LATE' END, count(*)
--     FROM "FinancialRecord" WHERE "baseStatus" <> 'FROZEN' GROUP BY 1;
-- Q5 suspect foreign FinancialRecords (count only in CI; ids only in an owner-run session)
--   SELECT count(*) FROM "FinancialRecord" fr JOIN "Document" d ON d."id" = fr."documentId"
--    WHERE d."ocrText" ~* '(\$|€|\mUSD\M|\mEUR\M|dollar|euro)';
-- Q6 B1 detector (expect 0): SELECT count(*) FROM "BillingDocument" WHERE "currency" <> 'ILS';
--                            SELECT count(*) FROM "PaymentTransaction" WHERE "currency" <> 'ILS';
-- Q7 (lab only) frozen guard: UPDATE "FinancialRecord" SET "baseAmount" = "baseAmount" + 1 WHERE id = <frozen> → DZ011;
--    UPDATE … SET "amount" = "amount" + 1 → DZ011; a PENDING row → FROZEN succeeds; RATE_UNAVAILABLE → PENDING → DZ011.
-- Q8 rollback: checksum of the ORIGINAL columns before apply = after §D
--   SELECT md5(string_agg(concat_ws('|',"id","amount","date","vendorName","direction","category"), ',' ORDER BY "id")) FROM "FinancialRecord";


-- ════════════════════════ §D — rollback (§A; §B has its own: DROP TABLE … ) ═══════════════════════
-- DROP TRIGGER IF EXISTS money_base_snapshot_guard ON "FinancialRecord";
-- DROP TRIGGER IF EXISTS money_base_snapshot_guard ON "PaymentTransaction";
-- DROP TRIGGER IF EXISTS money_base_snapshot_guard ON "Payment";
-- DROP FUNCTION IF EXISTS public.money_base_snapshot_guard();
-- ALTER TABLE "FinancialRecord" DROP COLUMN "currency", DROP COLUMN "currencySource", DROP COLUMN "baseCurrency",
--   DROP COLUMN "baseAmount", DROP COLUMN "fxRate", DROP COLUMN "fxRateDate", DROP COLUMN "fxRateKind",
--   DROP COLUMN "fxRateSource", DROP COLUMN "fxRateId", DROP COLUMN "baseStatus", DROP COLUMN "basePostedAt";
-- ALTER TABLE "PaymentTransaction" DROP COLUMN "baseCurrency", DROP COLUMN "baseAmount", DROP COLUMN "fxRate",
--   DROP COLUMN "fxRateDate", DROP COLUMN "fxRateKind", DROP COLUMN "fxRateSource", DROP COLUMN "fxRateId",
--   DROP COLUMN "baseStatus", DROP COLUMN "basePostedAt";
-- ALTER TABLE "Payment" (same columns as PaymentTransaction);
-- (constraints, the FK and the partial indexes go with their columns)
