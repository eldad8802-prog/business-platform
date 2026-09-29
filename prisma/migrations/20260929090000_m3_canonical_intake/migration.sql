-- Business Intake M3 · the canonical intake foundation.
--
-- WHY
-- M2 made IntakeEvent the durable receipt that Dubiz answers a provider only
-- after. But its identity was WhatsApp-shaped: `provider` is an ENUM with one
-- value and `kind` an enum of two WhatsApp event kinds. Every new source (Meta
-- Lead Ads, Google Lead Forms, telephony, commerce, partner feeds) would need a
-- migration just to exist, and there was nowhere to keep what Dubiz UNDERSTOOD
-- from an event separately from what the provider SENT.
--
-- WHAT THIS ADDS
--   1. A provider-neutral receipt identity on IntakeEvent:
--        sourceKey    TEXT   registry key of the adapter ("whatsapp", later
--                            "meta.lead_ads", …) — a new source is code, not DDL
--        family       ENUM   the stable business meaning (MESSAGE, LEAD, …)
--        eventType    TEXT   the adapter's own finer type ("message.status")
--        dedupeBasis  TEXT   how externalEventId was derived — provider id or a
--                            content fingerprint; never an accidental guess
--        lastStage    TEXT   how far processing got (normalized / routed / …)
--      and replay protection on (businessId, sourceKey, externalEventId).
--   2. IntakeNormalizedEvent — what Dubiz understood from ONE receipt:
--      contact hints (PII, purgeable), non-personal identity signals, the
--      identity outcome (M3 never merges identities), structured attribution,
--      and the routing decision + domain result refs. The receipt stays
--      evidence; the domain records (Customer / Conversation / Message / Lead)
--      stay the operational truth. Three layers, three homes.
--
-- COMPATIBILITY WITH THE CODE STILL RUNNING (migration-first)
-- The M2 code keeps inserting receipts with provider/kind and without the new
-- columns until the next deploy. `intake_event_m3_fill` (BEFORE INSERT) derives
-- sourceKey / family / eventType from provider / kind when they are absent, so
-- those inserts satisfy the new NOT NULL columns. provider and kind become
-- NULLable (the M2 code always sets them; new sources leave them null). The M2
-- unique index stays, so M2's ON CONFLICT DO NOTHING keeps working unchanged.
-- A later contract migration may drop the trigger and the legacy columns.
--
-- EXPAND-ONLY. One enum, five columns + two relaxed NOT NULLs + one backfill on
-- IntakeEvent, one trigger, one table, indexes, keys, RLS, policies, grants.
-- The backfill writes only the new columns of existing IntakeEvent rows.

-- ── IntakeEvent: provider-neutral identity ─────────────────────────────────

CREATE TYPE "IntakeEventFamily" AS ENUM (
  'MESSAGE',
  'LEAD',
  'FORM_SUBMISSION',
  'CALL',
  'COMMERCE',
  'EMAIL',
  'DOCUMENT',
  'CUSTOM'
);

ALTER TABLE "IntakeEvent"
  ADD COLUMN "sourceKey"   TEXT,
  ADD COLUMN "family"      "IntakeEventFamily",
  ADD COLUMN "eventType"   TEXT,
  ADD COLUMN "dedupeBasis" TEXT NOT NULL DEFAULT 'provider_event_id',
  ADD COLUMN "lastStage"   TEXT;

-- Backfill: every existing receipt is a WhatsApp one (the only M2 source).
-- Same pattern as 20260926120000_p0_business_evidence: Production migrates as
-- owner/BYPASSRLS and never touches FORCE. A table owner without BYPASSRLS
-- cannot see FORCE-protected rows, so the transaction lifts FORCE only while it
-- holds the ALTER lock and restores it before the block ends (or rolls the whole
-- migration back). A role that is neither fails closed.
DO $backfill$
DECLARE
  bypass boolean;
  owns_intake boolean;
