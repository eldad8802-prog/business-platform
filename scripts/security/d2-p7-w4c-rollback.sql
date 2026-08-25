-- D2 / P7-W4C — full rollback (policies + grants). Restores the pre-W4C
-- posture. Never drops roles; preserves all prior-wave substrate.
-- :ROLE = the tenant runtime role for the environment.
--
-- NOTE: the admin SELECT grant on EmailConnection predates W4C (W2 admin
-- foundation granted it on Preview); rolling back W4C removes only the
-- p7adm_read POLICY added here, not that grant.

DROP POLICY IF EXISTS p7adm_read ON "EmailConnection";
DROP POLICY IF EXISTS p7w4c_tenant ON "EmailConnection";
ALTER TABLE "EmailConnection" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "EmailConnection" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4c_tenant ON "OAuthToken";
ALTER TABLE "OAuthToken" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "OAuthToken" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w4c_tenant ON "EmailAttachmentImport";
ALTER TABLE "EmailAttachmentImport" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "EmailAttachmentImport" DISABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON "EmailConnection" FROM :ROLE;
REVOKE ALL PRIVILEGES ON "OAuthToken" FROM :ROLE;
REVOKE ALL PRIVILEGES ON "EmailAttachmentImport" FROM :ROLE;
REVOKE ALL PRIVILEGES ON SEQUENCE "EmailConnection_id_seq" FROM :ROLE;
REVOKE ALL PRIVILEGES ON SEQUENCE "OAuthToken_id_seq" FROM :ROLE;
REVOKE ALL PRIVILEGES ON SEQUENCE "EmailAttachmentImport_id_seq" FROM :ROLE;
