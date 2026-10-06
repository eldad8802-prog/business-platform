-- M7-A · Commerce + Telephony foundation for Business Intake (decision record:
-- docs/business-intake-m7-decision-v1.md §7–§9, §13; owner decisions D3–D9, 2026-10-06).
--
-- WHAT THIS ADDS
--   CommerceOrder / CommerceOrderLine / CommerceOrderEvent   a store order's operational truth (never a Lead)
--   CallActivity                                              one business call (never a Lead, never an IdentityLink)
--   AcquisitionConnection                                     widened, NOT duplicated: the commerce and telephony
--                                                             providers reuse the one trusted provider-resource →
--                                                             business mapping (D6)
--   IntakeNormalizedEvent                                     the route vocabulary gains 'call'
--   m6_acquisition_resolve_resource                           also answers for a connection in ERROR, so a Meta Page
--                                                             whose token failed keeps RECEIVING leads (stored, then
--                                                             deferred until the owner reconnects) instead of having
--                                                             them acknowledged and dropped
--   four platform features                                    defined OFF (default false, global false)
--
-- INVARIANTS THE SCHEMA ITSELF HOLDS
--   * Order ≠ Lead, Call ≠ Lead: neither table has a lead-creating path; CallActivity.leadId is an evidence
--     pointer to an EXISTING lead (SET NULL), CommerceOrder has no lead column at all.
--   * No money, tax or stock: no FK to FinancialEvent / BillingDocument / Inventory*, no amount is booked.
--   * A caller's number is never stored: an unknown caller is a domain-separated sha256 (callerHash).
--   * Tenant: FORCE row-level security, per-command policies, composite (businessId, …) foreign keys to the
--     connection, the customer, the lead and the receipt — a row can only point inside its own business.
--   * CommerceOrderEvent is append-only for the runtime (SELECT + INSERT, no UPDATE, no DELETE).
--   * The runtime never DELETEs or TRUNCATEs any of the four tables.
--
-- EXPAND-ONLY for data: no existing row changes. Two CHECK constraints are re-created wider
-- (AcquisitionConnection: 0 rows in Production at the time of writing; IntakeNormalizedEvent: wider set,
-- every existing value still valid), and one function body is replaced (same signature, same grants).

-- ── 0. Preconditions — refuse a database this was not written for ─────────────

DO $pre$
BEGIN
  IF to_regclass('public."AcquisitionConnection"') IS NULL THEN
    RAISE EXCEPTION 'M7-A requires M6 (AcquisitionConnection is missing)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AcquisitionConnection_source_key')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AcquisitionConnection_source_shape') THEN
    RAISE EXCEPTION 'M7-A requires the M6 AcquisitionConnection CHECK constraints';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'IntakeNormalizedEvent_routeTarget_vocab')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'IntakeNormalizedEvent_routingDestination_vocab') THEN
    RAISE EXCEPTION 'M7-A requires the M3/M4 IntakeNormalizedEvent route vocabularies';
  END IF;
  IF to_regprocedure('public.m6_acquisition_resolve_resource(text, text)') IS NULL THEN
    RAISE EXCEPTION 'M7-A requires the M6 resource resolver';
  END IF;
  IF to_regclass('public."CommerceOrder"') IS NOT NULL OR to_regclass('public."CallActivity"') IS NOT NULL THEN
    RAISE EXCEPTION 'M7-A objects already exist';
  END IF;
END
$pre$;

-- ── 1. Features (default off) ───────────────────────────────────────────────────

