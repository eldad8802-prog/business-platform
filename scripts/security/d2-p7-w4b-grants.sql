-- D2 / P7-W4B — least-privilege runtime grants (PER-ENVIRONMENT artifact).
--
-- :ROLE = the tenant runtime role for the environment (Preview:
-- app_runtime_preview_p4b). Every verb is code-observed from the W4B
-- route/service inventory. No admin grants (no admin-client consumer).
-- ZERO DELETE on the RLS'd cluster: the only delete touching it is
-- account-deletion via the Conversation cascade, whose grant posture belongs
-- to the pilot tables, not W4B.

-- WhatsApp conversation cluster
GRANT SELECT, INSERT, UPDATE ON "Message" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "Message_id_seq" TO :ROLE;
GRANT SELECT, INSERT ON "MessageAnalysis" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "MessageAnalysis_id_seq" TO :ROLE;
GRANT SELECT, INSERT, UPDATE ON "BusinessBotSettings" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "BusinessBotSettings_id_seq" TO :ROLE;
GRANT SELECT, INSERT, UPDATE ON "ReplySuggestion" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "ReplySuggestion_id_seq" TO :ROLE;
GRANT SELECT, INSERT, UPDATE ON "WhatsAppAttachmentImport" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "WhatsAppAttachmentImport_id_seq" TO :ROLE;

-- SPECIAL — WhatsAppConnection (provider bootstrap, NO tenant RLS).
-- Verb justification (route-audited):
--   SELECT          - webhook phone_number_id resolution + token read + GET status
--   INSERT/UPDATE   - embedded-signup/manual-seed upsert, disconnect status,
--                     outbound markRevokedByMeta/recordTransientError
--   DELETE          - meta-data erase route (deleteMetaDataByBusinessId)
GRANT SELECT, INSERT, UPDATE, DELETE ON "WhatsAppConnection" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "WhatsAppConnection_id_seq" TO :ROLE;
