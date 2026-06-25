-- AlterTable: activation provenance on the setup draft (off the planner path)
ALTER TABLE "BusinessBotSetupDraft" ADD COLUMN "activatedAt" TIMESTAMP(3);
ALTER TABLE "BusinessBotSetupDraft" ADD COLUMN "activationMeta" JSONB;

-- CreateTable
CREATE TABLE "BusinessBotRecommendation" (
    "id" SERIAL NOT NULL,
    "botId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "reason" TEXT NOT NULL,
    "payload" JSONB,
    "sourceGoalKey" TEXT,
    "sourceGoalVersion" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "appliedAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),

    CONSTRAINT "BusinessBotRecommendation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BusinessBotRecommendation_botId_status_idx" ON "BusinessBotRecommendation"("botId", "status");

-- CreateIndex
CREATE INDEX "BusinessBotRecommendation_botId_type_idx" ON "BusinessBotRecommendation"("botId", "type");

-- AddForeignKey
ALTER TABLE "BusinessBotRecommendation" ADD CONSTRAINT "BusinessBotRecommendation_botId_fkey" FOREIGN KEY ("botId") REFERENCES "BusinessBot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
