-- M2 · KnowledgeMeasure — the quantitative half of derived knowledge.
--
-- Additive only: two new tables, two new enums, no existing table altered, no data transformed.
-- Everything here is DERIVED and rebuildable from canonical evidence, so the tables are droppable
-- without loss of truth. They are protected anyway, because derived knowledge about a business is
-- still knowledge about that business.

-- CreateEnum
CREATE TYPE "KnowledgeStatus" AS ENUM ('ACTIVE', 'INSUFFICIENT_EVIDENCE', 'STALE', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "KnowledgeTrend" AS ENUM ('IMPROVING', 'STABLE', 'WORSENING');

-- CreateTable
CREATE TABLE "KnowledgeMeasure" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "measureKey" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" INTEGER,
    "valueNumeric" DECIMAL(18,4) NOT NULL,
    "valueUnit" TEXT NOT NULL,
    "detail" JSONB,
    "observationCount" INTEGER NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "trend" "KnowledgeTrend",
    "status" "KnowledgeStatus" NOT NULL,
    "rulePolicyVersionId" INTEGER NOT NULL,
    "evidenceFingerprint" TEXT NOT NULL,
    "materializedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeMeasure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeMeasureEvidenceLink" (
    "id" SERIAL NOT NULL,
    "measureId" INTEGER NOT NULL,
    "businessId" INTEGER NOT NULL,
    "evidenceKind" TEXT NOT NULL,
    "evidenceRecordId" INTEGER NOT NULL,

    CONSTRAINT "KnowledgeMeasureEvidenceLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KnowledgeMeasure_businessId_measureKey_idx" ON "KnowledgeMeasure"("businessId", "measureKey");
CREATE INDEX "KnowledgeMeasure_businessId_entityType_entityId_idx" ON "KnowledgeMeasure"("businessId", "entityType", "entityId");
CREATE INDEX "KnowledgeMeasure_rulePolicyVersionId_idx" ON "KnowledgeMeasure"("rulePolicyVersionId");

-- One live measure per (tenant, key, subject, rule version).
--
-- This is an EXPRESSION index rather than a plain @@unique because `entityType` and `entityId` are
-- nullable, and Postgres treats NULL as distinct from NULL in a unique constraint. A plain unique
-- would therefore permit unlimited duplicate business-level measures — the exact rows that are
-- supposed to be replaced on each re-derivation — and the writer's delete-then-create would silently
-- accumulate instead of replacing.
CREATE UNIQUE INDEX "KnowledgeMeasure_slot_key" ON "KnowledgeMeasure"(
  "businessId", "measureKey", COALESCE("entityType", ''), COALESCE("entityId", 0), "rulePolicyVersionId"
);

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeMeasureEvidenceLink_measureId_evidenceKind_evidenc_key" ON "KnowledgeMeasureEvidenceLink"("measureId", "evidenceKind", "evidenceRecordId");
CREATE INDEX "KnowledgeMeasureEvidenceLink_measureId_idx" ON "KnowledgeMeasureEvidenceLink"("measureId");
CREATE INDEX "KnowledgeMeasureEvidenceLink_businessId_evidenceKind_evidenc_idx" ON "KnowledgeMeasureEvidenceLink"("businessId", "evidenceKind", "evidenceRecordId");

-- AddForeignKey
ALTER TABLE "KnowledgeMeasure" ADD CONSTRAINT "KnowledgeMeasure_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeMeasure" ADD CONSTRAINT "KnowledgeMeasure_rulePolicyVersionId_fkey" FOREIGN KEY ("rulePolicyVersionId") REFERENCES "DerivationPolicyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "KnowledgeMeasureEvidenceLink" ADD CONSTRAINT "KnowledgeMeasureEvidenceLink_measureId_fkey" FOREIGN KEY ("measureId") REFERENCES "KnowledgeMeasure"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeMeasureEvidenceLink" ADD CONSTRAINT "KnowledgeMeasureEvidenceLink_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- Tenant row-level security — identical in form to the wave-2 policies these tables sit beside.
--
-- Derived knowledge is protected on the SAME terms as the evidence it came from. A measure states
-- something about one business's behaviour; there is no reading of it that is safe to share.
-- ============================================================

ALTER TABLE "KnowledgeMeasure" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "KnowledgeMeasure" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w2_tenant ON "KnowledgeMeasure";
CREATE POLICY p7w2_tenant ON "KnowledgeMeasure"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "KnowledgeMeasureEvidenceLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "KnowledgeMeasureEvidenceLink" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w2_tenant ON "KnowledgeMeasureEvidenceLink";
CREATE POLICY p7w2_tenant ON "KnowledgeMeasureEvidenceLink"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ============================================================
-- Runtime grants.
--
-- Shipped WITH the migration, deliberately. The wave grants live in `scripts/security/*.sql` as
-- per-environment artifacts applied by hand, and that drift is real: those files record the
-- DerivedClaim* tables as ungranted while Production has granted them. A table whose privileges arrive
-- separately from its definition is a table whose privileges can be forgotten — and the failure is
-- silent on reads.
--
-- DELETE is granted because the writer REPLACES a slot (delete-then-create) on every re-derivation.
-- Guarded on role existence so the migration is portable to a lab that has no app roles.
-- ============================================================

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "KnowledgeMeasure" TO app_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "KnowledgeMeasureEvidenceLink" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "KnowledgeMeasure_id_seq" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "KnowledgeMeasureEvidenceLink_id_seq" TO app_runtime;
  END IF;
END
$do$;
