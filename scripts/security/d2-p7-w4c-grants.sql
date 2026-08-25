-- D2 / P7-W4C — least-privilege grants (PER-ENVIRONMENT artifact).
--
-- :ROLE = the tenant runtime role (Preview: app_runtime_preview_p4b).
-- Every verb is code-observed from the W4C route/service inventory:
--   EmailConnection        S,I,U  (callback upsert, disconnect transition,
--                                  status/auth/discovery reads, account-
--                                  deletion updateMany; NO delete anywhere)
--   OAuthToken             S,I,U,D (callback upsert, refresh update,
--                                  disconnect deleteMany, account-deletion
--                                  deleteMany)
--   EmailAttachmentImport  S,I    (import create + dedup reads; no updates)
--
-- app_admin (env-neutral NOLOGIN group): SELECT on EmailConnection only —
-- required by platform-overview on the sanctioned admin client. Idempotent
-- with the W2 admin grant if already present.

GRANT SELECT, INSERT, UPDATE ON "EmailConnection" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "EmailConnection_id_seq" TO :ROLE;
GRANT SELECT, INSERT, UPDATE, DELETE ON "OAuthToken" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "OAuthToken_id_seq" TO :ROLE;
GRANT SELECT, INSERT ON "EmailAttachmentImport" TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE "EmailAttachmentImport_id_seq" TO :ROLE;

GRANT SELECT ON "EmailConnection" TO app_admin;
