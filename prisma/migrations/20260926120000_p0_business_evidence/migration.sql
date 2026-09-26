-- P0 business evidence. Additive. Does not rewrite historical prices,
-- content choices, or coupon impressions. Existing offer semantics stay NULL
-- (unknown).
--
-- ContentVariant.businessId is the parent ContentRun's tenant. The Production
-- writer inserts a variant without that column. A BEFORE trigger copies it
-- from the run before NOT NULL is checked, and refuses a different tenant or
-- a later reassignment. The client does not get to choose a foreign business.

-- Content variant tenant key (implied today by ContentRun, now stored).
ALTER TABLE "ContentVariant" ADD COLUMN "businessId" INTEGER;

-- Backfill existing rows. Production connects as owner/BYPASSRLS, and that
-- path never touches the FORCE RLS flags. A table owner without BYPASSRLS
-- cannot see FORCE-protected rows, so the same transaction lifts FORCE only
-- while it holds the ALTER lock, restores FORCE before the block ends, and
-- rolls the whole migration back if the restore cannot happen. A role that
-- is neither owner nor BYPASSRLS fails closed.
DO $backfill$
DECLARE
  bypass boolean;
  owns_variant boolean;
  owns_run boolean;
BEGIN
  SELECT r.rolbypassrls OR r.rolsuper
    INTO bypass
  FROM pg_roles r
  WHERE r.rolname = current_user;

  SELECT pg_get_userbyid(c.relowner) = current_user
    INTO owns_variant
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'ContentVariant';

  SELECT pg_get_userbyid(c.relowner) = current_user
    INTO owns_run
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'ContentRun';

  IF bypass THEN
    UPDATE "ContentVariant" AS v
    SET "businessId" = r."businessId"
    FROM "ContentRun" AS r
    WHERE v."contentRunId" = r."id"
      AND v."businessId" IS NULL;
  ELSIF owns_variant AND owns_run THEN
    ALTER TABLE "ContentVariant" NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE "ContentRun" NO FORCE ROW LEVEL SECURITY;
    BEGIN
      UPDATE "ContentVariant" AS v
      SET "businessId" = r."businessId"
      FROM "ContentRun" AS r
      WHERE v."contentRunId" = r."id"
        AND v."businessId" IS NULL;
      ALTER TABLE "ContentRun" FORCE ROW LEVEL SECURITY;
      ALTER TABLE "ContentVariant" FORCE ROW LEVEL SECURITY;
    EXCEPTION WHEN OTHERS THEN
      ALTER TABLE "ContentRun" FORCE ROW LEVEL SECURITY;
      ALTER TABLE "ContentVariant" FORCE ROW LEVEL SECURITY;
      RAISE;
    END;
  ELSE
    RAISE EXCEPTION 'ContentVariant backfill refused: role % cannot read FORCE RLS rows', current_user;
  END IF;
END
$backfill$;

ALTER TABLE "ContentVariant" ALTER COLUMN "businessId" SET NOT NULL;

ALTER TABLE "ContentVariant"
  ADD CONSTRAINT "ContentVariant_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "ContentRun_id_businessId_key" ON "ContentRun"("id", "businessId");
CREATE UNIQUE INDEX "ContentVariant_id_businessId_key" ON "ContentVariant"("id", "businessId");
CREATE INDEX "ContentVariant_businessId_idx" ON "ContentVariant"("businessId");

ALTER TABLE "ContentEvent" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "ContentEvent_businessId_idempotencyKey_key"
  ON "ContentEvent"("businessId", "idempotencyKey");

-- Structured offer definition. Nullable so existing rows stay unknown.
ALTER TABLE "Offer" ADD COLUMN "benefitType" TEXT;
ALTER TABLE "Offer" ADD COLUMN "benefitValue" TEXT;
ALTER TABLE "Offer" ADD COLUMN "benefitScope" TEXT;
ALTER TABLE "Offer" ADD COLUMN "minPurchaseAmount" DECIMAL(18,2);
ALTER TABLE "Offer" ADD COLUMN "newCustomersOnly" BOOLEAN;

CREATE UNIQUE INDEX "Offer_id_issuingBusinessId_key" ON "Offer"("id", "issuingBusinessId");
CREATE UNIQUE INDEX "Coupon_id_issuingBusinessId_key" ON "Coupon"("id", "issuingBusinessId");

