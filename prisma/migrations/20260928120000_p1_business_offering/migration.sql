-- P1 business offering foundation.
-- Additive. Existing service, product, and appointment rows keep unknown
-- price mode, unknown description, and no service link. basePrice is not
-- rewritten into a public price. featuredByOwner defaults to false, which
-- means the owner has not emphasized the offering. It is not a demand score.

CREATE TYPE "ServicePriceMode" AS ENUM ('FIXED', 'FROM', 'RANGE', 'QUOTE_REQUIRED', 'NO_PUBLIC_PRICE');
CREATE TYPE "ServiceFulfillment" AS ENUM ('AT_BUSINESS', 'AT_CUSTOMER', 'ONLINE', 'UNSPECIFIED');
CREATE TYPE "OfferingKind" AS ENUM ('PRODUCT', 'SERVICE');
CREATE TYPE "OfferingDemandSignalType" AS ENUM ('PRICE', 'AVAILABILITY', 'BOOKING', 'PURCHASE');
CREATE TYPE "OfferingDemandSource" AS ENUM ('APPOINTMENT', 'SALE');

ALTER TABLE "BusinessService"
  ADD COLUMN "priceMode" "ServicePriceMode",
  ADD COLUMN "priceAmount" DECIMAL(18,2),
  ADD COLUMN "priceMax" DECIMAL(18,2),
  ADD COLUMN "durationMinutes" INTEGER,
  ADD COLUMN "categoryLabel" TEXT,
  ADD COLUMN "featuredByOwner" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "fulfillment" "ServiceFulfillment" NOT NULL DEFAULT 'UNSPECIFIED';

ALTER TABLE "BusinessService"
  ADD CONSTRAINT "BusinessService_price_semantics" CHECK (
    ("priceMode" IS NULL AND "priceAmount" IS NULL AND "priceMax" IS NULL)
    OR ("priceMode" = 'FIXED' AND "priceAmount" IS NOT NULL AND "priceMax" IS NULL AND "priceAmount" >= 0)
    OR ("priceMode" = 'FROM' AND "priceAmount" IS NOT NULL AND "priceMax" IS NULL AND "priceAmount" >= 0)
    OR ("priceMode" = 'RANGE' AND "priceAmount" IS NOT NULL AND "priceMax" IS NOT NULL AND "priceAmount" >= 0 AND "priceMax" >= "priceAmount")
    OR ("priceMode" IN ('QUOTE_REQUIRED', 'NO_PUBLIC_PRICE') AND "priceAmount" IS NULL AND "priceMax" IS NULL)
  );

ALTER TABLE "BusinessService"
  ADD CONSTRAINT "BusinessService_duration_positive" CHECK (
    "durationMinutes" IS NULL OR "durationMinutes" > 0
  );

ALTER TABLE "BusinessService"
  ADD CONSTRAINT "BusinessService_category_label" CHECK (
    "categoryLabel" IS NULL OR char_length("categoryLabel") BETWEEN 1 AND 80
  );

CREATE UNIQUE INDEX "BusinessService_id_businessId_key" ON "BusinessService"("id", "businessId");
CREATE INDEX "BusinessService_businessId_active_idx" ON "BusinessService"("businessId", "active");

ALTER TABLE "InventoryItem"
  ADD COLUMN "description" TEXT,
  ADD COLUMN "featuredByOwner" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "BusinessAsset_id_businessId_key" ON "BusinessAsset"("id", "businessId");

ALTER TABLE "Appointment" ADD COLUMN "businessServiceId" INTEGER;

CREATE UNIQUE INDEX "Appointment_id_businessId_key" ON "Appointment"("id", "businessId");

