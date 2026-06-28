-- CreateTable
CREATE TABLE "BusinessBot" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "displayName" TEXT,
    "avatar" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessBot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessBotProfile" (
    "id" SERIAL NOT NULL,
    "botId" INTEGER NOT NULL,
    "voice" JSONB,
    "personality" JSONB,
    "approach" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessBotProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BusinessBot_businessId_key" ON "BusinessBot"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessBotProfile_botId_key" ON "BusinessBotProfile"("botId");

-- AddForeignKey
ALTER TABLE "BusinessBot" ADD CONSTRAINT "BusinessBot_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessBotProfile" ADD CONSTRAINT "BusinessBotProfile_botId_fkey" FOREIGN KEY ("botId") REFERENCES "BusinessBot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
