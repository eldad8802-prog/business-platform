-- sec(C) / M-14(c) — platform-admin read policy for "WhatsAppAttachmentImport".
--
-- EXPAND-ONLY: one additive SELECT policy for the app_admin group. Tenant policies
-- and FORCE RLS are untouched.
--
-- The admin identity already holds SELECT on this table
-- (scripts/security/d2-p7-wave2-grants.sql) and platform-overview / platform
-- business detail count its rows — but, unlike Conversation, Document,
-- EmailConnection and the other admin-read tables, it never received the
-- `p7adm_read` policy. Under FORCE RLS with no tenant GUC the admin therefore
-- sees ZERO rows and reports a silent, wrong 0. This adds the same policy shape
-- the other admin-read tables carry (SELECT only, app_admin only).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin') THEN
    CREATE ROLE app_admin NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;
  END IF;
END
$$;

-- Guarded: an environment where the policy was already created by hand must not
-- fail the release (CREATE POLICY has no IF NOT EXISTS).
DO $
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'WhatsAppAttachmentImport' AND policyname = 'p7adm_read'
  ) THEN
    CREATE POLICY p7adm_read ON "WhatsAppAttachmentImport"
      FOR SELECT TO app_admin USING (true);
  END IF;
END
$;
