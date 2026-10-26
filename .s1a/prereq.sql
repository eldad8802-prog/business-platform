-- S1-A lab: the DB-only objects 20261103090000_pos_rivhit_source replaces, exactly as Production holds them today
-- (M7-A 20261013090000 left them so; a `prisma db push` cannot create a CHECK). Idempotent: each is re-created to the
-- M7-A definition whatever the lab's earlier layers left.

ALTER TABLE "AcquisitionConnection" DROP CONSTRAINT IF EXISTS "AcquisitionConnection_source_key";
ALTER TABLE "AcquisitionConnection" ADD CONSTRAINT "AcquisitionConnection_source_key" CHECK (
  "sourceKey" IN ('meta.lead_ads', 'google.lead_form', 'web.form',
                  'commerce.woocommerce', 'commerce.wix', 'telephony.cloudtalk', 'telephony.voicenter')
);
ALTER TABLE "AcquisitionConnection" DROP CONSTRAINT IF EXISTS "AcquisitionConnection_source_shape";
ALTER TABLE "AcquisitionConnection" ADD CONSTRAINT "AcquisitionConnection_source_shape" CHECK (
  ("sourceKey" = 'meta.lead_ads' AND "externalResourceId" IS NOT NULL AND "keyHash" IS NULL)
  OR ("sourceKey" IN ('google.lead_form', 'web.form', 'telephony.voicenter')
      AND "keyHash" IS NOT NULL AND "credentialCiphertext" IS NULL)
  OR ("sourceKey" IN ('commerce.woocommerce', 'telephony.cloudtalk')
      AND "keyHash" IS NULL AND ("credentialCiphertext" IS NOT NULL OR "status" = 'REVOKED'))
  OR ("sourceKey" = 'commerce.wix' AND "externalResourceId" IS NOT NULL
      AND "keyHash" IS NULL AND ("credentialCiphertext" IS NOT NULL OR "status" = 'REVOKED'))
);
ALTER TABLE "IntakeNormalizedEvent" DROP CONSTRAINT IF EXISTS "IntakeNormalizedEvent_routeTarget_vocab";
ALTER TABLE "IntakeNormalizedEvent" ADD CONSTRAINT "IntakeNormalizedEvent_routeTarget_vocab" CHECK (
  "routeTarget" IS NULL OR "routeTarget" IN
    ('conversation', 'message_status', 'lead', 'customer', 'commerce', 'call', 'document', 'attention', 'none')
);
ALTER TABLE "IntakeNormalizedEvent" DROP CONSTRAINT IF EXISTS "IntakeNormalizedEvent_routingDestination_vocab";
ALTER TABLE "IntakeNormalizedEvent" ADD CONSTRAINT "IntakeNormalizedEvent_routingDestination_vocab" CHECK (
  "routingDestination" IS NULL OR "routingDestination" IN
    ('conversation', 'message_status', 'lead', 'customer', 'commerce', 'call', 'document', 'attention', 'none')
);
