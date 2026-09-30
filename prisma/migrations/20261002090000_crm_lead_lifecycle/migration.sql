-- ============================================================================
-- Business Intake M5 — CRM lead lifecycle (migration only, PR-A)
--
-- Adds the durable lifecycle history of a Lead and the few Lead columns the
-- lifecycle needs. Expand-only, apart from two deliberate retypes of columns
-- that no code has ever written (see "Lead money" below):
--
--   * LeadLifecycleEvent — APPEND-ONLY history. One row per lifecycle change
--     (created, attached from intake, status changed, next action set /
--     rescheduled / completed / cleared, value updated, suggestion dismissed,
--     contact attached / detached, conversation linked). No personal data:
--     no name, phone, email, note or free text. `seq` is the Lead's
--     lifecycleVersion after the change; (businessId, leadId, seq) is unique,
--     so two concurrent writers can never both record "the next" change.
--     (businessId, idempotencyKey) is unique, so a retried change is a no-op.
--   * Lead.lifecycleVersion — optimistic-concurrency counter (stale-proposal
--     protection: an owner decision or a suggestion carries the version it saw).
--   * Lead.nextActionKind — WHAT the single open follow-up is (call, send quote,
--     check quote, …). The due moment stays Lead.nextFollowUpAt.
--   * Lead.firstHandledAt — the first owner lifecycle action (time-to-handle).
--   * Lead money: valueEstimate (estimated opportunity value) and finalPrice
--     (amount agreed at WON) become NUMERIC(18,2); currency gets an ISO-4217
--     shape CHECK. quotedPrice, temperature, currentStage are left untouched
--     and are DEPRECATED by M5 (quote truth is the billing QUOTE document).
--
-- Backfill (additive): every existing Lead gets its `created` event
-- (occurredAt = Lead.createdAt) and, when its status is no longer NEW, ONE
-- `status_changed` event NEW → current status (occurredAt = closedAt, else
-- lastActivityAt, else updatedAt). Both are marked source BACKFILL so learning
-- can tell reconstructed history from observed history. lifecycleVersion is set
-- to the number of events written. No other existing value changes.
--
-- Tenant isolation: FORCE RLS; SELECT and INSERT policies only (append-only);
-- app_runtime gets SELECT, INSERT; UPDATE, DELETE and TRUNCATE are revoked.
-- Composite (businessId, leadId) FK → Lead(businessId, id) (sec-C key).
-- ============================================================================

-- ── Preflight ───────────────────────────────────────────────────────────────
-- Lead is FORCE-RLS. The backfill and the checks below must see EVERY row, so a
-- role subject to row-level security must fail here instead of silently seeing
-- none (row_security = off raises for such a role; the owner bypasses).
SET row_security = off;

DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'Lead_businessId_id_key' AND relkind = 'i') THEN
    RAISE EXCEPTION 'M5 requires sec-C 20260926110000 (Lead_businessId_id_key)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'IdentityProposal' AND relkind = 'r') THEN
    RAISE EXCEPTION 'M5 requires M4 20261001090000 (IdentityProposal)';
  END IF;
  IF EXISTS (SELECT 1 FROM "Lead" WHERE "currency" IS NOT NULL AND "currency" !~ '^[A-Z]{3}$') THEN
    RAISE EXCEPTION 'M5: a Lead.currency value is not an ISO-4217 code — inspect before migrating';
  END IF;
  IF EXISTS (SELECT 1 FROM "Lead" WHERE ("valueEstimate" IS NOT NULL AND ("valueEstimate" < 0 OR "valueEstimate" >= 1e16))
                                    OR ("finalPrice" IS NOT NULL AND ("finalPrice" < 0 OR "finalPrice" >= 1e16))) THEN
    RAISE EXCEPTION 'M5: a Lead money value is out of range for NUMERIC(18,2) >= 0 — inspect before migrating';
  END IF;
END
$pre$;

-- ── Lead: lifecycle columns ─────────────────────────────────────────────────

ALTER TABLE "Lead"
  ADD COLUMN "lifecycleVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextActionKind" TEXT,
  ADD COLUMN "firstHandledAt" TIMESTAMP(3),
  ALTER COLUMN "valueEstimate" TYPE DECIMAL(18,2) USING round("valueEstimate"::numeric, 2),
  ALTER COLUMN "finalPrice" TYPE DECIMAL(18,2) USING round("finalPrice"::numeric, 2);

