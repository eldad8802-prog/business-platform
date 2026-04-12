-- CreateEnum
CREATE TYPE "PricingItemType" AS ENUM ('PRODUCT', 'SERVICE');

-- CreateEnum
CREATE TYPE "MarketCheckStatus" AS ENUM ('UNKNOWN', 'BELOW_MARKET', 'WITHIN_MARKET', 'ABOVE_MARKET');

-- CreateTable
CREATE TABLE "PricingProfile" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PricingItemType" NOT NULL,
    "category" TEXT,
    "defaultMaterialCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "defaultLaborMinutes" INTEGER NOT NULL DEFAULT 0,
    "defaultHourlyRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "defaultOverheadPercent" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PricingProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingCalculation" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "pricingProfileId" INTEGER,
    "inputMaterialCost" DOUBLE PRECISION NOT NULL,
    "inputLaborMinutes" INTEGER NOT NULL,
    "inputHourlyRate" DOUBLE PRECISION NOT NULL,
    "inputOverheadPercent" DOUBLE PRECISION NOT NULL,
    "laborCost" DOUBLE PRECISION NOT NULL,
    "directCost" DOUBLE PRECISION NOT NULL,
    "overheadCost" DOUBLE PRECISION NOT NULL,
    "fullCost" DOUBLE PRECISION NOT NULL,
    "minimumPrice" DOUBLE PRECISION NOT NULL,
    "recommendedPrice" DOUBLE PRECISION NOT NULL,
    "premiumPrice" DOUBLE PRECISION NOT NULL,
    "marketLow" DOUBLE PRECISION,
    "marketHigh" DOUBLE PRECISION,
    "marketStatus" "MarketCheckStatus" NOT NULL DEFAULT 'UNKNOWN',
    "explanationText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PricingCalculation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PricingProfile_businessId_idx" ON "PricingProfile"("businessId");

-- CreateIndex
CREATE INDEX "PricingProfile_businessId_isActive_idx" ON "PricingProfile"("businessId", "isActive");

-- CreateIndex
CREATE INDEX "PricingCalculation_businessId_idx" ON "PricingCalculation"("businessId");

-- CreateIndex
CREATE INDEX "PricingCalculation_pricingProfileId_idx" ON "PricingCalculation"("pricingProfileId");

-- CreateIndex
CREATE INDEX "PricingCalculation_businessId_createdAt_idx" ON "PricingCalculation"("businessId", "createdAt");

-- AddForeignKey
ALTER TABLE "PricingProfile" ADD CONSTRAINT "PricingProfile_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingCalculation" ADD CONSTRAINT "PricingCalculation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingCalculation" ADD CONSTRAINT "PricingCalculation_pricingProfileId_fkey" FOREIGN KEY ("pricingProfileId") REFERENCES "PricingProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
