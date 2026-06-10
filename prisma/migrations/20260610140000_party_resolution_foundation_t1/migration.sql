-- CreateEnum
CREATE TYPE "PartyRoleType" AS ENUM ('CUSTOMER', 'LEAD');

-- CreateEnum
CREATE TYPE "PartySignalType" AS ENUM ('PHONE', 'TAX_ID');

-- CreateEnum
CREATE TYPE "PartyClaimConfidence" AS ENUM ('KNOWN', 'BELIEVED', 'SUSPECTED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "PartyResolutionMethod" AS ENUM ('DETERMINISTIC_EXACT');

-- CreateEnum
CREATE TYPE "PartyClaimStatus" AS ENUM ('ACTIVE', 'CHALLENGED', 'RETRACTED');

-- CreateTable
CREATE TABLE "Party" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Party_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartyResolutionClaim" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "partyId" INTEGER NOT NULL,
    "subjectType" "PartyRoleType" NOT NULL,
    "subjectId" INTEGER NOT NULL,
    "signalType" "PartySignalType" NOT NULL,
    "signalValue" TEXT NOT NULL,
    "confidence" "PartyClaimConfidence" NOT NULL,
    "method" "PartyResolutionMethod" NOT NULL DEFAULT 'DETERMINISTIC_EXACT',
    "source" TEXT NOT NULL,
    "resolvedByUserId" INTEGER,
    "status" "PartyClaimStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartyResolutionClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Party_businessId_idx" ON "Party"("businessId");

-- CreateIndex
CREATE INDEX "PartyResolutionClaim_businessId_subjectType_subjectId_idx" ON "PartyResolutionClaim"("businessId", "subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "PartyResolutionClaim_businessId_signalType_signalValue_idx" ON "PartyResolutionClaim"("businessId", "signalType", "signalValue");

-- CreateIndex
CREATE INDEX "PartyResolutionClaim_businessId_partyId_idx" ON "PartyResolutionClaim"("businessId", "partyId");

-- CreateIndex
CREATE INDEX "PartyResolutionClaim_businessId_status_idx" ON "PartyResolutionClaim"("businessId", "status");

-- AddForeignKey
ALTER TABLE "Party" ADD CONSTRAINT "Party_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartyResolutionClaim" ADD CONSTRAINT "PartyResolutionClaim_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartyResolutionClaim" ADD CONSTRAINT "PartyResolutionClaim_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
