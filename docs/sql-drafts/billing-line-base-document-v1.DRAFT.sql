-- ============================================================================
-- DRAFT FOR REVIEW — NOT A MIGRATION — DO NOT APPLY
--
-- billing-line-base-document-v1.DRAFT.sql
--
-- Contract: chapter 11 of docs/business-documents-unified-production-spec-v1.md (#1070), agreed by both
-- tracks (bfd2eb23). This is §11.9's data change: storing a draft line's BaseDocumentRef on
-- "BillingDocumentLine" — a protected model (A0 / G3). Schema change and migration apply are NOT approved.
--
-- What the issued invoice keeps is the frozen snapshot (JSON, no DDL): typeCode / number / date are copied
-- into the line snapshot at issue (§11.3), `source` is not (§11.2). These columns hold the DRAFT's value.
--
-- Design:
--   * five NULLable columns, no DEFAULT  → PG ≥ 11: catalog-only change, NO table rewrite;
--     ADD COLUMN takes ACCESS EXCLUSIVE on the table for the catalog update only (milliseconds).
--   * CHECKs added NOT VALID (brief ACCESS EXCLUSIVE, no scan), then VALIDATE (SHARE UPDATE EXCLUSIVE:
--     reads and writes continue). Every existing row has all five NULL, so validation cannot fail.
--   * lock_timeout bounds the wait behind a long transaction: the migration fails fast instead of queueing
--     every billing request behind its lock.
--   * Grants: unchanged. app_runtime holds table-level SELECT, INSERT, DELETE on "BillingDocumentLine"
--     (scripts/security/d2-p7-w4eb2-grants.sql:44) — table-level privileges cover new columns.
--   * RLS: unchanged (row policy p7w4eb2_tenant).
--   * Immutability: unchanged and already covering the new columns — secf_billing_child_immutable refuses
--     INSERT / UPDATE / DELETE of any line whose document is ISSUED (20260926140000, row-level).
--   * Existing rows: untouched. Every existing line keeps NULL in all five columns = "no base document",
--     which is exactly today's behaviour; issuance (code) omits the field from the snapshot when absent
--     (§11.4), so existing and new reference-less invoices stay byte-identical.
-- ============================================================================

SET lock_timeout = '3s';
SET statement_timeout = '60s';

-- 1. columns (catalog-only)
ALTER TABLE "BillingDocumentLine"
  ADD COLUMN "baseDocTypeCode"   CHAR(3)     NULL,   -- uniform structure appendix 1: 100 order, 200 delivery note, 305 tax invoice, 320 tax invoice/receipt
  ADD COLUMN "baseDocNumber"     VARCHAR(20) NULL,   -- as printed on the base document (1257 is X(20))
  ADD COLUMN "baseDocDate"       DATE        NULL,   -- the base document's date, Israel time
  ADD COLUMN "baseDocSourceKind" TEXT        NULL,   -- navigation only (§11.2); never frozen, never exported
  ADD COLUMN "baseDocSourceId"   INTEGER     NULL;   -- navigation only

-- 2. shape: all three exported fields together or none; the source pair together or none, and only with a ref
ALTER TABLE "BillingDocumentLine"
  ADD CONSTRAINT "BillingDocumentLine_baseDoc_all_or_none" CHECK (
    ("baseDocTypeCode" IS NULL AND "baseDocNumber" IS NULL AND "baseDocDate" IS NULL)
    OR ("baseDocTypeCode" IS NOT NULL AND "baseDocNumber" IS NOT NULL AND "baseDocDate" IS NOT NULL)
  ) NOT VALID;
ALTER TABLE "BillingDocumentLine"
  ADD CONSTRAINT "BillingDocumentLine_baseDoc_source_pair" CHECK (
    ("baseDocSourceKind" IS NULL) = ("baseDocSourceId" IS NULL)
    AND ("baseDocSourceKind" IS NULL OR "baseDocTypeCode" IS NOT NULL)
  ) NOT VALID;
-- 3. values: only the codes the contract allows (§11.6), a non-blank number, a sane date
ALTER TABLE "BillingDocumentLine"
  ADD CONSTRAINT "BillingDocumentLine_baseDoc_values" CHECK (
    "baseDocTypeCode" IS NULL OR (
      "baseDocTypeCode" IN ('100', '200', '305', '320')
      AND length(btrim("baseDocNumber")) BETWEEN 1 AND 20
      AND "baseDocDate" BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'
    )
  ) NOT VALID;

-- 4. validate without blocking reads / writes
ALTER TABLE "BillingDocumentLine" VALIDATE CONSTRAINT "BillingDocumentLine_baseDoc_all_or_none";
ALTER TABLE "BillingDocumentLine" VALIDATE CONSTRAINT "BillingDocumentLine_baseDoc_source_pair";
ALTER TABLE "BillingDocumentLine" VALIDATE CONSTRAINT "BillingDocumentLine_baseDoc_values";

-- 5. lookup "which invoices were closed against this base document" (navigation / duplicate warning, §11.6)
--    Built CONCURRENTLY in the real migration, outside the transaction (no write lock on the table):
--    CREATE INDEX CONCURRENTLY "BillingDocumentLine_baseDocSource_idx"
--      ON "BillingDocumentLine" ("baseDocSourceKind", "baseDocSourceId") WHERE "baseDocSourceId" IS NOT NULL;

-- ---------------------------------------------------------------- preflight (read-only, before apply)
-- P1 the five column names do not exist yet:
--    SELECT count(*) FROM information_schema.columns WHERE table_name = 'BillingDocumentLine'
--      AND column_name IN ('baseDocTypeCode','baseDocNumber','baseDocDate','baseDocSourceKind','baseDocSourceId');  -- expect 0
-- P2 no long-running transaction holds the table (the 3s lock_timeout would fail the apply):
--    SELECT count(*) FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE c.relname = 'BillingDocumentLine' AND l.granted;
-- P3 row count and table size, for the record (expected unchanged after apply): SELECT count(*) FROM "BillingDocumentLine";
-- P4 the immutability trigger and the tenant policy are present (unchanged by this change).

-- ---------------------------------------------------------------- down
-- Code rollback: the application ignores the columns (they stay NULL for drafts created after rollback).
-- Dropping the columns is allowed ONLY when no line carries a reference:
--    SELECT count(*) FROM "BillingDocumentLine" WHERE "baseDocTypeCode" IS NOT NULL;   -- must be 0
-- A reference on a line of an ISSUED document cannot be dropped anyway (the immutability trigger refuses
-- the row change); the issued document's reference lives in its frozen snapshot and is never removed.
