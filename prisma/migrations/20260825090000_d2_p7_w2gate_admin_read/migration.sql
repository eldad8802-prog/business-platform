-- D2 / P7-W2-GATE — platform-admin READ foundation (canonical, env-portable).
--
-- Two additive pieces, both idempotent and expand-only:
--
-- 1. The env-NEUTRAL admin GROUP role `app_admin` (NOLOGIN — it can never be a
--    connection identity). Policies and grants target this group; each
--    environment attaches its own LOGIN role (Preview: app_admin_preview,
--    created in the per-environment security artifact, NEVER here). Guarded
--    creation: roles are cluster-global, so re-running is a no-op.
--
-- 2. Additive `p7adm_read` SELECT-only policies on the starter admin-read
--    tables that already carry tenant RLS (Conversation, BillingDocument).
--    Permissive policies OR together: for members of app_admin the USING(true)
--    branch grants read across tenants; for every other role this policy does
--    not apply and the tenant policies keep working EXACTLY as before. No
--    tenant policy is altered, no FORCE RLS is touched, nothing is dropped.
--
-- On production today (runtime = owner/BYPASSRLS, no admin login role) this
-- migration is INERT beyond creating the powerless NOLOGIN group.
-- No login role names, endpoints, passwords or env-specific grants live here.

-- 1. Env-neutral admin group (NOLOGIN, no privileges of any kind).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin') THEN
    CREATE ROLE app_admin NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;
  END IF;
END
$$;

-- 2. Additive admin SELECT policies on the starter RLS'd admin-read tables.
DROP POLICY IF EXISTS p7adm_read ON "Conversation";
CREATE POLICY p7adm_read ON "Conversation"
  FOR SELECT TO app_admin
  USING (true);

DROP POLICY IF EXISTS p7adm_read ON "BillingDocument";
CREATE POLICY p7adm_read ON "BillingDocument"
  FOR SELECT TO app_admin
  USING (true);
