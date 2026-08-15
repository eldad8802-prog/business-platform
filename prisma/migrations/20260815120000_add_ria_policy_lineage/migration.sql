-- RIA-1 · Policy Lineage substrate (RIA-IMPL-2, Candidate A = Lineage only). Additive + inert.
-- Creates ONLY the new RiaPolicyLineage table. No ALTER/DROP of existing tables, no data
-- migration, no backfill. onDelete RESTRICT (not the repo-default CASCADE) so authoritative RIA
-- policy history is never cascade-deleted. No Policy Version, no selection, no uniqueness (RP5).

-- CreateTable
CREATE TABLE "RiaPolicyLineage" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "scope" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiaPolicyLineage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RiaPolicyLineage_businessId_idx" ON "RiaPolicyLineage"("businessId");

-- AddForeignKey
ALTER TABLE "RiaPolicyLineage" ADD CONSTRAINT "RiaPolicyLineage_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
