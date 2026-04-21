/*
  Warnings:

  - The values [ISSUED] on the enum `CouponStatus` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `businessId` on the `Offer` table. All the data in the column will be lost.
  - You are about to drop the column `rewardText` on the `Offer` table. All the data in the column will be lost.
  - You are about to drop the column `status` on the `Offer` table. All the data in the column will be lost.
  - You are about to drop the column `termsText` on the `Offer` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[qrValue]` on the table `Coupon` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[couponId]` on the table `RedemptionEvent` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `updatedAt` to the `Coupon` table without a default value. This is not possible if the table is not empty.
  - Made the column `qrValue` on table `Coupon` required. This step will fail if there are existing NULL values in that column.
  - Added the required column `issuingBusinessId` to the `Offer` table without a default value. This is not possible if the table is not empty.
  - Added the required column `issuingBusinessId` to the `RedemptionEvent` table without a default value. This is not possible if the table is not empty.
  - Added the required column `redeemingBusinessId` to the `RedemptionEvent` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "public"."CouponStatus_new" AS ENUM ('ACTIVE', 'REDEEMED', 'EXPIRED', 'CANCELLED');
ALTER TABLE "public"."Coupon" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "public"."Coupon" ALTER COLUMN "status" TYPE "public"."CouponStatus_new" USING ("status"::text::"public"."CouponStatus_new");
ALTER TYPE "public"."CouponStatus" RENAME TO "CouponStatus_old";
ALTER TYPE "public"."CouponStatus_new" RENAME TO "CouponStatus";
DROP TYPE "public"."CouponStatus_old";
ALTER TABLE "public"."Coupon" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';
COMMIT;

-- DropForeignKey
ALTER TABLE "public"."Offer" DROP CONSTRAINT "Offer_businessId_fkey";

-- DropIndex
DROP INDEX "public"."Coupon_issuingBusinessId_status_idx";

-- DropIndex
DROP INDEX "public"."Coupon_offerId_status_idx";

-- DropIndex
DROP INDEX "public"."Offer_businessId_idx";

-- DropIndex
DROP INDEX "public"."Offer_businessId_status_idx";

-- DropIndex
DROP INDEX "public"."Offer_status_idx";

-- DropIndex
DROP INDEX "public"."RedemptionEvent_couponId_idx";

-- AlterTable
ALTER TABLE "public"."Coupon" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "qrValue" SET NOT NULL,
ALTER COLUMN "status" SET DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "public"."Offer" DROP COLUMN "businessId",
DROP COLUMN "rewardText",
DROP COLUMN "status",
DROP COLUMN "termsText",
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "issuingBusinessId" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "public"."RedemptionEvent" ADD COLUMN     "issuingBusinessId" INTEGER NOT NULL,
ADD COLUMN     "redeemingBusinessId" INTEGER NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Coupon_qrValue_key" ON "public"."Coupon"("qrValue");

-- CreateIndex
CREATE INDEX "Offer_issuingBusinessId_idx" ON "public"."Offer"("issuingBusinessId");

-- CreateIndex
CREATE INDEX "Offer_isActive_idx" ON "public"."Offer"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "RedemptionEvent_couponId_key" ON "public"."RedemptionEvent"("couponId");

-- CreateIndex
CREATE INDEX "RedemptionEvent_issuingBusinessId_idx" ON "public"."RedemptionEvent"("issuingBusinessId");

-- CreateIndex
CREATE INDEX "RedemptionEvent_redeemingBusinessId_idx" ON "public"."RedemptionEvent"("redeemingBusinessId");

-- CreateIndex
CREATE INDEX "RedemptionEvent_redeemedAt_idx" ON "public"."RedemptionEvent"("redeemedAt");

-- AddForeignKey
ALTER TABLE "public"."Offer" ADD CONSTRAINT "Offer_issuingBusinessId_fkey" FOREIGN KEY ("issuingBusinessId") REFERENCES "public"."Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RedemptionEvent" ADD CONSTRAINT "RedemptionEvent_issuingBusinessId_fkey" FOREIGN KEY ("issuingBusinessId") REFERENCES "public"."Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RedemptionEvent" ADD CONSTRAINT "RedemptionEvent_redeemingBusinessId_fkey" FOREIGN KEY ("redeemingBusinessId") REFERENCES "public"."Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
