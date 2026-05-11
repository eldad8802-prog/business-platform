-- CreateEnum
CREATE TYPE "ContentRunStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ContentVariantStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "ContentRenderStatus" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ContentRenderProvider" AS ENUM ('CREATOMATE');

-- CreateTable
CREATE TABLE "ContentRun" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "createdByUserId" INTEGER,
    "status" "ContentRunStatus" NOT NULL DEFAULT 'PENDING',
    "inputSnapshot" JSONB NOT NULL,
    "businessContextSnapshot" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentVariant" (
    "id" SERIAL NOT NULL,
    "contentRunId" INTEGER NOT NULL,
    "variantKey" TEXT NOT NULL,
    "status" "ContentVariantStatus" NOT NULL DEFAULT 'PENDING',
    "creativeDna" JSONB NOT NULL,
    "creativeBlueprint" JSONB NOT NULL,
    "renderBlueprint" JSONB NOT NULL,
    "creativeScore" JSONB NOT NULL,
    "growthSemantics" JSONB NOT NULL,
    "llmOutput" JSONB,
    "provenance" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentRender" (
    "id" SERIAL NOT NULL,
    "contentVariantId" INTEGER NOT NULL,
    "provider" "ContentRenderProvider" NOT NULL,
    "status" "ContentRenderStatus" NOT NULL DEFAULT 'QUEUED',
    "outputUrl" TEXT,
    "thumbnailUrl" TEXT,
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "providerPayload" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentRender_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentEvent" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "contentRunId" INTEGER,
    "contentVariantId" INTEGER,
    "actorUserId" INTEGER,
    "eventType" TEXT NOT NULL,
    "payload" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContentRun_businessId_createdAt_idx" ON "ContentRun"("businessId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ContentVariant_contentRunId_variantKey_key" ON "ContentVariant"("contentRunId", "variantKey");

-- CreateIndex
CREATE INDEX "ContentRender_contentVariantId_createdAt_idx" ON "ContentRender"("contentVariantId", "createdAt");

-- CreateIndex
CREATE INDEX "ContentEvent_businessId_createdAt_idx" ON "ContentEvent"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "ContentEvent_contentRunId_createdAt_idx" ON "ContentEvent"("contentRunId", "createdAt");

-- CreateIndex
CREATE INDEX "ContentEvent_contentVariantId_createdAt_idx" ON "ContentEvent"("contentVariantId", "createdAt");

-- AddForeignKey
ALTER TABLE "ContentRun" ADD CONSTRAINT "ContentRun_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentRun" ADD CONSTRAINT "ContentRun_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentVariant" ADD CONSTRAINT "ContentVariant_contentRunId_fkey" FOREIGN KEY ("contentRunId") REFERENCES "ContentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentRender" ADD CONSTRAINT "ContentRender_contentVariantId_fkey" FOREIGN KEY ("contentVariantId") REFERENCES "ContentVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentEvent" ADD CONSTRAINT "ContentEvent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentEvent" ADD CONSTRAINT "ContentEvent_contentRunId_fkey" FOREIGN KEY ("contentRunId") REFERENCES "ContentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentEvent" ADD CONSTRAINT "ContentEvent_contentVariantId_fkey" FOREIGN KEY ("contentVariantId") REFERENCES "ContentVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentEvent" ADD CONSTRAINT "ContentEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
