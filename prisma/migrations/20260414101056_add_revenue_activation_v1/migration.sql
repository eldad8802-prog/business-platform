-- CreateEnum
CREATE TYPE "public"."OfferStatus" AS ENUM ('ACTIVE', 'PAUSED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "public"."CouponStatus" AS ENUM ('ISSUED', 'REDEEMED', 'EXPIRED', 'CANCELLED');

-- CreateTable
CREATE TABLE "public"."Offer" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "customerBenefitText" TEXT NOT NULL,
    "rewardText" TEXT,
    "termsText" TEXT,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "status" "public"."OfferStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Offer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Coupon" (
    "id" SERIAL NOT NULL,
    "offerId" INTEGER NOT NULL,
    "issuingBusinessId" INTEGER NOT NULL,
    "token" TEXT NOT NULL,
    "qrValue" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" "public"."CouponStatus" NOT NULL DEFAULT 'ISSUED',
    "redeemedAt" TIMESTAMP(3),

    CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RedemptionEvent" (
    "id" SERIAL NOT NULL,
    "couponId" INTEGER NOT NULL,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RedemptionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Offer_businessId_idx" ON "public"."Offer"("businessId");

-- CreateIndex
CREATE INDEX "Offer_status_idx" ON "public"."Offer"("status");

-- CreateIndex
CREATE INDEX "Offer_validUntil_idx" ON "public"."Offer"("validUntil");

-- CreateIndex
CREATE INDEX "Offer_businessId_status_idx" ON "public"."Offer"("businessId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Coupon_token_key" ON "public"."Coupon"("token");

-- CreateIndex
CREATE INDEX "Coupon_offerId_idx" ON "public"."Coupon"("offerId");

-- CreateIndex
CREATE INDEX "Coupon_issuingBusinessId_idx" ON "public"."Coupon"("issuingBusinessId");

-- CreateIndex
CREATE INDEX "Coupon_status_idx" ON "public"."Coupon"("status");

-- CreateIndex
CREATE INDEX "Coupon_expiresAt_idx" ON "public"."Coupon"("expiresAt");

-- CreateIndex
CREATE INDEX "Coupon_offerId_status_idx" ON "public"."Coupon"("offerId", "status");

-- CreateIndex
CREATE INDEX "Coupon_issuingBusinessId_status_idx" ON "public"."Coupon"("issuingBusinessId", "status");

-- CreateIndex
CREATE INDEX "RedemptionEvent_couponId_idx" ON "public"."RedemptionEvent"("couponId");

-- AddForeignKey
ALTER TABLE "public"."Offer" ADD CONSTRAINT "Offer_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "public"."Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Coupon" ADD CONSTRAINT "Coupon_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "public"."Offer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Coupon" ADD CONSTRAINT "Coupon_issuingBusinessId_fkey" FOREIGN KEY ("issuingBusinessId") REFERENCES "public"."Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RedemptionEvent" ADD CONSTRAINT "RedemptionEvent_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "public"."Coupon"("id") ON DELETE CASCADE ON UPDATE CASCADE;