CREATE TABLE "CouponSurfaceEvent" (
  "id" SERIAL NOT NULL,
  "issuingBusinessId" INTEGER NOT NULL,
  "couponId" INTEGER NOT NULL,
  "offerId" INTEGER NOT NULL,
  "eventType" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CouponSurfaceEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CouponSurfaceEvent_issuingBusinessId_couponId_createdAt_idx"
  ON "CouponSurfaceEvent"("issuingBusinessId", "couponId", "createdAt");
CREATE INDEX "CouponSurfaceEvent_issuingBusinessId_eventType_createdAt_idx"
  ON "CouponSurfaceEvent"("issuingBusinessId", "eventType", "createdAt");

ALTER TABLE "CouponSurfaceEvent"
  ADD CONSTRAINT "CouponSurfaceEvent_issuingBusinessId_fkey"
  FOREIGN KEY ("issuingBusinessId") REFERENCES "Business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CouponSurfaceEvent"
  ADD CONSTRAINT "CouponSurfaceEvent_couponId_issuingBusinessId_fkey"
  FOREIGN KEY ("couponId", "issuingBusinessId")
  REFERENCES "Coupon"("id", "issuingBusinessId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CouponSurfaceEvent"
  ADD CONSTRAINT "CouponSurfaceEvent_offerId_issuingBusinessId_fkey"
  FOREIGN KEY ("offerId", "issuingBusinessId")
  REFERENCES "Offer"("id", "issuingBusinessId")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "InventoryItem_id_businessId_key" ON "InventoryItem"("id", "businessId");
CREATE UNIQUE INDEX "InventoryMovement_id_businessId_key" ON "InventoryMovement"("id", "businessId");

CREATE TABLE "InventorySale" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "source" TEXT NOT NULL,
  "externalSaleId" TEXT,
  "idempotencyKey" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventorySale_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InventorySale_id_businessId_key" ON "InventorySale"("id", "businessId");
CREATE UNIQUE INDEX "InventorySale_businessId_externalSaleId_key" ON "InventorySale"("businessId", "externalSaleId");
CREATE UNIQUE INDEX "InventorySale_businessId_idempotencyKey_key" ON "InventorySale"("businessId", "idempotencyKey");
CREATE INDEX "InventorySale_businessId_createdAt_idx" ON "InventorySale"("businessId", "createdAt");

ALTER TABLE "InventorySale"
  ADD CONSTRAINT "InventorySale_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "InventorySaleLine" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "saleId" INTEGER NOT NULL,
  "itemId" INTEGER NOT NULL,
  "movementId" INTEGER NOT NULL,
  "lineKey" TEXT NOT NULL,
  "quantity" DOUBLE PRECISION NOT NULL,
  "unitPrice" DECIMAL(18,2),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventorySaleLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InventorySaleLine_saleId_lineKey_key" ON "InventorySaleLine"("saleId", "lineKey");
CREATE UNIQUE INDEX "InventorySaleLine_movementId_businessId_key" ON "InventorySaleLine"("movementId", "businessId");
CREATE INDEX "InventorySaleLine_businessId_createdAt_idx" ON "InventorySaleLine"("businessId", "createdAt");

ALTER TABLE "InventorySaleLine"
  ADD CONSTRAINT "InventorySaleLine_saleId_businessId_fkey"
  FOREIGN KEY ("saleId", "businessId") REFERENCES "InventorySale"("id", "businessId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InventorySaleLine"
  ADD CONSTRAINT "InventorySaleLine_itemId_businessId_fkey"
  FOREIGN KEY ("itemId", "businessId") REFERENCES "InventoryItem"("id", "businessId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InventorySaleLine"
  ADD CONSTRAINT "InventorySaleLine_movementId_businessId_fkey"
  FOREIGN KEY ("movementId", "businessId") REFERENCES "InventoryMovement"("id", "businessId")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant guards the Prisma schema cannot express as a composite FK because
-- ContentEvent.contentRunId stays nullable.
CREATE OR REPLACE FUNCTION content_variant_same_tenant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  run_business integer;
BEGIN
  SELECT "businessId" INTO run_business FROM "ContentRun" WHERE "id" = NEW."contentRunId";
  IF run_business IS NULL THEN
    RAISE EXCEPTION 'content variant tenant mismatch';
  END IF;
  -- Omitted businessId is the Production writer's insert. Inherit the run.
  -- A supplied value must already be that same tenant.
  IF NEW."businessId" IS NULL THEN
    NEW."businessId" := run_business;
  ELSIF NEW."businessId" <> run_business THEN
    RAISE EXCEPTION 'content variant tenant mismatch';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."businessId" IS NOT NULL AND NEW."businessId" IS DISTINCT FROM OLD."businessId" THEN
    RAISE EXCEPTION 'content variant tenant reassignment';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS content_variant_same_tenant ON "ContentVariant";
CREATE TRIGGER content_variant_same_tenant
BEFORE INSERT OR UPDATE ON "ContentVariant"
FOR EACH ROW EXECUTE FUNCTION content_variant_same_tenant();

CREATE OR REPLACE FUNCTION content_event_same_tenant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_business integer;
  variant_business integer;
  variant_run integer;
BEGIN
  IF NEW."contentRunId" IS NOT NULL THEN
    SELECT "businessId" INTO run_business FROM "ContentRun" WHERE "id" = NEW."contentRunId";
    IF run_business IS NULL OR run_business <> NEW."businessId" THEN
      RAISE EXCEPTION 'content event tenant mismatch for run';
    END IF;
  END IF;

  IF NEW."contentVariantId" IS NOT NULL THEN
    SELECT "businessId", "contentRunId" INTO variant_business, variant_run
    FROM "ContentVariant" WHERE "id" = NEW."contentVariantId";
    IF variant_business IS NULL OR variant_business <> NEW."businessId" THEN
      RAISE EXCEPTION 'content event tenant mismatch for variant';
    END IF;
    IF NEW."contentRunId" IS NOT NULL AND variant_run IS DISTINCT FROM NEW."contentRunId" THEN
      RAISE EXCEPTION 'content event variant does not belong to run';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS content_event_same_tenant ON "ContentEvent";
CREATE TRIGGER content_event_same_tenant
BEFORE INSERT OR UPDATE ON "ContentEvent"
FOR EACH ROW EXECUTE FUNCTION content_event_same_tenant();
