-- Public discovery location + hours (C1+C2) — additive, nullable, backward-compatible.
-- No semantics change, no distance computation yet (C3), no city filtering yet.
-- See docs/coupons/coupon-stage3-plan-v1.md.
ALTER TABLE "BusinessProfile" ADD COLUMN "city" TEXT;
ALTER TABLE "BusinessProfile" ADD COLUMN "latitude" DOUBLE PRECISION;
ALTER TABLE "BusinessProfile" ADD COLUMN "longitude" DOUBLE PRECISION;
ALTER TABLE "BusinessProfile" ADD COLUMN "openingHours" TEXT;
