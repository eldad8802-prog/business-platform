-- Product Link Mode v1 (BusinessBotSettings)
ALTER TABLE "BusinessBotSettings" ADD COLUMN "productLinkEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "BusinessBotSettings" ADD COLUMN "productLinkUrl" TEXT;
ALTER TABLE "BusinessBotSettings" ADD COLUMN "productLinkIntro" TEXT;
