-- Business Intake M2 · IntakeEvent — the canonical receipt ledger.
--
-- WHY
-- The WhatsApp webhook answered Meta 200 whether or not anything had been
-- stored. A processing failure, a throttle or a race between two first
-- messages from a new sender therefore lost the message permanently: Meta does
-- not redeliver a 200, and nothing inside Dubiz remembered the event. This
-- table is the record that Dubiz accepted responsibility for an event. The
-- webhook answers 200 only after the row is durable; everything downstream is
-- derived from it by a processor that may fail and retry.
--
-- WHAT IT IS NOT
--   - Not the domain record: Message / Conversation / Customer stay the
--     operational truth.
--   - Not a learning event: LearningEvent stays evidence and never holds the
--     payload.
--   - Not provider-specific: WhatsApp is the first IntakeProvider value. Later
--     sources add enum values, not tables.
--
-- EXPAND-ONLY. Three enums, one table, three indexes, one foreign key, RLS,
-- policies and grants. No existing table, column, row or policy changes.

-- CreateEnum
CREATE TYPE "IntakeProvider" AS ENUM ('WHATSAPP');

-- CreateEnum
CREATE TYPE "IntakeEventKind" AS ENUM ('MESSAGE_RECEIVED', 'MESSAGE_STATUS');

-- CreateEnum
CREATE TYPE "IntakeEventStatus" AS ENUM ('RECEIVED', 'PERSISTED', 'PROCESSED', 'FAILED', 'IGNORED');

-- CreateTable
CREATE TABLE "IntakeEvent" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "provider" "IntakeProvider" NOT NULL,
    "kind" "IntakeEventKind" NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "providerAccountRef" TEXT,
    "occurredAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "IntakeEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "processedAt" TIMESTAMP(3),
    "payload" JSONB,
    "payloadPurgedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "messageId" INTEGER,
    "conversationId" INTEGER,
    "customerId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntakeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IntakeEvent_businessId_status_nextAttemptAt_idx" ON "IntakeEvent"("businessId", "status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "IntakeEvent_businessId_receivedAt_idx" ON "IntakeEvent"("businessId", "receivedAt");

-- CreateIndex
-- Replay protection: one receipt per provider event per business. Tenant-scoped,
-- so identical provider ids in two businesses never cross-dedup.
CREATE UNIQUE INDEX "IntakeEvent_businessId_provider_externalEventId_key" ON "IntakeEvent"("businessId", "provider", "externalEventId");

-- AddForeignKey
ALTER TABLE "IntakeEvent" ADD CONSTRAINT "IntakeEvent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Tenant isolation ────────────────────────────────────────────────────────
--
-- The receipt is written AFTER the tenant is resolved from the provider's own
-- routing key (WhatsApp: phone_number_id → WhatsAppConnection, an allowlisted
-- bootstrap table), inside a tenant transaction. It is therefore an ordinary
-- tenant table, not a new bootstrap surface: no pre-context read of it exists.
--
-- Fail-closed by construction: with no GUC, current_setting(..., true) is '',
-- NULLIF yields NULL, and no row qualifies.
--
-- PER-COMMAND policies, SELECT / INSERT / UPDATE only. No DELETE policy: the
-- application never deletes a receipt. Account erasure scrubs the payload with an
-- UPDATE. A policy without a FOR clause is FOR ALL, and FOR ALL is how a DELETE
-- capability gets granted by accident (20260902120000_d2_cutover2b_pilot_tenant_rls).
--
-- No admin policy: nothing in platform-admin reads this table.

ALTER TABLE "IntakeEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IntakeEvent" FORCE ROW LEVEL SECURITY;

CREATE POLICY intake_event_tenant_read ON "IntakeEvent" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

CREATE POLICY intake_event_tenant_insert ON "IntakeEvent" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

CREATE POLICY intake_event_tenant_update ON "IntakeEvent" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── Privileges ───────────────────────────────────────────────────────────────
--
-- Named explicitly rather than inherited. Production carries ALTER DEFAULT
-- PRIVILEGES granting app_runtime a,r,w,d on every new table
-- (20260908200000_auth_session_privilege_contract), so a table arrives holding
-- DELETE nobody asked for. The REVOKE makes the database agree with the policy
-- set above; Preview (no such default) reaches the same effective privileges.
--
-- Guarded on the role existing, so this is a clean no-op on a database without
-- app_runtime (a fresh developer database, CI).

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON "IntakeEvent" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "IntakeEvent_id_seq" TO app_runtime;
    REVOKE DELETE, TRUNCATE ON "IntakeEvent" FROM app_runtime;
  END IF;
END
$do$;
