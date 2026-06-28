-- CreateTable
CREATE TABLE "BotGoalSelection" (
    "id" SERIAL NOT NULL,
    "botId" INTEGER NOT NULL,
    "goalKey" TEXT NOT NULL,
    "goalVersion" INTEGER NOT NULL,
    "selectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotGoalSelection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BotGoalSelection_botId_idx" ON "BotGoalSelection"("botId");

-- CreateIndex
CREATE UNIQUE INDEX "BotGoalSelection_botId_goalKey_key" ON "BotGoalSelection"("botId", "goalKey");

-- AddForeignKey
ALTER TABLE "BotGoalSelection" ADD CONSTRAINT "BotGoalSelection_botId_fkey" FOREIGN KEY ("botId") REFERENCES "BusinessBot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
