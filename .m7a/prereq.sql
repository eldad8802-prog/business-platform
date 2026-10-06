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
