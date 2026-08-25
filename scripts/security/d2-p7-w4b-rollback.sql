-- D2 / P7-W4B — full rollback (policies + grants). Restores the pre-W4B
-- posture. Never drops roles; preserves WhatsAppConnection bootstrap
-- semantics; does NOT touch the W4A Message unique constraint (schema-level,
-- separate lifecycle).
-- :ROLE = the tenant runtime role for the environment.

DROP POLICY IF EXISTS p7w4b_tenant ON "Message";
ALTER TABLE "Message" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "Message" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4b_tenant ON "MessageAnalysis";
ALTER TABLE "MessageAnalysis" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "MessageAnalysis" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4b_tenant ON "BusinessBotSettings";
ALTER TABLE "BusinessBotSettings" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "BusinessBotSettings" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4b_tenant ON "ReplySuggestion";
ALTER TABLE "ReplySuggestion" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "ReplySuggestion" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4b_tenant ON "WhatsAppAttachmentImport";
ALTER TABLE "WhatsAppAttachmentImport" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "WhatsAppAttachmentImport" DISABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON "Message" FROM :ROLE;
REVOKE ALL PRIVILEGES ON "MessageAnalysis" FROM :ROLE;
REVOKE ALL PRIVILEGES ON "BusinessBotSettings" FROM :ROLE;
REVOKE ALL PRIVILEGES ON "ReplySuggestion" FROM :ROLE;
REVOKE ALL PRIVILEGES ON "WhatsAppAttachmentImport" FROM :ROLE;
REVOKE ALL PRIVILEGES ON "WhatsAppConnection" FROM :ROLE;
REVOKE ALL PRIVILEGES ON SEQUENCE "Message_id_seq" FROM :ROLE;
REVOKE ALL PRIVILEGES ON SEQUENCE "MessageAnalysis_id_seq" FROM :ROLE;
REVOKE ALL PRIVILEGES ON SEQUENCE "BusinessBotSettings_id_seq" FROM :ROLE;
REVOKE ALL PRIVILEGES ON SEQUENCE "ReplySuggestion_id_seq" FROM :ROLE;
REVOKE ALL PRIVILEGES ON SEQUENCE "WhatsAppAttachmentImport_id_seq" FROM :ROLE;
REVOKE ALL PRIVILEGES ON SEQUENCE "WhatsAppConnection_id_seq" FROM :ROLE;

-- Restore the pilot SELECT-only posture on Conversation (never REVOKE ALL —
-- the pilot SELECT grant must survive a W4B rollback).
REVOKE INSERT, UPDATE ON "Conversation" FROM :ROLE;
REVOKE ALL PRIVILEGES ON SEQUENCE "Conversation_id_seq" FROM :ROLE;
