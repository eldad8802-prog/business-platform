-- RIA-1 · Canonical Referent substrate (RIA-IMPL-1). Additive + inert.
-- Creates ONLY the new RiaCanonicalReferent table. No ALTER/DROP of existing tables,
-- no data migration, no backfill. onDelete RESTRICT (not the repo-default CASCADE) so
-- authoritative RIA history is never cascade-deleted.

-- CreateTable
CREATE TABLE "RiaCanonicalReferent" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "referentType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiaCanonicalReferent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RiaCanonicalReferent_businessId_idx" ON "RiaCanonicalReferent"("businessId");

-- AddForeignKey
ALTER TABLE "RiaCanonicalReferent" ADD CONSTRAINT "RiaCanonicalReferent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
