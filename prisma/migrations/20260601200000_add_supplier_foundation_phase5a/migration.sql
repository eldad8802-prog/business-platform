-- Phase 5A: Supplier Foundation.
-- Standalone Supplier entity. No supplierId links on other models (that is Phase 5B).
-- Additive only: no changes to existing tables, no data migration.

CREATE TABLE "Supplier" (
  "id" SERIAL NOT NULL,
  "businessId" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "phone" TEXT,
  "email" TEXT,
  "notes" TEXT,
  "defaultLeadTimeDays" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Supplier_businessId_idx" ON "Supplier"("businessId");
CREATE INDEX "Supplier_businessId_isActive_idx" ON "Supplier"("businessId", "isActive");
CREATE INDEX "Supplier_businessId_name_idx" ON "Supplier"("businessId", "name");

ALTER TABLE "Supplier"
  ADD CONSTRAINT "Supplier_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