ALTER TABLE "Lead"
  ADD CONSTRAINT "Lead_nextActionKind_vocab" CHECK (
    "nextActionKind" IS NULL OR "nextActionKind" IN
      ('call', 'send_quote', 'check_quote', 'follow_up', 'schedule_meeting',
       'collect_info', 'wait_for_customer', 'other')
  ),
  -- A next action always has a due moment; the moment may exist without a kind
  -- (every follow-up written before M5).
  ADD CONSTRAINT "Lead_nextAction_has_due" CHECK ("nextActionKind" IS NULL OR "nextFollowUpAt" IS NOT NULL),
  ADD CONSTRAINT "Lead_lifecycleVersion_range" CHECK ("lifecycleVersion" >= 0),
  ADD CONSTRAINT "Lead_money_nonnegative" CHECK (
    ("valueEstimate" IS NULL OR "valueEstimate" >= 0) AND ("finalPrice" IS NULL OR "finalPrice" >= 0)
  ),
  ADD CONSTRAINT "Lead_currency_iso" CHECK ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$');

-- ── LeadLifecycleEvent ──────────────────────────────────────────────────────

CREATE TABLE "LeadLifecycleEvent" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "leadId" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "fromStatus" "LeadStatus",
    "toStatus" "LeadStatus",
    "nextActionKind" TEXT,
    "dueAt" TIMESTAMP(3),
    "previousDueAt" TIMESTAMP(3),
    "amountKind" TEXT,
    "amount" DECIMAL(18,2),
    "actorType" TEXT NOT NULL,
    "actorUserId" INTEGER,
    "source" TEXT NOT NULL,
    "evidenceKind" TEXT,
    "evidenceRef" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadLifecycleEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LeadLifecycleEvent_kind_vocab" CHECK ("kind" IN (
      'created', 'intake_attached', 'status_changed',
      'next_action_set', 'next_action_rescheduled', 'next_action_completed', 'next_action_cleared',
      'value_updated', 'suggestion_dismissed',
      'contact_attached', 'contact_detached', 'conversation_linked'
    )),
    CONSTRAINT "LeadLifecycleEvent_seq_range" CHECK ("seq" >= 1),
    CONSTRAINT "LeadLifecycleEvent_status_shape" CHECK (
      ("kind" = 'status_changed' AND "fromStatus" IS NOT NULL AND "toStatus" IS NOT NULL AND "fromStatus" <> "toStatus")
      OR ("kind" = 'created' AND "fromStatus" IS NULL AND "toStatus" = 'NEW')
      OR ("kind" NOT IN ('status_changed', 'created') AND "fromStatus" IS NULL AND "toStatus" IS NULL)
    ),
    CONSTRAINT "LeadLifecycleEvent_nextActionKind_vocab" CHECK (
      "nextActionKind" IS NULL OR "nextActionKind" IN
        ('call', 'send_quote', 'check_quote', 'follow_up', 'schedule_meeting',
         'collect_info', 'wait_for_customer', 'other')
    ),
    CONSTRAINT "LeadLifecycleEvent_next_action_shape" CHECK (
      ("kind" IN ('next_action_set', 'next_action_rescheduled') AND "dueAt" IS NOT NULL)
      OR "kind" NOT IN ('next_action_set', 'next_action_rescheduled')
    ),
    CONSTRAINT "LeadLifecycleEvent_reschedule_shape" CHECK (
      "kind" <> 'next_action_rescheduled' OR "previousDueAt" IS NOT NULL
    ),
    CONSTRAINT "LeadLifecycleEvent_amount_shape" CHECK (
      ("kind" = 'value_updated' AND "amountKind" IN ('estimate', 'agreed') AND ("amount" IS NULL OR "amount" >= 0))
      OR ("kind" <> 'value_updated' AND "amountKind" IS NULL AND "amount" IS NULL)
    ),
    CONSTRAINT "LeadLifecycleEvent_actorType_vocab" CHECK (
      "actorType" IN ('OWNER_USER', 'SYSTEM', 'INTEGRATION', 'UNKNOWN')
    ),
    CONSTRAINT "LeadLifecycleEvent_actor_shape" CHECK ("actorType" <> 'OWNER_USER' OR "actorUserId" IS NOT NULL),
    CONSTRAINT "LeadLifecycleEvent_source_vocab" CHECK (
      "source" IN ('OWNER_UI', 'IMPORT', 'INTEGRATION', 'SYSTEM', 'API', 'UNKNOWN', 'BACKFILL')
    ),
    CONSTRAINT "LeadLifecycleEvent_evidence_shape" CHECK (
      ("evidenceKind" IS NULL AND "evidenceRef" IS NULL)
      OR ("evidenceKind" IN ('intake_event', 'conversation', 'identity_proposal', 'suggestion', 'backfill')
          AND "evidenceRef" ~ '^[A-Za-z0-9_:.@-]{1,100}$')
    ),
    CONSTRAINT "LeadLifecycleEvent_idempotencyKey_format" CHECK (length("idempotencyKey") BETWEEN 1 AND 200)
);

