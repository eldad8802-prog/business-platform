-- Payments core — per-connection document issuer and default provider.
--
-- PR-1 of the migration-first rule: this file only. No schema.prisma, no
-- runtime code; the application change (stacked on the Production Safety &
-- Shared Payment Core PR) follows once this is applied. Expand-only. No
-- backfill. Every existing row keeps exactly the meaning it has today, and
-- code that has never heard of these objects keeps working unchanged.
--
-- TWO THINGS
--
--   1. BusinessPaymentConnection.documentIssuer
--      WHO issues the tax document for a payment taken through this
--      connection. Several acquirers (CardCom, SUMIT, PayPlus, Grow) can issue
--      their own receipts; if both they and Dubiz do, one payment carries two
--      fiscal documents. The value is a business decision per connection:
--        NOT_CONFIGURED  — nobody has decided yet (every existing row)
--        DUBIZ_ISSUES    — Dubiz issues; the provider's documents are off
--        PROVIDER_ISSUES — the provider issues; Dubiz must never auto-issue
--      DEFAULT 'NOT_CONFIGURED' means every existing connection behaves
--      exactly as today. Nothing here decides for CardCom, SUMIT or anyone.
--
--   2. BusinessPaymentConnection.isDefault
--      Which of a business's ACTIVE connections a new payment link uses when
--      the caller names none. Today the system refuses that case
--      (PAYMENT_PROVIDER_REQUIRED). DEFAULT false keeps that refusal for every
--      existing business. At most one default per business — enforced by a
--      partial unique index, not by a read-then-write the database cannot see.
--
-- PRIVILEGES — BusinessPaymentConnection carries no column-scoped ACL in any
-- migration (grep: no GRANT/REVOKE naming it), so the runtime's table-level
-- SELECT/INSERT/UPDATE covers the new columns as soon as they exist. The
-- release preflight measures this in Production before apply rather than
-- assuming it. No policy changes: the table's FORCE RLS policies are
-- row-scoped and apply to the new columns unchanged.
--
-- LOCKING — ADD COLUMN with a constant DEFAULT is metadata-only on PG ≥ 11 (no
-- table rewrite). The partial unique index is built on a table holding a
-- handful of rows per business; CREATE INDEX (not CONCURRENTLY, which cannot
-- run inside the migration transaction) holds a SHARE lock for that duration.

-- ============================================================
-- 1. Who issues the document
-- ============================================================
CREATE TYPE "PaymentDocumentIssuer" AS ENUM ('NOT_CONFIGURED', 'DUBIZ_ISSUES', 'PROVIDER_ISSUES');

ALTER TABLE "BusinessPaymentConnection"
  ADD COLUMN "documentIssuer" "PaymentDocumentIssuer" NOT NULL DEFAULT 'NOT_CONFIGURED';

-- ============================================================
-- 2. The default connection
-- ============================================================
ALTER TABLE "BusinessPaymentConnection"
  ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "BusinessPaymentConnection_one_default_per_business"
  ON "BusinessPaymentConnection"("businessId")
  WHERE "isDefault" = true;