BEGIN
  SELECT r.rolbypassrls OR r.rolsuper INTO bypass
  FROM pg_roles r WHERE r.rolname = current_user;

  SELECT pg_get_userbyid(c.relowner) = current_user INTO owns_intake
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'IntakeEvent';

  IF bypass THEN
    UPDATE "IntakeEvent"
    SET "sourceKey" = 'whatsapp',
        "family"    = 'MESSAGE',
        "eventType" = CASE "kind" WHEN 'MESSAGE_STATUS' THEN 'message.status' ELSE 'message.received' END
    WHERE "sourceKey" IS NULL;
  ELSIF owns_intake THEN
    ALTER TABLE "IntakeEvent" NO FORCE ROW LEVEL SECURITY;
    BEGIN
      UPDATE "IntakeEvent"
      SET "sourceKey" = 'whatsapp',
          "family"    = 'MESSAGE',
          "eventType" = CASE "kind" WHEN 'MESSAGE_STATUS' THEN 'message.status' ELSE 'message.received' END
      WHERE "sourceKey" IS NULL;
      ALTER TABLE "IntakeEvent" FORCE ROW LEVEL SECURITY;
    EXCEPTION WHEN OTHERS THEN
      ALTER TABLE "IntakeEvent" FORCE ROW LEVEL SECURITY;
      RAISE;
    END;
  ELSE
    RAISE EXCEPTION 'IntakeEvent backfill refused: role % cannot read FORCE RLS rows', current_user;
  END IF;
END
$backfill$;

-- Legacy inserts (M2 code, until the next deploy) name provider/kind only.
CREATE FUNCTION intake_event_m3_fill() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW."sourceKey" IS NULL AND NEW."provider" = 'WHATSAPP' THEN
    NEW."sourceKey" := 'whatsapp';
  END IF;
  IF NEW."family" IS NULL AND NEW."kind" IS NOT NULL THEN
    NEW."family" := 'MESSAGE';
  END IF;
  IF NEW."eventType" IS NULL AND NEW."kind" IS NOT NULL THEN
    NEW."eventType" := CASE NEW."kind"
                         WHEN 'MESSAGE_STATUS' THEN 'message.status'
                         ELSE 'message.received'
                       END;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER intake_event_m3_fill
  BEFORE INSERT ON "IntakeEvent"
  FOR EACH ROW EXECUTE FUNCTION intake_event_m3_fill();

ALTER TABLE "IntakeEvent"
  ALTER COLUMN "sourceKey" SET NOT NULL,
  ALTER COLUMN "family"    SET NOT NULL,
  ALTER COLUMN "eventType" SET NOT NULL,
  ALTER COLUMN "provider"  DROP NOT NULL,
  ALTER COLUMN "kind"      DROP NOT NULL;

-- Vocabulary guards. A source key is a registry identifier, never free text;
-- the legacy enum can only ever describe the WhatsApp source.
ALTER TABLE "IntakeEvent"
  ADD CONSTRAINT "IntakeEvent_sourceKey_format"
    CHECK ("sourceKey" ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$' AND length("sourceKey") <= 64),
  ADD CONSTRAINT "IntakeEvent_eventType_format"
    CHECK ("eventType" ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$' AND length("eventType") <= 64),
  ADD CONSTRAINT "IntakeEvent_dedupeBasis_vocab"
    CHECK ("dedupeBasis" IN ('provider_event_id', 'content_fingerprint')),
  ADD CONSTRAINT "IntakeEvent_lastStage_vocab"
    CHECK ("lastStage" IS NULL OR "lastStage" IN ('received', 'normalized', 'routed', 'completed')),
  ADD CONSTRAINT "IntakeEvent_legacy_provider_matches_source"
    CHECK ("provider" IS NULL OR ("provider" = 'WHATSAPP' AND "sourceKey" = 'whatsapp'));

-- Provider-neutral replay protection: one receipt per (business, source, event
-- identity). Tenant-scoped and source-scoped: the same provider id from two
-- businesses, or from two sources, never cross-dedups.
CREATE UNIQUE INDEX "IntakeEvent_businessId_sourceKey_externalEventId_key"
  ON "IntakeEvent"("businessId", "sourceKey", "externalEventId");

-- Target of the composite tenant key below.
CREATE UNIQUE INDEX "IntakeEvent_businessId_id_key" ON "IntakeEvent"("businessId", "id");

-- ── IntakeNormalizedEvent: what Dubiz understood from one receipt ──────────

CREATE TABLE "IntakeNormalizedEvent" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "intakeEventId" INTEGER NOT NULL,
    "normalizerVersion" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3),
    "contactHints" JSONB,
    "contactHintsPurgedAt" TIMESTAMP(3),
    "signals" JSONB NOT NULL DEFAULT '{}',
    "identityOutcome" TEXT NOT NULL,
    "attribution" JSONB,
    "routeTarget" TEXT,
    "routeOutcome" TEXT,
    "resultRefs" JSONB,
    "routedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntakeNormalizedEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "IntakeNormalizedEvent_normalizerVersion_format"
      CHECK ("normalizerVersion" ~ '^[a-z][a-z0-9_.]*@[0-9]+$' AND length("normalizerVersion") <= 64),
    -- M3 never merges identities: 'delegated' = the destination resolved the
    -- contact by its own existing deterministic rule; 'unresolved' = the hints
    -- are kept for M4 to turn into an owner proposal.
    CONSTRAINT "IntakeNormalizedEvent_identityOutcome_vocab"
      CHECK ("identityOutcome" IN ('none', 'delegated', 'unresolved')),
    CONSTRAINT "IntakeNormalizedEvent_routeTarget_vocab"
      CHECK ("routeTarget" IS NULL OR "routeTarget" IN
        ('conversation', 'message_status', 'lead', 'customer', 'commerce', 'document', 'attention', 'none')),
    CONSTRAINT "IntakeNormalizedEvent_routeOutcome_vocab"
      CHECK ("routeOutcome" IS NULL OR "routeOutcome" IN ('routed', 'ignored'))
);

