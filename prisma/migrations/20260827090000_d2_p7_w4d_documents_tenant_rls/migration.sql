-- D2 / P7-W4D — tenant RLS for the Documents / OCR / Learning cluster.
--
-- Same contract as prior waves: EXPAND-ONLY, idempotent, role-free (the
-- app_admin GROUP is env-neutral, created by the W2-GATE canonical
-- migration). INERT under owner/BYPASSRLS runtimes (production today);
-- enforcing under the Preview least-privilege runtime role.
--
-- Fail-closed tenant predicate (proven shape):
--   "businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int

-- ============================================================
-- Direct tenancy (businessId column) — 6 tables
-- ============================================================

ALTER TABLE "Document" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Document" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4d_tenant ON "Document";
CREATE POLICY p7w4d_tenant ON "Document"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "FinancialRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FinancialRecord" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4d_tenant ON "FinancialRecord";
CREATE POLICY p7w4d_tenant ON "FinancialRecord"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "VendorLearning" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VendorLearning" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4d_tenant ON "VendorLearning";
CREATE POLICY p7w4d_tenant ON "VendorLearning"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "ExtractionSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExtractionSnapshot" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4d_tenant ON "ExtractionSnapshot";
CREATE POLICY p7w4d_tenant ON "ExtractionSnapshot"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "SliceDecision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SliceDecision" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4d_tenant ON "SliceDecision";
CREATE POLICY p7w4d_tenant ON "SliceDecision"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "ReviewEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReviewEvent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4d_tenant ON "ReviewEvent";
CREATE POLICY p7w4d_tenant ON "ReviewEvent"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ============================================================
-- Indirect tenancy (parent-join via RLS-protected parents) — 2 tables
--
-- The EXISTS subquery runs as the querying role, so for the tenant runtime
-- the parent row is itself visible only under the same GUC — the predicate
-- composes with (never bypasses) the parent policy.
-- ============================================================

ALTER TABLE "ExtractedData" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExtractedData" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4d_tenant ON "ExtractedData";
CREATE POLICY p7w4d_tenant ON "ExtractedData"
  USING (EXISTS (SELECT 1 FROM "Document" p WHERE p."id" = "ExtractedData"."documentId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int))
  WITH CHECK (EXISTS (SELECT 1 FROM "Document" p WHERE p."id" = "ExtractedData"."documentId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int));

ALTER TABLE "ExtractionEvidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExtractionEvidence" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4d_tenant ON "ExtractionEvidence";
CREATE POLICY p7w4d_tenant ON "ExtractionEvidence"
  USING (EXISTS (SELECT 1 FROM "ExtractionSnapshot" p WHERE p."id" = "ExtractionEvidence"."extractionSnapshotId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int))
  WITH CHECK (EXISTS (SELECT 1 FROM "ExtractionSnapshot" p WHERE p."id" = "ExtractionEvidence"."extractionSnapshotId"
    AND p."businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int));

-- ============================================================
-- Additive admin read policies (permissive-OR; tenant policies untouched).
-- Required consumers:
--   platform-overview (sanctioned admin client): Document counts
--   learning-center (migrated to the admin client in W4D): ExtractionSnapshot,
--     SliceDecision, ReviewEvent, ExtractionEvidence, FinancialRecord
-- No admin access to VendorLearning/ExtractedData (no admin-client consumer).
-- ============================================================

DROP POLICY IF EXISTS p7adm_read ON "Document";
CREATE POLICY p7adm_read ON "Document"
  FOR SELECT TO app_admin USING (true);
DROP POLICY IF EXISTS p7adm_read ON "FinancialRecord";
CREATE POLICY p7adm_read ON "FinancialRecord"
  FOR SELECT TO app_admin USING (true);
DROP POLICY IF EXISTS p7adm_read ON "ExtractionSnapshot";
CREATE POLICY p7adm_read ON "ExtractionSnapshot"
  FOR SELECT TO app_admin USING (true);
DROP POLICY IF EXISTS p7adm_read ON "SliceDecision";
CREATE POLICY p7adm_read ON "SliceDecision"
  FOR SELECT TO app_admin USING (true);
DROP POLICY IF EXISTS p7adm_read ON "ReviewEvent";
CREATE POLICY p7adm_read ON "ReviewEvent"
  FOR SELECT TO app_admin USING (true);
DROP POLICY IF EXISTS p7adm_read ON "ExtractionEvidence";
CREATE POLICY p7adm_read ON "ExtractionEvidence"
  FOR SELECT TO app_admin USING (true);
