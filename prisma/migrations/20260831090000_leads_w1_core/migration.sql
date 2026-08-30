-- Leads W1 — Core.
--
-- EXPAND-ONLY and zero-backfill:
--   * Every new column is NULLABLE with no default, so existing rows stay valid
--     and no data is rewritten. (Verified 2026-08-31 against the production
--     branch `prod-candidate-20260605`: "Lead" holds 0 rows.)
--   * The enum change is an ADD VALUE — additive, never a rename. The existing
--     LeadStatus vocabulary (NEW / OPEN / QUALIFIED / QUOTED / WON / LOST /
--     DROPPED) is reused AS IS; nothing is renamed or removed.
--   * No table is created or dropped. No column is dropped. No NOT NULL is added.
--
-- RLS: "Lead" already carries `p7w1_tenant` (ENABLE + FORCE ROW LEVEL SECURITY)
-- from `20260824210000_d2_p7_wave1_tenant_rls`. New columns inherit that policy
-- automatically and table-level grants already cover them, so this migration
-- deliberately touches NO policy and NO grant.

-- AlterEnum — LEAD joins the generic CRM subject vocabulary so the existing
-- Notes / Attachments engines serve leads with no new engine.
ALTER TYPE "CrmSubjectType" ADD VALUE 'LEAD';

-- AlterTable — all nullable, all consumed by W1.
ALTER TABLE "Lead" ADD COLUMN     "customerId" INTEGER,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "intentSnapshot" TEXT,
ADD COLUMN     "nextFollowUpAt" TIMESTAMP(3),
ADD COLUMN     "followUpNote" TEXT,
ADD COLUMN     "lastActivityAt" TIMESTAMP(3),
ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "lostReason" TEXT;

-- CreateIndex
CREATE INDEX "Lead_businessId_status_nextFollowUpAt_idx" ON "Lead"("businessId", "status", "nextFollowUpAt");

-- CreateIndex
CREATE INDEX "Lead_businessId_lastActivityAt_idx" ON "Lead"("businessId", "lastActivityAt");

-- CreateIndex
CREATE INDEX "Lead_businessId_customerId_idx" ON "Lead"("businessId", "customerId");

-- AddForeignKey — SetNull, so deleting a Customer never deletes commercial history.
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Duplicate protection — "at most ONE OPEN lead per phone per business".
--
-- A PARTIAL unique index, deliberately:
--   * `WHERE phone IS NOT NULL` — a lead without a phone never collides, and
--     Postgres NULL semantics would not have caught it anyway.
--   * `WHERE status NOT IN ('WON','LOST','DROPPED')` — closed leads are EXCLUDED,
--     so a business can legitimately open a NEW lead for a phone it has already
--     won or lost before. Historical closed leads are never blocked.
--   * `"businessId"` is the leading column, so a collision can only ever happen
--     INSIDE one tenant — this constraint can never leak the existence of
--     another business's lead.
--
-- Prisma cannot express partial indexes in schema.prisma, so this index is
-- raw SQL by necessity (same reason the D2/P7 RLS policies are raw SQL). It is
-- documented on the `Lead` model so it is not mistaken for drift.
CREATE UNIQUE INDEX "Lead_open_phone_key"
  ON "Lead" ("businessId", "phone")
  WHERE "phone" IS NOT NULL AND "status" NOT IN ('WON', 'LOST', 'DROPPED');
