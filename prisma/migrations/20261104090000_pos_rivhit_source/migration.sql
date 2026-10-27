-- S1-A · Rivhit as a revenue source (docs/revenue-sources-s1a-rivhit.md; owner approval 2026-10-26:
-- development + a separate migration, NOT applied without a further approval).
--
-- WHAT THIS ADDS
--   pos_rivhit (feature)                 defined OFF (default false, global false). Nothing reads Rivhit for any
--                                        business until a deliberate per-business override.
--   AcquisitionConnection                widened, NOT duplicated: 'pos.rivhit' joins the one trusted
--                                        provider-resource → business mapping. The owner's Rivhit api_token and the
--                                        sync cursor live in the row's ENCRYPTED credential bundle (AES-256-GCM,
--                                        AAD-bound to the row) — the same place the WooCommerce / Wix pollers keep
--                                        theirs, so no cursor column is added. externalResourceId = the Rivhit company
--                                        id: the partial unique index already refuses one Rivhit company live on two
--                                        businesses.
--   IntakeNormalizedEvent                the route vocabulary gains 'revenue' (a sales document → the revenue truth
--                                        layer; never a Lead, never a CommerceOrder).
--
-- No table, no column, no privilege, no policy, no function changes. EXPAND-ONLY: every existing row stays valid
-- (both CHECKs are re-created wider; 'pos.rivhit' has 0 rows by construction).

-- ── 0. Preconditions — refuse a database this was not written for ─────────────

DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AcquisitionConnection_source_key')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AcquisitionConnection_source_shape') THEN
    RAISE EXCEPTION 'S1-A requires the M7-A AcquisitionConnection CHECK constraints';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'AcquisitionConnection_source_key'
       AND pg_get_constraintdef(oid) LIKE '%telephony.voicenter%'
       AND pg_get_constraintdef(oid) NOT LIKE '%pos.%'
  ) THEN
    RAISE EXCEPTION 'S1-A expects the M7-A source list (telephony.voicenter present, no pos.* source yet)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'IntakeNormalizedEvent_routeTarget_vocab')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'IntakeNormalizedEvent_routingDestination_vocab') THEN
    RAISE EXCEPTION 'S1-A requires the M3/M4 IntakeNormalizedEvent route vocabularies';
  END IF;
  IF EXISTS (SELECT 1 FROM "AcquisitionConnection" WHERE "sourceKey" LIKE 'pos.%') THEN
    RAISE EXCEPTION 'S1-A: unexpected pos.* connection rows';
  END IF;
END
$pre$;

-- ── 1. Feature (default off) ────────────────────────────────────────────────────

INSERT INTO "PlatformFeatureDefinition" ("key", "displayName", "category", "description", "defaultEnabled", "mutable", "createdAt")
VALUES ('pos_rivhit', 'מכירות מריווחית', 'integrations',
        'קריאת מסמכי מכירה וקבלות מריווחית Online לשכבת אמת ההכנסות (קריאה בלבד) — כבוי כברירת מחדל', false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "PlatformFeaturePolicy" ("featureKey", "globalEnabled", "emergencyDisabled", "updatedAt")
VALUES ('pos_rivhit', false, false, CURRENT_TIMESTAMP)
ON CONFLICT ("featureKey") DO NOTHING;

-- ── 2. AcquisitionConnection: 'pos.rivhit' ────────────────────────────────────────
--
--   pos.rivhit   externalResourceId = the Rivhit company id (Company.Details); the api_token and the sync state
--                ENCRYPTED. A credential-bearing row may lose its credential only by being REVOKED.

ALTER TABLE "AcquisitionConnection" DROP CONSTRAINT "AcquisitionConnection_source_key";
ALTER TABLE "AcquisitionConnection" ADD CONSTRAINT "AcquisitionConnection_source_key" CHECK (
  "sourceKey" IN ('meta.lead_ads', 'google.lead_form', 'web.form',
                  'commerce.woocommerce', 'commerce.wix', 'telephony.cloudtalk', 'telephony.voicenter',
                  'pos.rivhit')
);

ALTER TABLE "AcquisitionConnection" DROP CONSTRAINT "AcquisitionConnection_source_shape";
ALTER TABLE "AcquisitionConnection" ADD CONSTRAINT "AcquisitionConnection_source_shape" CHECK (
  ("sourceKey" = 'meta.lead_ads' AND "externalResourceId" IS NOT NULL AND "keyHash" IS NULL)
  OR ("sourceKey" IN ('google.lead_form', 'web.form', 'telephony.voicenter')
      AND "keyHash" IS NOT NULL AND "credentialCiphertext" IS NULL)
  OR ("sourceKey" IN ('commerce.woocommerce', 'telephony.cloudtalk')
      AND "keyHash" IS NULL AND ("credentialCiphertext" IS NOT NULL OR "status" = 'REVOKED'))
  OR ("sourceKey" IN ('commerce.wix', 'pos.rivhit') AND "externalResourceId" IS NOT NULL
      AND "keyHash" IS NULL AND ("credentialCiphertext" IS NOT NULL OR "status" = 'REVOKED'))
);

-- ── 3. IntakeNormalizedEvent: the route vocabulary gains 'revenue' ─────────────────

ALTER TABLE "IntakeNormalizedEvent" DROP CONSTRAINT "IntakeNormalizedEvent_routeTarget_vocab";
ALTER TABLE "IntakeNormalizedEvent" ADD CONSTRAINT "IntakeNormalizedEvent_routeTarget_vocab" CHECK (
  "routeTarget" IS NULL OR "routeTarget" IN
    ('conversation', 'message_status', 'lead', 'customer', 'commerce', 'call', 'revenue', 'document', 'attention', 'none')
);
ALTER TABLE "IntakeNormalizedEvent" DROP CONSTRAINT "IntakeNormalizedEvent_routingDestination_vocab";
ALTER TABLE "IntakeNormalizedEvent" ADD CONSTRAINT "IntakeNormalizedEvent_routingDestination_vocab" CHECK (
  "routingDestination" IS NULL OR "routingDestination" IN
    ('conversation', 'message_status', 'lead', 'customer', 'commerce', 'call', 'revenue', 'document', 'attention', 'none')
);
