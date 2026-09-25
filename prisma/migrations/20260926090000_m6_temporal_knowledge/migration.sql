-- M6 · Per-business temporal knowledge: baseline, stable pattern, trend, material change, anomaly.
--
-- ONE NEW TABLE, two new enums, ten governance rows. Nothing existing is altered, renamed, dropped
-- or rewritten, and there is no backfill: the table starts empty and is filled only by the
-- tenant-scoped derivation, one business per call.
--
-- WHY A NEW TABLE AND NOT KnowledgeMeasure. KnowledgeMeasure holds exactly one current answer per
-- slot (its writer deletes and re-creates), which is right for "what is this business's filing lag".
-- Temporal knowledge has to keep history: a baseline that shifted must remain auditable as the
-- baseline that WAS, an anomaly observed last month is still a fact about last month, and a material
-- change is by definition a comparison of two windows. Overloading KnowledgeMeasure would break its
-- one-answer-per-slot contract for every existing consumer. So temporal knowledge is its own
-- artifact, fed by the same evidence sources, and KnowledgeMeasure is untouched.
--
-- APPEND-AND-SUPERSEDE. The runtime may INSERT and UPDATE (to move a row's status to SUPERSEDED or
-- STALE and to stamp confirmedAt), and may NOT DELETE: temporal history is never erased by the
-- application. Business deletion still cascades (FK actions run as the table owner).

CREATE TYPE "TemporalKnowledgeType" AS ENUM ('BASELINE', 'STABLE_PATTERN', 'TREND', 'MATERIAL_CHANGE', 'ANOMALY');

-- INSUFFICIENT_HISTORY is a first-class RESULT, not a failure and not a missing row: "we do not know
-- yet, and here is exactly what is missing" is knowledge a consumer can render.
CREATE TYPE "TemporalKnowledgeStatus" AS ENUM ('ACTIVE', 'INSUFFICIENT_HISTORY', 'STALE', 'SUPERSEDED');

CREATE TABLE "TemporalKnowledge" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    -- Which temporal rule, and which version of it (fail-closed resolver, lineages seeded below).
    "temporalKey" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "rulePolicyVersionId" INTEGER NOT NULL,
    "knowledgeType" "TemporalKnowledgeType" NOT NULL,
    "status" "TemporalKnowledgeStatus" NOT NULL,
    -- BUSINESS level when entityType is NULL; ENTITY level otherwise. Never another business.
    "entityType" TEXT,
    "entityId" INTEGER,
    -- A same-business context slice (e.g. 'direction=expense'), '' for none. A sparse slice falls back
    -- only to this business's own broader baseline, and says so in "finding".
    "contextKey" TEXT NOT NULL DEFAULT '',
    "valueKind" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    -- Everything is derived AS OF this instant; windows are computed from it, never from the clock.
    "asOf" TIMESTAMP(3) NOT NULL,
    "historyStart" TIMESTAMP(3) NOT NULL,
    "historyEnd" TIMESTAMP(3) NOT NULL,
    "recentStart" TIMESTAMP(3),
    "recentEnd" TIMESTAMP(3),
    "historyCount" INTEGER NOT NULL,
    "recentCount" INTEGER NOT NULL,
    -- Robust summaries (median / quartiles / MAD, or a proportion), the classification's own numbers,
    -- and — for INSUFFICIENT_HISTORY — the structured reason (have / need / span). No confidence scores.
    "baseline" JSONB,
    "recent" JSONB,
    "finding" JSONB,
    "reason" JSONB,
    "evidenceRefs" JSONB NOT NULL,
    "evidenceFingerprint" TEXT NOT NULL,
    -- Identity of the CONCLUSION. Same conclusion from the same evidence → no new row, only confirmedAt.
    "semanticHash" TEXT NOT NULL,
    "materializedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "TemporalKnowledge_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TemporalKnowledge_businessId_status_idx" ON "TemporalKnowledge"("businessId", "status");
CREATE INDEX "TemporalKnowledge_slot_idx"
  ON "TemporalKnowledge"("businessId", "temporalKey", "entityType", "entityId", "contextKey", "knowledgeType");
CREATE INDEX "TemporalKnowledge_rulePolicyVersionId_idx" ON "TemporalKnowledge"("rulePolicyVersionId");

ALTER TABLE "TemporalKnowledge" ADD CONSTRAINT "TemporalKnowledge_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TemporalKnowledge" ADD CONSTRAINT "TemporalKnowledge_rulePolicyVersionId_fkey"
  FOREIGN KEY ("rulePolicyVersionId") REFERENCES "DerivationPolicyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================
-- TENANT ROW-LEVEL SECURITY — same form as every tenant table since wave 2.
-- ============================================================
ALTER TABLE "TemporalKnowledge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TemporalKnowledge" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w2_tenant ON "TemporalKnowledge";
CREATE POLICY p7w2_tenant ON "TemporalKnowledge"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ============================================================
-- GRANTS, shipped with the definition. DELETE and TRUNCATE are taken back explicitly: ALTER DEFAULT
-- PRIVILEGES hands app_runtime a,r,w,d on every new table (see 20260924180000), and temporal
-- history must not be erasable by the application.
-- ============================================================
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON "TemporalKnowledge" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "TemporalKnowledge_id_seq" TO app_runtime;
    REVOKE DELETE, TRUNCATE ON "TemporalKnowledge" FROM app_runtime;
  END IF;
END
$do$;

-- ============================================================
-- RULE LINEAGES — governance rows, idempotent. The resolver is fail-closed: a temporal rule whose
-- lineage is missing refuses to write rather than producing an unversioned artifact.
-- ============================================================
INSERT INTO "DerivationPolicy" ("key", "name") VALUES
  ('temporal-documents-paperwork-lag',    'T-DOC-04 · filing lag over time'),
  ('temporal-documents-vendor-amount',    'T-DOC-05 · vendor charge over time'),
  ('temporal-documents-vendor-cadence',   'T-DOC-02 · vendor billing rhythm over time'),
  ('temporal-documents-correction-rate',  'T-DOC-06 · extraction correction rate over time'),
  ('temporal-payables-payment-timing',    'T-AP-01 · payment timing over time'),
  ('temporal-payables-payee-timing',      'T-AP-04 · per-payee payment timing over time'),
  ('temporal-inventory-restock-cadence',  'T-INV-02 · restock rhythm over time'),
  ('temporal-inventory-correction-share', 'T-INV-04 · stock correction share over time'),
  ('temporal-suppliers-purchase-cadence', 'T-SUPP-01 · purchase rhythm over time'),
  ('temporal-suppliers-delivery-lag',     'T-SUPP-02 · delivery lead time over time')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "DerivationPolicyVersion" ("policyId", "version")
SELECT p."id", 'v1'
FROM "DerivationPolicy" p
WHERE p."key" IN (
  'temporal-documents-paperwork-lag', 'temporal-documents-vendor-amount', 'temporal-documents-vendor-cadence',
  'temporal-documents-correction-rate', 'temporal-payables-payment-timing', 'temporal-payables-payee-timing',
  'temporal-inventory-restock-cadence', 'temporal-inventory-correction-share',
  'temporal-suppliers-purchase-cadence', 'temporal-suppliers-delivery-lag'
)
ON CONFLICT ("policyId", "version") DO NOTHING;
