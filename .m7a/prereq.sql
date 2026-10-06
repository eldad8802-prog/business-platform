-- M7-A labs: the DB-only objects M7-A builds on, exactly as their migrations created them in Production
-- (a `prisma db push` cannot create them). Idempotent.
--   sec-C 20260926110000   Customer / Lead (businessId, id) keys — targets of M7-A's composite tenant FKs
--   M3 20260929090000 / M4 20261001090000   the IntakeNormalizedEvent route vocabularies M7-A widens
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Customer_businessId_id_key') THEN
    ALTER TABLE "Customer" ADD CONSTRAINT "Customer_businessId_id_key" UNIQUE ("businessId", "id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Lead_businessId_id_key') THEN
    ALTER TABLE "Lead" ADD CONSTRAINT "Lead_businessId_id_key" UNIQUE ("businessId", "id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'IntakeNormalizedEvent_routeTarget_vocab') THEN
    ALTER TABLE "IntakeNormalizedEvent" ADD CONSTRAINT "IntakeNormalizedEvent_routeTarget_vocab"
      CHECK ("routeTarget" IS NULL OR "routeTarget" IN
        ('conversation', 'message_status', 'lead', 'customer', 'commerce', 'document', 'attention', 'none'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'IntakeNormalizedEvent_routingDestination_vocab') THEN
    ALTER TABLE "IntakeNormalizedEvent" ADD CONSTRAINT "IntakeNormalizedEvent_routingDestination_vocab" CHECK (
        "routingDestination" IS NULL OR "routingDestination" IN
          ('conversation', 'message_status', 'lead', 'customer', 'commerce', 'document', 'attention', 'none'));
  END IF;
END
$$;

-- P1 20260928120000: the OfferingDemandSignal CHECKs (DB-only), verbatim — the M7-B/C migration re-creates
-- OfferingDemandSignal_identity wider and refuses a database without it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OfferingDemandSignal_one_offering') THEN
    ALTER TABLE "OfferingDemandSignal" ADD CONSTRAINT "OfferingDemandSignal_one_offering" CHECK (
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
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OfferingDemandSignal_identity') THEN
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
  END IF;
END
$$;