INSERT INTO "PlatformFeatureDefinition" ("key", "displayName", "category", "description", "defaultEnabled", "mutable", "createdAt")
VALUES
  ('commerce_woocommerce', 'הזמנות מחנות WooCommerce', 'integrations', 'קליטת הזמנות מחנות WooCommerce של העסק — כבוי כברירת מחדל', false, true, CURRENT_TIMESTAMP),
  ('commerce_wix',         'הזמנות מחנות Wix',         'integrations', 'קליטת הזמנות מחנות Wix של העסק — כבוי כברירת מחדל', false, true, CURRENT_TIMESTAMP),
  ('telephony_cloudtalk',  'שיחות מ־CloudTalk',        'integrations', 'קליטת שיחות טלפון (נכנסות, יוצאות, שלא נענו) מ־CloudTalk — כבוי כברירת מחדל', false, true, CURRENT_TIMESTAMP),
  ('telephony_voicenter',  'שיחות מ־Voicenter',        'integrations', 'קליטת שיחות טלפון (נכנסות, יוצאות, שלא נענו) מ־Voicenter — כבוי כברירת מחדל', false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "PlatformFeaturePolicy" ("featureKey", "globalEnabled", "emergencyDisabled", "updatedAt")
VALUES
  ('commerce_woocommerce', false, false, CURRENT_TIMESTAMP),
  ('commerce_wix',         false, false, CURRENT_TIMESTAMP),
  ('telephony_cloudtalk',  false, false, CURRENT_TIMESTAMP),
  ('telephony_voicenter',  false, false, CURRENT_TIMESTAMP)
ON CONFLICT ("featureKey") DO NOTHING;

-- ── 2. AcquisitionConnection: the one provider-resource → business mapping, widened (D6) ──
--
--   commerce.woocommerce   endpoint publicId + the per-store webhook secret and REST keys, ENCRYPTED
--                          (verifying an HMAC needs the secret itself); externalResourceId = the store host
--   commerce.wix           the app instance id (externalResourceId) + the OAuth refresh token, ENCRYPTED
--   telephony.cloudtalk    endpoint publicId + the Svix signing secret, ENCRYPTED
--   telephony.voicenter    endpoint publicId + a shared URL key (sha256 hash only; Voicenter documents no
--                          signature)
-- A credential-bearing row may lose its credential only by being REVOKED (revoke / erasure wipe it).

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

-- A resource resolver that also answers for ERROR: the provider keeps delivering while the owner
-- reconnects; the receipt is stored and its processing deferred (never acknowledged-and-dropped).
-- PAUSED and REVOKED still resolve to nothing. Same signature, owner and grants.
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
     AND c."status" IN ('ACTIVE', 'ERROR')
$fn$;

-- ── 3. IntakeNormalizedEvent: the route vocabulary gains 'call' ──────────────────

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

-- ── 4. CommerceOrder — the order, as the store last reported it ──────────────────

CREATE TABLE "CommerceOrder" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "connectionId" INTEGER NOT NULL,
    "sourceKey" TEXT NOT NULL,
    -- The store's own order id (not a person). Unique per business + source.
    "externalOrderId" TEXT NOT NULL,
    -- What the store shows the owner ("#1042"). Display only.
    "orderNumber" TEXT,
    -- Set only from M4 identity (resolved, or a deterministic new Customer) or an owner-confirmed proposal.
    "customerId" INTEGER,
    "status" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    -- ISO-4217 minor units (agorot). Analytics facts — never booked money.
    "totalMinor" INTEGER NOT NULL,
    "refundedMinor" INTEGER NOT NULL DEFAULT 0,
    "lineCount" INTEGER NOT NULL DEFAULT 0,
    "placedAt" TIMESTAMP(3) NOT NULL,
    -- The provider's own modification time / sequence: a stale redelivery can never move status back.
    "providerUpdatedAt" TIMESTAMP(3) NOT NULL,
    "providerSequence" INTEGER,
    -- utm / landing page (origin + path) / referrer / click id — sanitized; erased with the account.
    "attribution" JSONB,
    "firstIntakeEventId" INTEGER NOT NULL,
    "lastIntakeEventId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommerceOrder_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CommerceOrder_source_key" CHECK ("sourceKey" IN ('commerce.woocommerce', 'commerce.wix')),
    CONSTRAINT "CommerceOrder_external_order" CHECK ("externalOrderId" ~ '^[A-Za-z0-9_.:-]{1,128}$'),
    CONSTRAINT "CommerceOrder_order_number" CHECK (
      "orderNumber" IS NULL OR ("orderNumber" !~ '[[:cntrl:]]' AND char_length("orderNumber") BETWEEN 1 AND 64)
    ),
    CONSTRAINT "CommerceOrder_status" CHECK (
      "status" IN ('placed', 'paid', 'fulfilled', 'cancelled', 'refunded', 'partially_refunded')
    ),
    CONSTRAINT "CommerceOrder_currency" CHECK ("currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "CommerceOrder_amounts" CHECK (
      "totalMinor" >= 0 AND "refundedMinor" >= 0 AND "refundedMinor" <= "totalMinor"
    ),
    CONSTRAINT "CommerceOrder_line_count" CHECK ("lineCount" BETWEEN 0 AND 500),
    CONSTRAINT "CommerceOrder_sequence" CHECK ("providerSequence" IS NULL OR "providerSequence" >= 0)
);

