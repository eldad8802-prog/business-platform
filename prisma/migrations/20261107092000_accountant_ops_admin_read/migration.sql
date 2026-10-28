-- Accountant package — the admin console's read of the monitoring tables (G5 milestone 1, M2)
--
-- AUTHORITY-CHANGING — CROSS-BUSINESS VISIBILITY FOR THE PLATFORM ADMIN. A separate owner decision from
-- 20261107090000_accountant_ops_monitor on purpose: without this migration the monitor and its alerts work fully,
-- and only the console's monitoring page cannot read them.
--
-- WHAT THIS GRANTS (to `app_admin`, the console's least-privilege read role — NOLOGIN group, NOBYPASSRLS)
--   SELECT on "AccountantOpsRun" and "AccountantOpsAlert" (platform tables: run counts, platform findings);
--   SELECT on "AccountantBusinessAlert" through the ADDITIVE `p7adm_read` policy (FOR SELECT TO app_admin USING
--   (true)) — the same pattern as every other table the console reads (20261024090000_platform_admin_a1).
--
-- WHAT IT DOES NOT GRANT
--   Nothing on any accountant workflow table: no period, package, recipient, delivery or trail row; no address,
--   link, token, provider id, document or amount. The console sees codes, subjects (a month or a delivery id),
--   times and counts — exactly what the three monitoring tables can hold (closed by their CHECKs).
--   No INSERT / UPDATE / DELETE for app_admin. The tenant policies and FORCE RLS stay untouched.
--
-- app_admin exists in every environment since 20260825090000 (the preflight proves it before apply).
-- Rollback (owner-run): .acct/ops-admin-read-rollback.sql — drops the policy and revokes the three grants.

DROP POLICY IF EXISTS p7adm_read ON "AccountantBusinessAlert";
CREATE POLICY p7adm_read ON "AccountantBusinessAlert"
  FOR SELECT TO app_admin
  USING (true);

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin') THEN
    GRANT SELECT ON "AccountantOpsRun", "AccountantOpsAlert", "AccountantBusinessAlert" TO app_admin;
  END IF;
END
$do$;
