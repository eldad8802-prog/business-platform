-- D2 / P7-W4D — full rollback (policies + grants). Restores the pre-W4D
-- posture. Never drops roles; preserves all prior-wave substrate (incl. the
-- W2-era admin grants lineage — only W4D-added policies/grants are removed).
-- :ROLE = the tenant runtime role for the environment.

DROP POLICY IF EXISTS p7adm_read ON "Document";
DROP POLICY IF EXISTS p7adm_read ON "FinancialRecord";
DROP POLICY IF EXISTS p7adm_read ON "ExtractionSnapshot";
DROP POLICY IF EXISTS p7adm_read ON "SliceDecision";
DROP POLICY IF EXISTS p7adm_read ON "ReviewEvent";
DROP POLICY IF EXISTS p7adm_read ON "ExtractionEvidence";

DROP POLICY IF EXISTS p7w4d_tenant ON "Document";
ALTER TABLE "Document" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "Document" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4d_tenant ON "FinancialRecord";
ALTER TABLE "FinancialRecord" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "FinancialRecord" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4d_tenant ON "VendorLearning";
ALTER TABLE "VendorLearning" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "VendorLearning" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4d_tenant ON "ExtractionSnapshot";
ALTER TABLE "ExtractionSnapshot" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "ExtractionSnapshot" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4d_tenant ON "SliceDecision";
ALTER TABLE "SliceDecision" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "SliceDecision" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4d_tenant ON "ReviewEvent";
ALTER TABLE "ReviewEvent" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "ReviewEvent" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4d_tenant ON "ExtractedData";
ALTER TABLE "ExtractedData" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "ExtractedData" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4d_tenant ON "ExtractionEvidence";
ALTER TABLE "ExtractionEvidence" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "ExtractionEvidence" DISABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON "Document" FROM :ROLE;
REVOKE ALL PRIVILEGES ON "ExtractedData" FROM :ROLE;
REVOKE ALL PRIVILEGES ON "FinancialRecord" FROM :ROLE;
REVOKE ALL PRIVILEGES ON "VendorLearning" FROM :ROLE;
REVOKE ALL PRIVILEGES ON "ExtractionSnapshot" FROM :ROLE;
REVOKE ALL PRIVILEGES ON "SliceDecision" FROM :ROLE;
REVOKE ALL PRIVILEGES ON "ExtractionEvidence" FROM :ROLE;
REVOKE ALL PRIVILEGES ON "ReviewEvent" FROM :ROLE;
REVOKE ALL PRIVILEGES ON SEQUENCE "Document_id_seq" FROM :ROLE;
REVOKE ALL PRIVILEGES ON SEQUENCE "ExtractedData_id_seq" FROM :ROLE;
REVOKE ALL PRIVILEGES ON SEQUENCE "FinancialRecord_id_seq" FROM :ROLE;
REVOKE ALL PRIVILEGES ON SEQUENCE "VendorLearning_id_seq" FROM :ROLE;
REVOKE ALL PRIVILEGES ON SEQUENCE "ExtractionSnapshot_id_seq" FROM :ROLE;
REVOKE ALL PRIVILEGES ON SEQUENCE "SliceDecision_id_seq" FROM :ROLE;
REVOKE ALL PRIVILEGES ON SEQUENCE "ExtractionEvidence_id_seq" FROM :ROLE;
REVOKE ALL PRIVILEGES ON SEQUENCE "ReviewEvent_id_seq" FROM :ROLE;

REVOKE SELECT ON "FinancialRecord" FROM app_admin;
REVOKE SELECT ON "ExtractionSnapshot" FROM app_admin;
REVOKE SELECT ON "SliceDecision" FROM app_admin;
REVOKE SELECT ON "ReviewEvent" FROM app_admin;
REVOKE SELECT ON "ExtractionEvidence" FROM app_admin;