CREATE UNIQUE INDEX "CommerceOrder_id_businessId_key" ON "CommerceOrder"("id", "businessId");
CREATE UNIQUE INDEX "CommerceOrder_businessId_sourceKey_externalOrderId_key"
  ON "CommerceOrder"("businessId", "sourceKey", "externalOrderId");
CREATE INDEX "CommerceOrder_businessId_customerId_idx" ON "CommerceOrder"("businessId", "customerId");
CREATE INDEX "CommerceOrder_businessId_placedAt_idx" ON "CommerceOrder"("businessId", "placedAt");

ALTER TABLE "CommerceOrder" ADD CONSTRAINT "CommerceOrder_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommerceOrder" ADD CONSTRAINT "CommerceOrder_connectionId_businessId_fkey"
  FOREIGN KEY ("connectionId", "businessId") REFERENCES "AcquisitionConnection"("id", "businessId")
  ON DELETE CASCADE ON UPDATE CASCADE;
-- Composite tenant key (DB-only, like M4's): a same-business Customer only; a deleted Customer leaves the order.
ALTER TABLE "CommerceOrder" ADD CONSTRAINT "CommerceOrder_customerId_tenant_fkey"
  FOREIGN KEY ("businessId", "customerId") REFERENCES "Customer"("businessId", "id")
  ON DELETE SET NULL ("customerId") ON UPDATE NO ACTION;

-- ── 5. CommerceOrderLine — what was bought (no stock moves, D7) ───────────────────

CREATE TABLE "CommerceOrderLine" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "orderId" INTEGER NOT NULL,
    "lineKey" TEXT NOT NULL,
    "externalProductId" TEXT,
    "sku" TEXT,
    "title" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitMinor" INTEGER NOT NULL,
    "totalMinor" INTEGER NOT NULL,
    -- false when a later snapshot of the order no longer carries this line.
    "present" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommerceOrderLine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CommerceOrderLine_line_key" CHECK ("lineKey" ~ '^[A-Za-z0-9_.:-]{1,64}$'),
    CONSTRAINT "CommerceOrderLine_product" CHECK ("externalProductId" IS NULL OR "externalProductId" ~ '^[A-Za-z0-9_.:-]{1,64}$'),
    CONSTRAINT "CommerceOrderLine_sku" CHECK ("sku" IS NULL OR ("sku" !~ '[[:cntrl:]]' AND char_length("sku") BETWEEN 1 AND 64)),
    CONSTRAINT "CommerceOrderLine_title" CHECK ("title" IS NULL OR ("title" !~ '[[:cntrl:]]' AND char_length("title") BETWEEN 1 AND 200)),
    CONSTRAINT "CommerceOrderLine_amounts" CHECK (
      "quantity" BETWEEN 1 AND 100000 AND "unitMinor" >= 0 AND "totalMinor" >= 0
    )
);

CREATE UNIQUE INDEX "CommerceOrderLine_businessId_orderId_lineKey_key"
  ON "CommerceOrderLine"("businessId", "orderId", "lineKey");

ALTER TABLE "CommerceOrderLine" ADD CONSTRAINT "CommerceOrderLine_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommerceOrderLine" ADD CONSTRAINT "CommerceOrderLine_orderId_businessId_fkey"
  FOREIGN KEY ("orderId", "businessId") REFERENCES "CommerceOrder"("id", "businessId")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 6. CommerceOrderEvent — append-only history: one row per intake receipt ───────

CREATE TABLE "CommerceOrderEvent" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "orderId" INTEGER NOT NULL,
    "intakeEventId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "statusAfter" TEXT NOT NULL,
    -- false: the delivery was older than what the order already reflects (out of order) — kept, not applied.
    "applied" BOOLEAN NOT NULL,
    "providerUpdatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommerceOrderEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CommerceOrderEvent_kind" CHECK (
      "kind" IN ('created', 'updated', 'paid', 'fulfilled', 'cancelled', 'refunded', 'restored')
    ),
    CONSTRAINT "CommerceOrderEvent_status_after" CHECK (
      "statusAfter" IN ('placed', 'paid', 'fulfilled', 'cancelled', 'refunded', 'partially_refunded')
    )
);

