-- Documents performance indexes (additive, index-only — no column/data change).
--
-- The Documents inbox filters by (businessId, createdAt range, status) and the
-- search reads FinancialRecord by (businessId) ordered by (date). Neither table
-- had any index beyond its primary/unique keys, so both did full table scans on
-- the hottest screens. These composite indexes make those queries tenant- and
-- time-bounded at 100+ businesses. Safe to apply on a live DB.

-- CreateIndex
CREATE INDEX "Document_businessId_createdAt_idx" ON "Document"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "Document_businessId_status_createdAt_idx" ON "Document"("businessId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "FinancialRecord_businessId_date_idx" ON "FinancialRecord"("businessId", "date");
