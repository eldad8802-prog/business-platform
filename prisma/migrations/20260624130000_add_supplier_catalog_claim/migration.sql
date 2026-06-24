-- Supplier Domain Catalog — Claims Ledger (additive only; NOT yet activated).
-- Adds CatalogSource (provenance anchor) + CatalogClaim (append-only Reported-
-- Reality atom). Subject is polymorphic (subjectType + subjectId) with NO FK to
-- subjectId, and deliberately NO FK to InventoryItem (catalog never authors the
-- Record). No services / ingestion / read-model. No changes to existing tables.
-- No backfill. No delete semantics.

-- CreateEnum
CREATE TYPE "CatalogSourceType" AS ENUM ('MANUAL_ENTRY', 'FILE_IMPORT');

-- CreateEnum
CREATE TYPE "CatalogSubjectType" AS ENUM ('SUPPLIER_PRODUCT', 'SUPPLIER');

-- CreateEnum
CREATE TYPE "CatalogAttribute" AS ENUM ('ASKING_PRICE', 'AVAILABILITY', 'PACKAGE_DESCRIPTION', 'MINIMUM_ORDER_AMOUNT', 'LEAD_TIME_DAYS');

-- CreateEnum
CREATE TYPE "CatalogValueType" AS ENUM ('MONEY', 'NUMBER', 'TEXT', 'BOOLEAN');

-- CreateEnum
CREATE TYPE "CatalogClaimStatus" AS ENUM ('ACTIVE', 'SUPERSEDED', 'RETRACTED');

-- CreateEnum
CREATE TYPE "CatalogProvenanceGrade" AS ENUM ('PROVIDER_ATTESTED', 'INTERPRETED');

-- CreateTable
CREATE TABLE "CatalogSource" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "supplierId" INTEGER NOT NULL,
    "sourceType" "CatalogSourceType" NOT NULL,
    "actorUserId" INTEGER,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogClaim" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "subjectType" "CatalogSubjectType" NOT NULL,
    "subjectId" INTEGER NOT NULL,
    "attribute" "CatalogAttribute" NOT NULL,
    "valueType" "CatalogValueType" NOT NULL,
    "valueNumber" DOUBLE PRECISION,
    "valueText" TEXT,
    "valueBool" BOOLEAN,
    "currency" TEXT,
    "observedAt" TIMESTAMP(3),
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceId" INTEGER NOT NULL,
    "provenanceGrade" "CatalogProvenanceGrade" NOT NULL DEFAULT 'PROVIDER_ATTESTED',
    "status" "CatalogClaimStatus" NOT NULL DEFAULT 'ACTIVE',
    "supersededAt" TIMESTAMP(3),
    "retractedAt" TIMESTAMP(3),
    "retractedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CatalogSource_businessId_idx" ON "CatalogSource"("businessId");

-- CreateIndex
CREATE INDEX "CatalogSource_supplierId_idx" ON "CatalogSource"("supplierId");

-- CreateIndex
CREATE INDEX "CatalogSource_businessId_supplierId_occurredAt_idx" ON "CatalogSource"("businessId", "supplierId", "occurredAt");

-- CreateIndex
CREATE INDEX "CatalogClaim_businessId_idx" ON "CatalogClaim"("businessId");

-- CreateIndex
CREATE INDEX "CatalogClaim_subject_attr_status_idx" ON "CatalogClaim"("businessId", "subjectType", "subjectId", "attribute", "status");

-- CreateIndex
CREATE INDEX "CatalogClaim_subject_attr_observed_idx" ON "CatalogClaim"("businessId", "subjectType", "subjectId", "attribute", "observedAt");

-- CreateIndex
CREATE INDEX "CatalogClaim_sourceId_idx" ON "CatalogClaim"("sourceId");

-- CreateIndex
CREATE INDEX "CatalogClaim_businessId_status_idx" ON "CatalogClaim"("businessId", "status");

-- AddForeignKey
ALTER TABLE "CatalogSource" ADD CONSTRAINT "CatalogSource_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogSource" ADD CONSTRAINT "CatalogSource_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogClaim" ADD CONSTRAINT "CatalogClaim_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogClaim" ADD CONSTRAINT "CatalogClaim_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "CatalogSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
