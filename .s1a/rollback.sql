-- Rollback of 20261103090000_pos_rivhit_source — puts back exactly what the migration replaced (the M7-A source
-- list and shape, the M7-A route vocabularies) and removes the feature rows it added.
--
-- REFUSES while anything uses it: a pos.* connection (any status), a normalized intake event routed to revenue, or
-- a business override of pos_rivhit. Run as the migration role, in one transaction (psql -1). Never run without an
-- owner decision.

DO $do$
DECLARE
  n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "AcquisitionConnection" WHERE "sourceKey" LIKE 'pos.%')
       + (SELECT count(*) FROM "IntakeNormalizedEvent" WHERE "routeTarget" = 'revenue' OR "routingDestination" = 'revenue')
       + (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'pos_rivhit')
    INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'S1A rollback refused: % row(s) use pos.rivhit / revenue routing; nothing was changed', n;
  END IF;
END
$do$;

ALTER TABLE "AcquisitionConnection" DROP CONSTRAINT "AcquisitionConnection_source_key";
ALTER TABLE "AcquisitionConnection" ADD CONSTRAINT "AcquisitionConnection_source_key" CHECK (
  "sourceKey" IN ('meta.lead_ads', 'google.lead_form', 'web.form',
                  'commerce.woocommerce', 'commerce.wix', 'telephony.cloudtalk', 'telephony.voicenter')
);
ALTER TABLE "AcquisitionConnection" DROP CONSTRAINT "AcquisitionConnection_source_shape";
ALTER TABLE "AcquisitionConnection" ADD CONSTRAINT "AcquisitionConnection_source_shape" CHECK (
  ("sourceKey" = 'meta.lead_ads' AND "externalResourceId" IS NOT NULL AND "keyHash" IS NULL)
  OR ("sourceKey" IN ('google.lead_form', 'web.form', 'telephony.voicenter')
      AND "keyHash" IS NOT NULL AND "credentialCiphertext" IS NULL)
  OR ("sourceKey" IN ('commerce.woocommerce', 'telephony.cloudtalk')
      AND "keyHash" IS NULL AND ("credentialCiphertext" IS NOT NULL OR "status" = 'REVOKED'))
  OR ("sourceKey" = 'commerce.wix' AND "externalResourceId" IS NOT NULL
      AND "keyHash" IS NULL AND ("credentialCiphertext" IS NOT NULL OR "status" = 'REVOKED'))
);
ALTER TABLE "IntakeNormalizedEvent" DROP CONSTRAINT "IntakeNormalizedEvent_routeTarget_vocab";
ALTER TABLE "IntakeNormalizedEvent" ADD CONSTRAINT "IntakeNormalizedEvent_routeTarget_vocab" CHECK (
  "routeTarget" IS NULL OR "routeTarget" IN
    ('conversation', 'message_status', 'lead', 'customer', 'commerce', 'call', 'document', 'attention', 'none')
);
ALTER TABLE "IntakeNormalizedEvent" DROP CONSTRAINT "IntakeNormalizedEvent_routingDestination_vocab";
ALTER TABLE "IntakeNormalizedEvent" ADD CONSTRAINT "IntakeNormalizedEvent_routingDestination_vocab" CHECK (
  "routingDestination" IS NULL OR "routingDestination" IN
    ('conversation', 'message_status', 'lead', 'customer', 'commerce', 'call', 'document', 'attention', 'none')
);
DELETE FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'pos_rivhit';
DELETE FROM "PlatformFeatureDefinition" WHERE "key" = 'pos_rivhit';
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261103090000_pos_rivhit_source';
