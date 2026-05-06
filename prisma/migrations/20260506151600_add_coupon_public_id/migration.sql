-- Add a non-guessable public identifier for public coupon flow.
-- We use UUID at the DB level to guarantee uniqueness and avoid enumeration.

-- 1) Add column (nullable first)
ALTER TABLE "Coupon" ADD COLUMN "publicId" UUID;

-- 2) Backfill existing rows
UPDATE "Coupon"
SET "publicId" = gen_random_uuid()
WHERE "publicId" IS NULL;

-- 3) Enforce required + uniqueness + default for future inserts
ALTER TABLE "Coupon" ALTER COLUMN "publicId" SET NOT NULL;
ALTER TABLE "Coupon" ALTER COLUMN "publicId" SET DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX "Coupon_publicId_key" ON "Coupon"("publicId");

