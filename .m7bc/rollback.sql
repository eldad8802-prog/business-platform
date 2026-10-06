-- M7-B/C — rollback of 20261014090000_m7bc_commerce_demand_and_line_labels (owner-approved only; one transaction).
--
-- REFUSED while anything uses what it added: a COMMERCE demand signal, or a connection with line labels —
-- those are the owner's data and a rollback must never silently drop them. Otherwise it restores the exact
-- P1 / M7-A state: the P1 identity CHECK verbatim, OfferingDemandSource without COMMERCE (the type is rebuilt —
-- PostgreSQL cannot drop an enum value), no store-line column / FK / key, no lineLabels, and the ledger row
-- removed so the preflight is whole again.
BEGIN;

DO $guard$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "OfferingDemandSignal" WHERE "source"::text = 'COMMERCE')
       + (SELECT count(*) FROM "AcquisitionConnection" WHERE "lineLabels" IS NOT NULL) INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'rollback refused: % row(s) use the M7-B/C demand / line-label paths', n;
  END IF;
END
$guard$;

ALTER TABLE "AcquisitionConnection" DROP CONSTRAINT IF EXISTS "AcquisitionConnection_line_labels";
ALTER TABLE "AcquisitionConnection" DROP COLUMN IF EXISTS "lineLabels";

ALTER TABLE "OfferingDemandSignal" DROP CONSTRAINT IF EXISTS "OfferingDemandSignal_identity";
ALTER TABLE "OfferingDemandSignal" DROP CONSTRAINT IF EXISTS "OfferingDemandSignal_commerceOrderLineId_businessId_fkey";
DROP INDEX IF EXISTS "OfferingDemandSignal_businessId_commerceOrderLineId_idx";
ALTER TABLE "OfferingDemandSignal" DROP COLUMN IF EXISTS "commerceOrderLineId";
DROP INDEX IF EXISTS "CommerceOrderLine_id_businessId_key";

ALTER TYPE "OfferingDemandSource" RENAME TO "OfferingDemandSource_m7bc";
CREATE TYPE "OfferingDemandSource" AS ENUM ('APPOINTMENT', 'SALE');
ALTER TABLE "OfferingDemandSignal" ALTER COLUMN "source" TYPE "OfferingDemandSource" USING "source"::text::"OfferingDemandSource";
DROP TYPE "OfferingDemandSource_m7bc";

ALTER TABLE "OfferingDemandSignal" ADD CONSTRAINT "OfferingDemandSignal_identity" CHECK (
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
);

DELETE FROM "_prisma_migrations" WHERE migration_name = '20261014090000_m7bc_commerce_demand_and_line_labels';

COMMIT;
