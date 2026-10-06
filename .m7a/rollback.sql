-- M7-A rollback — 20261013090000_m7a_commerce_telephony_foundation.
--
-- OWNER-RUN ONLY, never by the app, never by a workflow without a separate owner decision.
-- Proven in the lab (m7a-foundation-lab.yml): afterwards the preflight is whole again and the
-- post-apply proof fails exactly what M7-A creates.
--
-- SAFE ONLY WHILE NOTHING USES IT: refuses if any order, line, history row or call exists, if any
-- connection uses a commerce / telephony source, if any normalized intake row is routed to the new
-- target, or if any business was given one of the four features — a rollback never erases an
-- owner's data or decisions.
BEGIN;
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM "CommerceOrder") OR EXISTS (SELECT 1 FROM "CommerceOrderLine")
     OR EXISTS (SELECT 1 FROM "CommerceOrderEvent") OR EXISTS (SELECT 1 FROM "CallActivity") THEN
    RAISE EXCEPTION 'M7-A rollback refused: commerce / call rows exist — inspect before rolling back';
  END IF;
  IF EXISTS (SELECT 1 FROM "AcquisitionConnection"
              WHERE "sourceKey" IN ('commerce.woocommerce', 'commerce.wix', 'telephony.cloudtalk', 'telephony.voicenter')) THEN
    RAISE EXCEPTION 'M7-A rollback refused: a commerce / telephony connection exists';
  END IF;
  IF EXISTS (SELECT 1 FROM "IntakeNormalizedEvent" WHERE "routeTarget" = 'call' OR "routingDestination" = 'call') THEN
    RAISE EXCEPTION 'M7-A rollback refused: an intake event was routed to calls';
  END IF;
  IF EXISTS (SELECT 1 FROM "BusinessFeatureAccess"
              WHERE "featureKey" IN ('commerce_woocommerce', 'commerce_wix', 'telephony_cloudtalk', 'telephony_voicenter')) THEN
    RAISE EXCEPTION 'M7-A rollback refused: a business holds a commerce / telephony feature override';
  END IF;
END
$guard$;

DROP TABLE "CommerceOrderEvent";
DROP TABLE "CommerceOrderLine";
DROP TABLE "CommerceOrder";
DROP TABLE "CallActivity";

-- The M6 resolver body (ACTIVE only), exactly as 20261009090000 created it.
CREATE OR REPLACE FUNCTION public.m6_acquisition_resolve_resource(p_source_key text, p_resource_id text)
RETURNS TABLE (connection_id integer, business_id integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT c."id", c."businessId"
    FROM public."AcquisitionConnection" c
   WHERE c."sourceKey" = p_source_key
     AND c."externalResourceId" = p_resource_id
     AND c."status" = 'ACTIVE'
$fn$;

-- The M6 / M3 / M4 constraint definitions, exactly as their migrations created them.
ALTER TABLE "AcquisitionConnection" DROP CONSTRAINT "AcquisitionConnection_source_key";
ALTER TABLE "AcquisitionConnection" ADD CONSTRAINT "AcquisitionConnection_source_key" CHECK (
  "sourceKey" IN ('meta.lead_ads', 'google.lead_form', 'web.form')
);
ALTER TABLE "AcquisitionConnection" DROP CONSTRAINT "AcquisitionConnection_source_shape";
ALTER TABLE "AcquisitionConnection" ADD CONSTRAINT "AcquisitionConnection_source_shape" CHECK (
  ("sourceKey" = 'meta.lead_ads' AND "externalResourceId" IS NOT NULL AND "keyHash" IS NULL)
  OR ("sourceKey" IN ('google.lead_form', 'web.form') AND "keyHash" IS NOT NULL AND "credentialCiphertext" IS NULL)
);
ALTER TABLE "IntakeNormalizedEvent" DROP CONSTRAINT "IntakeNormalizedEvent_routeTarget_vocab";
ALTER TABLE "IntakeNormalizedEvent" ADD CONSTRAINT "IntakeNormalizedEvent_routeTarget_vocab" CHECK (
  "routeTarget" IS NULL OR "routeTarget" IN
    ('conversation', 'message_status', 'lead', 'customer', 'commerce', 'document', 'attention', 'none')
);
ALTER TABLE "IntakeNormalizedEvent" DROP CONSTRAINT "IntakeNormalizedEvent_routingDestination_vocab";
ALTER TABLE "IntakeNormalizedEvent" ADD CONSTRAINT "IntakeNormalizedEvent_routingDestination_vocab" CHECK (
  "routingDestination" IS NULL OR "routingDestination" IN
    ('conversation', 'message_status', 'lead', 'customer', 'commerce', 'document', 'attention', 'none')
);

DELETE FROM "PlatformFeaturePolicy"
 WHERE "featureKey" IN ('commerce_woocommerce', 'commerce_wix', 'telephony_cloudtalk', 'telephony_voicenter');
DELETE FROM "PlatformFeatureDefinition"
 WHERE "key" IN ('commerce_woocommerce', 'commerce_wix', 'telephony_cloudtalk', 'telephony_voicenter');
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261013090000_m7a_commerce_telephony_foundation';
COMMIT;
