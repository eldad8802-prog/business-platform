-- Leads L1 · G-01b (owner decision 2026-10-28) — Lead."claimedPhone".
--
-- The phone a visitor TYPED into an anonymous website form: kept as structured data (search, call, WhatsApp,
-- repeat-enquiry lookup) but NEVER as evidence of identity. It is a separate column on purpose:
--   * "Lead".phone keeps its meaning (owner-entered or provider-verified) and its partial unique index
--     "Lead_open_phone_key" (one OPEN lead per phone) is untouched — a claimed phone never takes part in it,
--     so an anonymous enquiry can never collide with, attach to, or block an existing lead;
--   * no identity code reads it (identity resolves from "Customer" and "IdentityLink" only).
--
-- EXPAND-ONLY: one nullable column, one CHECK, one non-unique index. No default, no backfill, no row rewritten.
-- Code that does not know the column is unaffected (Prisma lists its columns explicitly).
-- The application code that writes and reads it ships in a LATER PR, after this migration is applied
-- (migration-first: scripts/ci/migration-first-guard.mjs).
--
-- PERSONAL DATA: erased with the lead and by account erasure (the follow-up PR adds it to the erasure manifest).
-- RLS: "Lead" is ENABLE + FORCE ROW LEVEL SECURITY by businessId; a new column inherits it. No grant changes.

ALTER TABLE "Lead" ADD COLUMN "claimedPhone" TEXT;

-- Only the shared phone normalizer's output: digits, a plausible length — never free text.
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_claimedPhone_digits"
  CHECK ("claimedPhone" IS NULL OR "claimedPhone" ~ '^[0-9]{8,20}$');

-- Repeat-enquiry lookup and exact search inside one business. Not unique: several enquiries may claim one phone.
CREATE INDEX "Lead_businessId_claimedPhone_idx" ON "Lead"("businessId", "claimedPhone");