CREATE UNIQUE INDEX "CommerceOrderEvent_businessId_intakeEventId_key"
  ON "CommerceOrderEvent"("businessId", "intakeEventId");
CREATE INDEX "CommerceOrderEvent_businessId_orderId_idx" ON "CommerceOrderEvent"("businessId", "orderId");

ALTER TABLE "CommerceOrderEvent" ADD CONSTRAINT "CommerceOrderEvent_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommerceOrderEvent" ADD CONSTRAINT "CommerceOrderEvent_orderId_businessId_fkey"
  FOREIGN KEY ("orderId", "businessId") REFERENCES "CommerceOrder"("id", "businessId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommerceOrderEvent" ADD CONSTRAINT "CommerceOrderEvent_businessId_intakeEventId_fkey"
  FOREIGN KEY ("businessId", "intakeEventId") REFERENCES "IntakeEvent"("businessId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 7. CallActivity — one business call (never a Lead; recordings never stored) ───

CREATE TABLE "CallActivity" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "connectionId" INTEGER NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "providerCallId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "durationSec" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    -- The business's own number that was dialled / dialled from (digits). Never the caller's number.
    "businessLine" TEXT,
    -- known = M4 resolved a Customer; unknown = a number nobody holds; hidden = no usable caller id.
    "callerState" TEXT NOT NULL,
    -- Unknown caller only: domain-separated sha256 of (business, number) to group repeat calls. No number.
    "callerHash" TEXT,
    "customerId" INTEGER,
    -- Evidence pointer to an EXISTING open lead of that Customer. A call never creates or moves a lead.
    "leadId" INTEGER,
    "firstIntakeEventId" INTEGER NOT NULL,
    "lastIntakeEventId" INTEGER NOT NULL,
    "providerUpdatedAt" TIMESTAMP(3) NOT NULL,
    -- A missed inbound call the business returned: a later outbound call to that caller, or (M7-C) the owner
    -- marking it handled. Lead activity after the call is read by the Secretary, never written here.
    "returnedAt" TIMESTAMP(3),
    "returnedVia" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallActivity_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CallActivity_source_key" CHECK ("sourceKey" IN ('telephony.cloudtalk', 'telephony.voicenter')),
    CONSTRAINT "CallActivity_provider_call" CHECK ("providerCallId" ~ '^[A-Za-z0-9_.:-]{1,128}$'),
    CONSTRAINT "CallActivity_direction" CHECK ("direction" IN ('inbound', 'outbound')),
    CONSTRAINT "CallActivity_outcome" CHECK (
      "outcome" IN ('answered', 'missed', 'voicemail', 'busy', 'failed', 'rejected')
    ),
    CONSTRAINT "CallActivity_duration" CHECK ("durationSec" BETWEEN 0 AND 86400),
    CONSTRAINT "CallActivity_ended" CHECK ("endedAt" IS NULL OR "endedAt" >= "startedAt"),
    CONSTRAINT "CallActivity_business_line" CHECK ("businessLine" IS NULL OR "businessLine" ~ '^[0-9]{3,20}$'),
    CONSTRAINT "CallActivity_caller_state" CHECK ("callerState" IN ('known', 'unknown', 'hidden')),
    CONSTRAINT "CallActivity_caller_hash" CHECK ("callerHash" IS NULL OR "callerHash" ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT "CallActivity_hidden_shape" CHECK (
      "callerState" <> 'hidden' OR ("callerHash" IS NULL AND "customerId" IS NULL)
    ),
    CONSTRAINT "CallActivity_returned_shape" CHECK (
      ("returnedAt" IS NULL) = ("returnedVia" IS NULL)
      AND ("returnedVia" IS NULL OR "returnedVia" IN ('outbound_call', 'owner_marked'))
    )
);

CREATE UNIQUE INDEX "CallActivity_id_businessId_key" ON "CallActivity"("id", "businessId");
CREATE UNIQUE INDEX "CallActivity_businessId_sourceKey_providerCallId_key"
  ON "CallActivity"("businessId", "sourceKey", "providerCallId");
CREATE INDEX "CallActivity_businessId_customerId_startedAt_idx" ON "CallActivity"("businessId", "customerId", "startedAt");
CREATE INDEX "CallActivity_businessId_startedAt_idx" ON "CallActivity"("businessId", "startedAt");
-- PARTIAL (raw SQL, not expressible in Prisma): repeat calls from one unknown number.
CREATE INDEX "CallActivity_unknown_caller_idx" ON "CallActivity"("businessId", "callerHash", "startedAt")
  WHERE "callerHash" IS NOT NULL;

ALTER TABLE "CallActivity" ADD CONSTRAINT "CallActivity_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallActivity" ADD CONSTRAINT "CallActivity_connectionId_businessId_fkey"
  FOREIGN KEY ("connectionId", "businessId") REFERENCES "AcquisitionConnection"("id", "businessId")
  ON DELETE CASCADE ON UPDATE CASCADE;
-- Composite tenant keys (DB-only, like M4's).
ALTER TABLE "CallActivity" ADD CONSTRAINT "CallActivity_customerId_tenant_fkey"
  FOREIGN KEY ("businessId", "customerId") REFERENCES "Customer"("businessId", "id")
  ON DELETE SET NULL ("customerId") ON UPDATE NO ACTION;
ALTER TABLE "CallActivity" ADD CONSTRAINT "CallActivity_leadId_tenant_fkey"
  FOREIGN KEY ("businessId", "leadId") REFERENCES "Lead"("businessId", "id")
  ON DELETE SET NULL ("leadId") ON UPDATE NO ACTION;

-- ── 8. Tenant isolation: FORCE RLS, per-command policies, no DELETE policy ────────
--
-- Written only inside a tenant transaction. Fail-closed: with no GUC, NULLIF yields NULL and no row
-- matches. Erasure is an UPDATE; Business deletion cascades as the table owner.

ALTER TABLE "CommerceOrder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CommerceOrder" FORCE ROW LEVEL SECURITY;
CREATE POLICY m7a_commerce_order_select ON "CommerceOrder" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY m7a_commerce_order_insert ON "CommerceOrder" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY m7a_commerce_order_update ON "CommerceOrder" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "CommerceOrderLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CommerceOrderLine" FORCE ROW LEVEL SECURITY;
CREATE POLICY m7a_commerce_order_line_select ON "CommerceOrderLine" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY m7a_commerce_order_line_insert ON "CommerceOrderLine" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY m7a_commerce_order_line_update ON "CommerceOrderLine" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "CommerceOrderEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CommerceOrderEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY m7a_commerce_order_event_select ON "CommerceOrderEvent" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY m7a_commerce_order_event_insert ON "CommerceOrderEvent" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "CallActivity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CallActivity" FORCE ROW LEVEL SECURITY;
CREATE POLICY m7a_call_activity_select ON "CallActivity" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY m7a_call_activity_insert ON "CallActivity" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY m7a_call_activity_update ON "CallActivity" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── 9. Privileges — explicit; Production's default ACL would otherwise hand the runtime DELETE ──

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON "CommerceOrder" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "CommerceOrder_id_seq" TO app_runtime;
    REVOKE DELETE, TRUNCATE ON "CommerceOrder" FROM app_runtime;

    GRANT SELECT, INSERT, UPDATE ON "CommerceOrderLine" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "CommerceOrderLine_id_seq" TO app_runtime;
    REVOKE DELETE, TRUNCATE ON "CommerceOrderLine" FROM app_runtime;

    -- Append-only for the runtime.
    GRANT SELECT, INSERT ON "CommerceOrderEvent" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "CommerceOrderEvent_id_seq" TO app_runtime;
    REVOKE UPDATE, DELETE, TRUNCATE ON "CommerceOrderEvent" FROM app_runtime;

    GRANT SELECT, INSERT, UPDATE ON "CallActivity" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "CallActivity_id_seq" TO app_runtime;
    REVOKE DELETE, TRUNCATE ON "CallActivity" FROM app_runtime;
  END IF;
END
$do$;
