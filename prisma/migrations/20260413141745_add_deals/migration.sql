-- CreateEnum
CREATE TYPE "CollaborationDealStatus" AS ENUM ('NEW', 'ACCEPTED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "CollaborationActionType" AS ENUM ('SEND_LEAD', 'COUPON', 'REFERRAL');

-- CreateTable
CREATE TABLE "CollaborationDeal" (
    "id" TEXT NOT NULL,
    "businessId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "partnerType" TEXT NOT NULL,
    "actionType" "CollaborationActionType" NOT NULL,
    "estimatedValue" INTEGER NOT NULL,
    "status" "CollaborationDealStatus" NOT NULL DEFAULT 'NEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollaborationDeal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CollaborationDeal_businessId_idx" ON "CollaborationDeal"("businessId");

-- CreateIndex
CREATE INDEX "CollaborationDeal_status_idx" ON "CollaborationDeal"("status");

-- CreateIndex
CREATE INDEX "CollaborationDeal_businessId_status_idx" ON "CollaborationDeal"("businessId", "status");

-- AddForeignKey
ALTER TABLE "CollaborationDeal" ADD CONSTRAINT "CollaborationDeal_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
