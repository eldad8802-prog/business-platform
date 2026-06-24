-- CreateTable
CREATE TABLE "BusinessBotSetupDraft" (
    "id" SERIAL NOT NULL,
    "botId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "currentStep" INTEGER NOT NULL DEFAULT 0,
    "selectedGoalKeys" JSONB,
    "assembledBase" JSONB,
    "assembledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessBotSetupDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessBotKnowledge" (
    "id" SERIAL NOT NULL,
    "botId" INTEGER NOT NULL,
    "hours" TEXT,
    "address" TEXT,
    "notes" TEXT,
    "faq" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessBotKnowledge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BusinessBotSetupDraft_botId_key" ON "BusinessBotSetupDraft"("botId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessBotKnowledge_botId_key" ON "BusinessBotKnowledge"("botId");

-- AddForeignKey
ALTER TABLE "BusinessBotSetupDraft" ADD CONSTRAINT "BusinessBotSetupDraft_botId_fkey" FOREIGN KEY ("botId") REFERENCES "BusinessBot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessBotKnowledge" ADD CONSTRAINT "BusinessBotKnowledge_botId_fkey" FOREIGN KEY ("botId") REFERENCES "BusinessBot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
