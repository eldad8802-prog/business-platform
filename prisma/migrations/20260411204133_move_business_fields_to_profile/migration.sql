/*
  Warnings:

  - You are about to drop the column `businessType` on the `Business` table. All the data in the column will be lost.
  - You are about to drop the column `category` on the `Business` table. All the data in the column will be lost.
  - You are about to drop the column `city` on the `Business` table. All the data in the column will be lost.
  - You are about to drop the column `pricingType` on the `Business` table. All the data in the column will be lost.
  - You are about to drop the column `region` on the `Business` table. All the data in the column will be lost.
  - You are about to drop the column `subcategory` on the `Business` table. All the data in the column will be lost.
  - You are about to drop the column `toneProfile` on the `Business` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Business" DROP COLUMN "businessType",
DROP COLUMN "category",
DROP COLUMN "city",
DROP COLUMN "pricingType",
DROP COLUMN "region",
DROP COLUMN "subcategory",
DROP COLUMN "toneProfile";

-- AlterTable
ALTER TABLE "BusinessProfile" ADD COLUMN     "activityType" TEXT,
ADD COLUMN     "category" TEXT,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "region" TEXT,
ADD COLUMN     "subcategory" TEXT;

-- CreateIndex
CREATE INDEX "BusinessProfile_category_idx" ON "BusinessProfile"("category");

-- CreateIndex
CREATE INDEX "BusinessProfile_activityType_idx" ON "BusinessProfile"("activityType");

-- CreateIndex
CREATE INDEX "BusinessProfile_city_idx" ON "BusinessProfile"("city");
