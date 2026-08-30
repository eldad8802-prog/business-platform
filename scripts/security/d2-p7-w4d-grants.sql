-- D2 / P7-W4D — least-privilege grants (PER-ENVIRONMENT artifact).
--
-- :ROLE = the tenant runtime role (Preview: app_runtime_preview_p4b).
-- Every verb is code-observed from the W4D route/service inventory:
--   Document            S,I,U  (upload/import/ocr creates; status transitions;
--                               dedup + inbox/review/report reads)
--   ExtractedData       S,I,U  (pipeline + approve upserts)
--   FinancialRecord     S,I,U  (approve upsert; reports/search/inbox reads)
--   VendorLearning      S,I,U  (extraction read; first-approval upsert)
--   ExtractionSnapshot  S,I    (ledger create; resolver/evidence reads)
--   SliceDecision       S,I    (ledger createMany)
--   ExtractionEvidence  S,I    (ledger create)
--   ReviewEvent         S,I    (approve create; evidence reads)
-- ZERO DELETE anywhere: account-deletion deliberately RETAINS the fiscal
-- document family, and no runtime path deletes any of these rows.
--
-- app_admin (env-neutral NOLOGIN group): SELECT only, exactly the tables the
-- admin-client consumers read (platform-overview: Document; learning-center:
-- ExtractionSnapshot/SliceDecision/ReviewEvent/ExtractionEvidence/
-- FinancialRecord). Document may already be granted by the W2 admin
-- foundation — GRANT is idempotent.

GRANT SELECT, INSERT, UPDATE ON "Document" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "Document_id_seq" TO :ROLE;
GRANT SELECT, INSERT, UPDATE ON "ExtractedData" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "ExtractedData_id_seq" TO :ROLE;
GRANT SELECT, INSERT, UPDATE ON "FinancialRecord" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "FinancialRecord_id_seq" TO :ROLE;
GRANT SELECT, INSERT, UPDATE ON "VendorLearning" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "VendorLearning_id_seq" TO :ROLE;
GRANT SELECT, INSERT ON "ExtractionSnapshot" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "ExtractionSnapshot_id_seq" TO :ROLE;
GRANT SELECT, INSERT ON "SliceDecision" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "SliceDecision_id_seq" TO :ROLE;
GRANT SELECT, INSERT ON "ExtractionEvidence" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "ExtractionEvidence_id_seq" TO :ROLE;
GRANT SELECT, INSERT ON "ReviewEvent" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "ReviewEvent_id_seq" TO :ROLE;

GRANT SELECT ON "Document" TO app_admin;
GRANT SELECT ON "FinancialRecord" TO app_admin;
GRANT SELECT ON "ExtractionSnapshot" TO app_admin;
GRANT SELECT ON "SliceDecision" TO app_admin;
GRANT SELECT ON "ReviewEvent" TO app_admin;
GRANT SELECT ON "ExtractionEvidence" TO app_admin;
