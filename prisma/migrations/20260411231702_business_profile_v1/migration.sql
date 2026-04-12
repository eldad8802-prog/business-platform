/*
  Warnings:

  - You are about to drop the column `activityType` on the `BusinessProfile` table. All the data in the column will be lost.
  - You are about to drop the column `brandVoice` on the `BusinessProfile` table. All the data in the column will be lost.
  - You are about to drop the column `city` on the `BusinessProfile` table. All the data in the column will be lost.
  - You are about to drop the column `commonObjections` on the `BusinessProfile` table. All the data in the column will be lost.
  - You are about to drop the column `commonQuestions` on the `BusinessProfile` table. All the data in the column will be lost.
  - You are about to drop the column `differentiators` on the `BusinessProfile` table. All the data in the column will be lost.
  - You are about to drop the column `goals` on the `BusinessProfile` table. All the data in the column will be lost.
  - You are about to drop the column `notes` on the `BusinessProfile` table. All the data in the column will be lost.
  - You are about to drop the column `region` on the `BusinessProfile` table. All the data in the column will be lost.
  - You are about to drop the column `salesStyle` on the `BusinessProfile` table. All the data in the column will be lost.
  - You are about to drop the column `subcategory` on the `BusinessProfile` table. All the data in the column will be lost.
  - You are about to drop the column `targetAudience` on the `BusinessProfile` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "BusinessProfile_activityType_idx";

-- DropIndex
DROP INDEX "BusinessProfile_city_idx";

-- AlterTable
ALTER TABLE "BusinessProfile" DROP COLUMN "activityType",
DROP COLUMN "brandVoice",
DROP COLUMN "city",
DROP COLUMN "commonObjections",
DROP COLUMN "commonQuestions",
DROP COLUMN "differentiators",
DROP COLUMN "goals",
DROP COLUMN "notes",
DROP COLUMN "region",
DROP COLUMN "salesStyle",
DROP COLUMN "subcategory",
DROP COLUMN "targetAudience",
ADD COLUMN     "businessModel" TEXT,
ADD COLUMN     "subCategory" TEXT;

-- CreateIndex
CREATE INDEX "BusinessProfile_subCategory_idx" ON "BusinessProfile"("subCategory");

-- CreateIndex
CREATE INDEX "BusinessProfile_businessModel_idx" ON "BusinessProfile"("businessModel");
