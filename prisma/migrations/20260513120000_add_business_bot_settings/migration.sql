-- CreateTable
CREATE TABLE "BusinessBotSettings" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "mode" TEXT NOT NULL DEFAULT 'STARTER',
    "channel" TEXT NOT NULL DEFAULT 'WHATSAPP',
    "welcomeMessage" TEXT,
    "questions" JSONB,
    "finalAction" TEXT,
    "finalActionPayload" JSONB,
    "handoffRules" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessBotSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BusinessBotSettings_businessId_key" ON "BusinessBotSettings"("businessId");

-- AddForeignKey
ALTER TABLE "BusinessBotSettings" ADD CONSTRAINT "BusinessBotSettings_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
