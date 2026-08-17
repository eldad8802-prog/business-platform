-- Business Memory IMPL-4 · Derived Claim materialization substrate. Additive + inert + DERIVED.
-- Creates ONLY three new DERIVED/DROPPABLE tables (DerivedClaimProjection + DerivedClaimCandidate +
-- DerivedClaimEvidenceLink). No ALTER/DROP of any existing table, no data migration, no backfill, no
-- INSERT. Cascade is confined INSIDE the derived hierarchy (Projection->Candidate->EvidenceLink); the
-- policy FK is RESTRICT (policy history is never cascade-deleted by a Claim) and the Business FK is
-- Cascade (a derived cache is cleaned with its tenant). EvidenceLink has NO FK to ReviewEvent: it holds
-- a store-agnostic scalar reference, so the derived tier can never delete/rewrite canonical evidence.
-- Empty + inert: no writer, no read-path, no VendorLearning/RIA/C1 coupling. Table existence is NOT
-- Business Memory activation.

-- CreateTable
CREATE TABLE "DerivedClaimProjection" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "subjectDomain" TEXT NOT NULL,
    "subjectNormalizedKey" TEXT NOT NULL,
    "claimType" TEXT NOT NULL,
    "policyVersionId" INTEGER NOT NULL,
    "evidenceSetFingerprint" TEXT NOT NULL,
    "materializedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DerivedClaimProjection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DerivedClaimCandidate" (
    "id" SERIAL NOT NULL,
    "projectionId" INTEGER NOT NULL,
    "propositionValue" TEXT NOT NULL,

    CONSTRAINT "DerivedClaimCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DerivedClaimEvidenceLink" (
    "id" SERIAL NOT NULL,
    "candidateId" INTEGER NOT NULL,
    "businessId" INTEGER NOT NULL,
    "evidenceKind" TEXT NOT NULL,
    "evidenceRecordId" INTEGER NOT NULL,

    CONSTRAINT "DerivedClaimEvidenceLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DerivedClaimProjection_businessId_idx" ON "DerivedClaimProjection"("businessId");

-- CreateIndex
CREATE INDEX "DerivedClaimProjection_policyVersionId_idx" ON "DerivedClaimProjection"("policyVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "DerivedClaimProjection_businessId_subjectDomain_subjectNorm_key" ON "DerivedClaimProjection"("businessId", "subjectDomain", "subjectNormalizedKey", "claimType", "policyVersionId");

-- CreateIndex
CREATE INDEX "DerivedClaimCandidate_projectionId_idx" ON "DerivedClaimCandidate"("projectionId");

-- CreateIndex
CREATE UNIQUE INDEX "DerivedClaimCandidate_projectionId_propositionValue_key" ON "DerivedClaimCandidate"("projectionId", "propositionValue");

-- CreateIndex
CREATE INDEX "DerivedClaimEvidenceLink_candidateId_idx" ON "DerivedClaimEvidenceLink"("candidateId");

-- CreateIndex
CREATE INDEX "DerivedClaimEvidenceLink_businessId_evidenceKind_evidenceRe_idx" ON "DerivedClaimEvidenceLink"("businessId", "evidenceKind", "evidenceRecordId");

-- CreateIndex
CREATE UNIQUE INDEX "DerivedClaimEvidenceLink_candidateId_evidenceKind_evidenceR_key" ON "DerivedClaimEvidenceLink"("candidateId", "evidenceKind", "evidenceRecordId");

-- AddForeignKey
ALTER TABLE "DerivedClaimProjection" ADD CONSTRAINT "DerivedClaimProjection_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DerivedClaimProjection" ADD CONSTRAINT "DerivedClaimProjection_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "DerivationPolicyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DerivedClaimCandidate" ADD CONSTRAINT "DerivedClaimCandidate_projectionId_fkey" FOREIGN KEY ("projectionId") REFERENCES "DerivedClaimProjection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DerivedClaimEvidenceLink" ADD CONSTRAINT "DerivedClaimEvidenceLink_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "DerivedClaimCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