CREATE UNIQUE INDEX "LeadLifecycleEvent_businessId_idempotencyKey_key"
  ON "LeadLifecycleEvent"("businessId", "idempotencyKey");
CREATE UNIQUE INDEX "LeadLifecycleEvent_businessId_leadId_seq_key"
  ON "LeadLifecycleEvent"("businessId", "leadId", "seq");
CREATE INDEX "LeadLifecycleEvent_businessId_kind_occurredAt_idx"
  ON "LeadLifecycleEvent"("businessId", "kind", "occurredAt");

ALTER TABLE "LeadLifecycleEvent" ADD CONSTRAINT "LeadLifecycleEvent_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeadLifecycleEvent" ADD CONSTRAINT "LeadLifecycleEvent_leadId_fkey"
  FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Composite tenant key (DB-only, like sec-C's): same-business Lead only.
ALTER TABLE "LeadLifecycleEvent" ADD CONSTRAINT "LeadLifecycleEvent_leadId_tenant_fkey"
  FOREIGN KEY ("businessId", "leadId") REFERENCES "Lead"("businessId", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- ── Backfill (additive; runs as the owner before RLS is forced) ─────────────

INSERT INTO "LeadLifecycleEvent"
  ("businessId", "leadId", "seq", "kind", "toStatus", "actorType", "source",
   "evidenceKind", "evidenceRef", "idempotencyKey", "occurredAt")
SELECT l."businessId", l."id", 1, 'created', 'NEW', 'UNKNOWN', 'BACKFILL',
       'backfill', 'm5-lifecycle@1', 'lead:' || l."id" || ':created', l."createdAt"
FROM "Lead" l;

INSERT INTO "LeadLifecycleEvent"
  ("businessId", "leadId", "seq", "kind", "fromStatus", "toStatus", "actorType", "source",
   "evidenceKind", "evidenceRef", "idempotencyKey", "occurredAt")
SELECT l."businessId", l."id", 2, 'status_changed', 'NEW', l."status", 'UNKNOWN', 'BACKFILL',
       'backfill', 'm5-lifecycle@1', 'lead:' || l."id" || ':backfill:status',
       COALESCE(l."closedAt", l."lastActivityAt", l."updatedAt")
FROM "Lead" l
WHERE l."status" <> 'NEW';

UPDATE "Lead" l
SET "lifecycleVersion" = CASE WHEN l."status" = 'NEW' THEN 1 ELSE 2 END;

DO $chk$
BEGIN
  IF (SELECT count(*) FROM "LeadLifecycleEvent" WHERE "kind" = 'created') <> (SELECT count(*) FROM "Lead")
     OR EXISTS (SELECT 1 FROM "Lead" l WHERE l."lifecycleVersion" <>
                (SELECT count(*) FROM "LeadLifecycleEvent" e WHERE e."leadId" = l."id")) THEN
    RAISE EXCEPTION 'M5 backfill: lifecycle history does not cover every Lead exactly';
  END IF;
END
$chk$;

-- ── Tenant isolation ────────────────────────────────────────────────────────
--
-- Append-only: SELECT and INSERT policies, no UPDATE, no DELETE. Fail-closed:
-- with no GUC, NULLIF yields NULL and no row matches. Lead / Business deletion
-- cascades (FK actions run as the table owner).

ALTER TABLE "LeadLifecycleEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LeadLifecycleEvent" FORCE ROW LEVEL SECURITY;

CREATE POLICY lead_lifecycle_tenant_read ON "LeadLifecycleEvent" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

CREATE POLICY lead_lifecycle_tenant_insert ON "LeadLifecycleEvent" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── Privileges ───────────────────────────────────────────────────────────────
--
-- Explicit: Production's default ACL would otherwise hand app_runtime UPDATE and
-- DELETE on a new table. Guarded on the role existing (no-op in CI / fresh DBs).

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT ON "LeadLifecycleEvent" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "LeadLifecycleEvent_id_seq" TO app_runtime;
    REVOKE UPDATE, DELETE, TRUNCATE ON "LeadLifecycleEvent" FROM app_runtime;
  END IF;
END
$do$;

RESET row_security;
