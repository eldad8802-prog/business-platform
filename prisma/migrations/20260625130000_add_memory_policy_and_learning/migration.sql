-- CreateTable
CREATE TABLE "BusinessBotMemoryPolicy" (
    "id" SERIAL NOT NULL,
    "botId" INTEGER NOT NULL,
    "newOrReturningCustomer" BOOLEAN NOT NULL DEFAULT false,
    "preferences" BOOLEAN NOT NULL DEFAULT false,
    "contactHistory" BOOLEAN NOT NULL DEFAULT false,
    "manualNotes" BOOLEAN NOT NULL DEFAULT false,
    "accumulatedInsights" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "lastConfiguredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessBotMemoryPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessBotLearningSuggestion" (
    "id" SERIAL NOT NULL,
    "botId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "payload" JSONB,
    "evidence" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "adoptedAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),

    CONSTRAINT "BusinessBotLearningSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BusinessBotMemoryPolicy_botId_key" ON "BusinessBotMemoryPolicy"("botId");

-- CreateIndex
CREATE INDEX "BusinessBotLearningSuggestion_botId_status_idx" ON "BusinessBotLearningSuggestion"("botId", "status");

-- AddForeignKey
ALTER TABLE "BusinessBotMemoryPolicy" ADD CONSTRAINT "BusinessBotMemoryPolicy_botId_fkey" FOREIGN KEY ("botId") REFERENCES "BusinessBot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessBotLearningSuggestion" ADD CONSTRAINT "BusinessBotLearningSuggestion_botId_fkey" FOREIGN KEY ("botId") REFERENCES "BusinessBot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
