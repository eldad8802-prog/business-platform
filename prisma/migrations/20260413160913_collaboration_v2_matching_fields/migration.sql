-- AlterTable
ALTER TABLE "public"."CollaborationDeal" ADD COLUMN     "matchScore" INTEGER,
ADD COLUMN     "priority" INTEGER,
ADD COLUMN     "reasonText" TEXT,
ADD COLUMN     "sourceType" TEXT;

-- CreateIndex
CREATE INDEX "CollaborationDeal_priority_idx" ON "public"."CollaborationDeal"("priority");

-- CreateIndex
CREATE INDEX "CollaborationDeal_businessId_priority_idx" ON "public"."CollaborationDeal"("businessId", "priority");
