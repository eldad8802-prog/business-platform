-- General Decision Ledger (Phase 1) — additive, append-only. Extends the
-- existing Correction Ledger with structural-slice provenance, a generic
-- per-field decision table, and a heavy shared evidence table.

-- AlterTable — structural (slice) engine provenance on the document snapshot.
ALTER TABLE "ExtractionSnapshot" ADD COLUMN "sliceEngineVersion" TEXT;
ALTER TABLE "ExtractionSnapshot" ADD COLUMN "ocrGeometryHash" TEXT;
ALTER TABLE "ExtractionSnapshot" ADD COLUMN "geometryAvailable" BOOLEAN;

-- CreateTable — one row per field decision of the engine.
CREATE TABLE "SliceDecision" (
    "id" SERIAL NOT NULL,
    "extractionSnapshotId" INTEGER NOT NULL,
    "documentId" INTEGER NOT NULL,
    "businessId" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fieldKey" TEXT NOT NULL,
    "engineValue" TEXT,
    "legacyValue" TEXT,
    "resolutionState" TEXT,
    "basis" TEXT,
    "confidenceLabel" TEXT,
    "provenance" JSONB,
    "strength" JSONB,
    "reasoningBlob" JSONB,
    "producedBy" TEXT NOT NULL,
    "sliceEngineVersion" TEXT,

    CONSTRAINT "SliceDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable — heavy shared deterministic evidence (1:1 with snapshot).
CREATE TABLE "ExtractionEvidence" (
    "id" SERIAL NOT NULL,
    "extractionSnapshotId" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ocrGeometry" JSONB,
    "reasoningBlob" JSONB,
    "geometryHash" TEXT,
    "sliceEngineVersion" TEXT,

    CONSTRAINT "ExtractionEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SliceDecision_extractionSnapshotId_idx" ON "SliceDecision"("extractionSnapshotId");

-- CreateIndex
CREATE INDEX "SliceDecision_businessId_fieldKey_idx" ON "SliceDecision"("businessId", "fieldKey");

-- CreateIndex
CREATE INDEX "SliceDecision_documentId_idx" ON "SliceDecision"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "ExtractionEvidence_extractionSnapshotId_key" ON "ExtractionEvidence"("extractionSnapshotId");

-- CreateIndex
CREATE INDEX "ExtractionEvidence_extractionSnapshotId_idx" ON "ExtractionEvidence"("extractionSnapshotId");

-- AddForeignKey
ALTER TABLE "SliceDecision" ADD CONSTRAINT "SliceDecision_extractionSnapshotId_fkey" FOREIGN KEY ("extractionSnapshotId") REFERENCES "ExtractionSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractionEvidence" ADD CONSTRAINT "ExtractionEvidence_extractionSnapshotId_fkey" FOREIGN KEY ("extractionSnapshotId") REFERENCES "ExtractionSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
