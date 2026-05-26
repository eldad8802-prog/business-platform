-- Minimal DB alignment for Product Link Mode (idempotent, no data loss)
ALTER TABLE "BusinessBotSettings" ADD COLUMN IF NOT EXISTS "productLinkEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "BusinessBotSettings" ADD COLUMN IF NOT EXISTS "productLinkUrl" TEXT;
ALTER TABLE "BusinessBotSettings" ADD COLUMN IF NOT EXISTS "productLinkIntro" TEXT;