-- One normalized record per receipt: a retry reuses it, never adds a second.
CREATE UNIQUE INDEX "IntakeNormalizedEvent_intakeEventId_key" ON "IntakeNormalizedEvent"("intakeEventId");
CREATE UNIQUE INDEX "IntakeNormalizedEvent_businessId_intakeEventId_key" ON "IntakeNormalizedEvent"("businessId", "intakeEventId");
CREATE INDEX "IntakeNormalizedEvent_businessId_createdAt_idx" ON "IntakeNormalizedEvent"("businessId", "createdAt");

ALTER TABLE "IntakeNormalizedEvent" ADD CONSTRAINT "IntakeNormalizedEvent_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Composite tenant key: a normalized record of business A cannot reference a
-- receipt of business B, whatever RLS does.
ALTER TABLE "IntakeNormalizedEvent" ADD CONSTRAINT "IntakeNormalizedEvent_businessId_intakeEventId_fkey"
  FOREIGN KEY ("businessId", "intakeEventId") REFERENCES "IntakeEvent"("businessId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Tenant isolation ────────────────────────────────────────────────────────
--
-- Written only inside a tenant transaction, after the tenant was resolved from
-- the adapter's trusted routing key. An ordinary tenant table: no pre-context
-- read exists. Fail-closed: with no GUC, NULLIF yields NULL and no row matches.
--
-- PER-COMMAND policies, SELECT / INSERT / UPDATE only. No DELETE: the
-- application never deletes a normalized record; erasure scrubs contactHints
-- with an UPDATE, and Business deletion cascades.

ALTER TABLE "IntakeNormalizedEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IntakeNormalizedEvent" FORCE ROW LEVEL SECURITY;

CREATE POLICY intake_normalized_tenant_read ON "IntakeNormalizedEvent" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

CREATE POLICY intake_normalized_tenant_insert ON "IntakeNormalizedEvent" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

CREATE POLICY intake_normalized_tenant_update ON "IntakeNormalizedEvent" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── Privileges ───────────────────────────────────────────────────────────────
--
-- Explicit, as for IntakeEvent: Production's default ACL would otherwise hand
-- app_runtime DELETE on a new table. Guarded on the role existing (no-op in CI
-- and on fresh developer databases).

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON "IntakeNormalizedEvent" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "IntakeNormalizedEvent_id_seq" TO app_runtime;
    REVOKE DELETE, TRUNCATE ON "IntakeNormalizedEvent" FROM app_runtime;
  END IF;
END
$do$;
