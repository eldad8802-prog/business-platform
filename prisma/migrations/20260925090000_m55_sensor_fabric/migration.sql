-- M5.5 · Business Sensor Fabric — the generic sensor ledger learns WHERE, WHEN, WHICH VERSION, and ONCE.
--
-- ADDITIVE ONLY. One new enum, four nullable columns and two indexes on "LearningEvent", plus three
-- governance rows. Nothing renamed, nothing dropped, no type or nullability change, no row rewritten.
-- Every new column is NULL on every historical row and stays that way: an origin that was never
-- recorded is a gap, and backfilling a guess would replace an honest gap with a confident fiction.
--
-- No new table, so no new RLS policy and no new grant: "LearningEvent" is already ENABLE + FORCE RLS
-- under the standard tenant policy, and app_runtime already inserts into it.
--
-- DELIBERATELY NOT HERE: making "LearningEvent" append-only by privilege. The app never updates or
-- deletes it, but its erasure disposition is an open owner decision (erasure-contract-debt,
-- C13-NEEDS-OWNER-DECISION), and revoking UPDATE now would pre-empt that decision.

-- ============================================================
-- 1 · SOURCE — the channel an event arrived through, orthogonal to WHO (actorType).
--
-- An owner importing a CSV is actorType OWNER_USER + source IMPORT: a person did it, through a file.
-- Collapsing the two into one "actor" column would make "who" and "how" impossible to ask separately,
-- and the learning questions need both ("do imported leads convert like typed ones?").
-- ============================================================
CREATE TYPE "LearningEventSource" AS ENUM ('OWNER_UI', 'IMPORT', 'INTEGRATION', 'SYSTEM', 'API', 'UNKNOWN');

ALTER TABLE "LearningEvent" ADD COLUMN "source" "LearningEventSource";

-- WHEN it happened in the business, when that differs from when it was recorded (a message's
-- provider timestamp, an imported row's own date). NULL means createdAt is the event time.
ALTER TABLE "LearningEvent" ADD COLUMN "occurredAt" TIMESTAMP(3);

-- WHICH version of the sensor wrote it, so a consumer can tell a changed payload shape from a
-- changed business.
ALTER TABLE "LearningEvent" ADD COLUMN "sensorVersion" INTEGER;

-- ONCE. A webhook retry, a cron retry and an import retry are not new business actions. A sensor
-- that has a stable identity for the action writes it here, and the unique index makes the second
-- write a no-op (ON CONFLICT DO NOTHING) instead of a second fact. NULLs are distinct, so every
-- existing row and every sensor without a natural key is unaffected.
ALTER TABLE "LearningEvent" ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "LearningEvent_businessId_idempotencyKey_key"
  ON "LearningEvent"("businessId", "idempotencyKey");

-- The access path every consumer uses: one tenant, one event type, a time window.
CREATE INDEX "LearningEvent_businessId_eventType_createdAt_idx"
  ON "LearningEvent"("businessId", "eventType", "createdAt");

-- ============================================================
-- 2 · RULE VERSIONS — three M4 rules corrected by the M5.5 audit (governance rows, idempotent)
--
--   AP-06  v2  a CHEQUE evidence is the owner's assertion that it cleared (clearedSource is always
--              OWNER_ASSERTED), not external backing. v1 counted it as backed.
--   SUPP-02 v2 / SUPP-03 v2  an order created by approving a supplier-purchase draft is created
--              CONFIRMED and received in full in ONE transaction, so its "lead time" is always 0 and it
--              can never be short. Those orders say nothing about the supplier and are excluded.
--
-- The resolver is fail-closed, so the versions are registered here rather than lazily at runtime.
-- The next derivation writes v2 and reconciles the v1 rows to SUPERSEDED.
-- ============================================================
INSERT INTO "DerivationPolicyVersion" ("policyId", "version")
SELECT p."id", 'v2'
FROM "DerivationPolicy" p
WHERE p."key" IN (
  'payables-payment-evidence-backing',
  'suppliers-delivery-lag',
  'suppliers-short-delivery-share'
)
ON CONFLICT ("policyId", "version") DO NOTHING;