ALTER TABLE "Appointment"
  ADD CONSTRAINT "Appointment_businessServiceId_businessId_fkey"
  FOREIGN KEY ("businessServiceId", "businessId")
  REFERENCES "BusinessService"("id", "businessId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "BusinessServiceAsset" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "businessServiceId" INTEGER NOT NULL,
  "businessAssetId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BusinessServiceAsset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BusinessServiceAsset_businessServiceId_businessAssetId_key"
  ON "BusinessServiceAsset"("businessServiceId", "businessAssetId");
CREATE INDEX "BusinessServiceAsset_businessId_idx" ON "BusinessServiceAsset"("businessId");

ALTER TABLE "BusinessServiceAsset"
  ADD CONSTRAINT "BusinessServiceAsset_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BusinessServiceAsset"
  ADD CONSTRAINT "BusinessServiceAsset_businessServiceId_businessId_fkey"
  FOREIGN KEY ("businessServiceId", "businessId")
  REFERENCES "BusinessService"("id", "businessId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BusinessServiceAsset"
  ADD CONSTRAINT "BusinessServiceAsset_businessAssetId_businessId_fkey"
  FOREIGN KEY ("businessAssetId", "businessId")
  REFERENCES "BusinessAsset"("id", "businessId") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "InventoryItemAsset" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "inventoryItemId" INTEGER NOT NULL,
  "businessAssetId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventoryItemAsset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InventoryItemAsset_inventoryItemId_businessAssetId_key"
  ON "InventoryItemAsset"("inventoryItemId", "businessAssetId");
CREATE INDEX "InventoryItemAsset_businessId_idx" ON "InventoryItemAsset"("businessId");

ALTER TABLE "InventoryItemAsset"
  ADD CONSTRAINT "InventoryItemAsset_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InventoryItemAsset"
  ADD CONSTRAINT "InventoryItemAsset_inventoryItemId_businessId_fkey"
  FOREIGN KEY ("inventoryItemId", "businessId")
  REFERENCES "InventoryItem"("id", "businessId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InventoryItemAsset"
  ADD CONSTRAINT "InventoryItemAsset_businessAssetId_businessId_fkey"
  FOREIGN KEY ("businessAssetId", "businessId")
  REFERENCES "BusinessAsset"("id", "businessId") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "OfferingDemandSignal" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "offeringKind" "OfferingKind" NOT NULL,
  "businessServiceId" INTEGER,
  "inventoryItemId" INTEGER,
  "appointmentId" INTEGER,
  "saleLineId" INTEGER,
  "signalType" "OfferingDemandSignalType" NOT NULL,
  "source" "OfferingDemandSource" NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OfferingDemandSignal_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OfferingDemandSignal_one_offering" CHECK (
    (
      "offeringKind" = 'SERVICE'
      AND "businessServiceId" IS NOT NULL
      AND "inventoryItemId" IS NULL
    )
    OR (
      "offeringKind" = 'PRODUCT'
      AND "inventoryItemId" IS NOT NULL
      AND "businessServiceId" IS NULL
    )
  ),
  CONSTRAINT "OfferingDemandSignal_identity" CHECK (
    (
      "signalType" = 'BOOKING'
      AND "source" = 'APPOINTMENT'
      AND "appointmentId" IS NOT NULL
      AND "saleLineId" IS NULL
      AND "offeringKind" = 'SERVICE'
    )
    OR (
      "signalType" = 'PURCHASE'
      AND "source" = 'SALE'
      AND "saleLineId" IS NOT NULL
      AND "appointmentId" IS NULL
      AND "offeringKind" = 'PRODUCT'
    )
    OR (
      "signalType" IN ('PRICE', 'AVAILABILITY')
      AND "appointmentId" IS NULL
      AND "saleLineId" IS NULL
    )
  )
);

CREATE UNIQUE INDEX "OfferingDemandSignal_businessId_idempotencyKey_key"
  ON "OfferingDemandSignal"("businessId", "idempotencyKey");

CREATE INDEX "OfferingDemandSignal_businessId_offeringKind_createdAt_idx"
  ON "OfferingDemandSignal"("businessId", "offeringKind", "createdAt");
CREATE INDEX "OfferingDemandSignal_businessId_businessServiceId_idx"
  ON "OfferingDemandSignal"("businessId", "businessServiceId");
CREATE INDEX "OfferingDemandSignal_businessId_inventoryItemId_idx"
  ON "OfferingDemandSignal"("businessId", "inventoryItemId");

ALTER TABLE "OfferingDemandSignal"
  ADD CONSTRAINT "OfferingDemandSignal_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OfferingDemandSignal"
  ADD CONSTRAINT "OfferingDemandSignal_businessServiceId_businessId_fkey"
  FOREIGN KEY ("businessServiceId", "businessId")
  REFERENCES "BusinessService"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OfferingDemandSignal"
  ADD CONSTRAINT "OfferingDemandSignal_inventoryItemId_businessId_fkey"
  FOREIGN KEY ("inventoryItemId", "businessId")
  REFERENCES "InventoryItem"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OfferingDemandSignal"
  ADD CONSTRAINT "OfferingDemandSignal_appointmentId_businessId_fkey"
  FOREIGN KEY ("appointmentId", "businessId")
  REFERENCES "Appointment"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OfferingDemandSignal"
  ADD CONSTRAINT "OfferingDemandSignal_saleLineId_businessId_fkey"
  FOREIGN KEY ("saleLineId", "businessId")
  REFERENCES "InventorySaleLine"("id", "businessId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Tenant isolation for the new tables. Existing BusinessService, InventoryItem,
-- Appointment, and BusinessAsset policies already cover their new columns.
-- Per-command policies only. No DELETE policy: catalog links and demand facts
-- are not deleted through the runtime role.

ALTER TABLE "BusinessServiceAsset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessServiceAsset" FORCE ROW LEVEL SECURITY;
CREATE POLICY p1_service_asset_select ON "BusinessServiceAsset" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY p1_service_asset_insert ON "BusinessServiceAsset" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY p1_service_asset_update ON "BusinessServiceAsset" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "InventoryItemAsset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InventoryItemAsset" FORCE ROW LEVEL SECURITY;
CREATE POLICY p1_item_asset_select ON "InventoryItemAsset" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY p1_item_asset_insert ON "InventoryItemAsset" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY p1_item_asset_update ON "InventoryItemAsset" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "OfferingDemandSignal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OfferingDemandSignal" FORCE ROW LEVEL SECURITY;
CREATE POLICY p1_offering_demand_select ON "OfferingDemandSignal" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY p1_offering_demand_insert ON "OfferingDemandSignal" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY p1_offering_demand_update ON "OfferingDemandSignal" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON "BusinessServiceAsset" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "BusinessServiceAsset_id_seq" TO app_runtime;
    REVOKE DELETE, TRUNCATE ON "BusinessServiceAsset" FROM app_runtime;

    GRANT SELECT, INSERT, UPDATE ON "InventoryItemAsset" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "InventoryItemAsset_id_seq" TO app_runtime;
    REVOKE DELETE, TRUNCATE ON "InventoryItemAsset" FROM app_runtime;

    GRANT SELECT, INSERT, UPDATE ON "OfferingDemandSignal" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "OfferingDemandSignal_id_seq" TO app_runtime;
    REVOKE DELETE, TRUNCATE ON "OfferingDemandSignal" FROM app_runtime;
  END IF;
END
$do$;
