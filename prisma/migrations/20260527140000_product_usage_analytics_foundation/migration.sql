-- AlterTable
ALTER TABLE "User" ADD COLUMN "lastLoginAt" TIMESTAMP(3),
ADD COLUMN "loginCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ProductUsageEvent" (
    "id" TEXT NOT NULL,
    "businessId" INTEGER,
    "userId" INTEGER,
    "sessionId" TEXT,
    "featureKey" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "outcome" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "durationMs" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'api',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductUsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductUsageEvent_businessId_createdAt_idx" ON "ProductUsageEvent"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "ProductUsageEvent_featureKey_createdAt_idx" ON "ProductUsageEvent"("featureKey", "createdAt");

-- CreateIndex
CREATE INDEX "ProductUsageEvent_userId_createdAt_idx" ON "ProductUsageEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ProductUsageEvent_sessionId_idx" ON "ProductUsageEvent"("sessionId");

-- CreateIndex
CREATE INDEX "ProductUsageEvent_createdAt_idx" ON "ProductUsageEvent"("createdAt");

-- AddForeignKey
ALTER TABLE "ProductUsageEvent" ADD CONSTRAINT "ProductUsageEvent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductUsageEvent" ADD CONSTRAINT "ProductUsageEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
