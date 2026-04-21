-- AlterTable
ALTER TABLE "VendorLearning" ADD COLUMN     "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
ADD COLUMN     "isGlobal" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "VendorLearning_vendorName_idx" ON "VendorLearning"("vendorName");
