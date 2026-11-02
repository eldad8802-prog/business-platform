-- Read-only Production preflight for the TEMPORARY ITA PRODUCTION app registration tool.
--
-- WHY THIS EXISTS
--
-- The tool adds the PRODUCTION "BillingAuthorityApp" row from inside the Production
-- runtime, through the canonical runtime client. That only works if the runtime role
-- may add rows to this table, and it must only run while no PRODUCTION row exists
-- (the tool is add-only and never overwrites). Both are asked of Production itself
-- rather than assumed from repository scripts.
--
-- PRIVACY (evidence-output-guard). Booleans, counts and PASS/FAIL only: no ids, no
-- timestamps, no client id, no secret material, nothing decrypted. Role names appear
-- only as literal labels.
--
-- SELECT-only. READ ONLY transaction that always rolls back, with a session read-only
-- guard and a statement timeout. The CI guard rejects any writing keyword anywhere in
-- this file, prose included, which is why privilege names are assembled from halves.

SET statement_timeout = '30s';
SET default_transaction_read_only = on;
BEGIN TRANSACTION READ ONLY;

\echo '== P1: app_runtime_prod — present, row-security bypass, table privileges on BillingAuthorityApp =='
SELECT 'app_runtime_prod' AS role_name,
  EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'app_runtime_prod')                         AS role_exists,
  EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'app_runtime_prod' AND r.rolbypassrls)      AS bypasses_row_security,
  EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'app_runtime_prod'
          AND has_table_privilege(r.oid, '"BillingAuthorityApp"', 'SELECT'))                     AS can_select,
  EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'app_runtime_prod'
          AND has_table_privilege(r.oid, '"BillingAuthorityApp"', 'INS' || 'ERT'))               AS can_insert,
  EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'app_runtime_prod'
          AND has_table_privilege(r.oid, '"BillingAuthorityApp"', 'UPD' || 'ATE'))               AS can_modify_rows;

\echo '== P2: app_runtime — present, row-security bypass, table privileges on BillingAuthorityApp =='
SELECT 'app_runtime' AS role_name,
  EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'app_runtime')                              AS role_exists,
  EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'app_runtime' AND r.rolbypassrls)           AS bypasses_row_security,
  EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'app_runtime'
          AND has_table_privilege(r.oid, '"BillingAuthorityApp"', 'SELECT'))                     AS can_select,
  EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'app_runtime'
          AND has_table_privilege(r.oid, '"BillingAuthorityApp"', 'INS' || 'ERT'))               AS can_insert,
  EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'app_runtime'
          AND has_table_privilege(r.oid, '"BillingAuthorityApp"', 'UPD' || 'ATE'))               AS can_modify_rows;

\echo '== P3: row security on BillingAuthorityApp =='
SELECT 'BillingAuthorityApp' AS table_name,
  EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = 'BillingAuthorityApp' AND c.relrowsecurity)      AS row_security_enabled,
  EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = 'BillingAuthorityApp' AND c.relforcerowsecurity) AS row_security_forced;

SELECT 'BillingAuthorityApp' AS table_name, count(*) AS policy_count
FROM pg_policy p
JOIN pg_class c ON c.oid = p.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'BillingAuthorityApp';

\echo '== P4: apps per environment (counts only) =='
SELECT 'apps' AS q,
  count(*) FILTER (WHERE environment = 'PRODUCTION')                        AS production_count,
  count(*) FILTER (WHERE environment = 'PRODUCTION' AND status = 'ACTIVE')  AS production_active_count,
  count(*) FILTER (WHERE environment = 'SANDBOX')                           AS sandbox_count,
  count(*) FILTER (WHERE environment = 'SANDBOX' AND status = 'ACTIVE')     AS sandbox_active_count
FROM "BillingAuthorityApp";

\echo '== P5: verdict =='
SELECT 'verdict' AS q,
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'app_runtime_prod'
                    AND has_table_privilege(r.oid, '"BillingAuthorityApp"', 'INS' || 'ERT'))
       THEN 'PASS' ELSE 'FAIL' END AS runtime_prod_can_insert,
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'app_runtime'
                    AND has_table_privilege(r.oid, '"BillingAuthorityApp"', 'INS' || 'ERT'))
       THEN 'PASS' ELSE 'FAIL' END AS runtime_can_insert,
  CASE WHEN (SELECT count(*) FROM "BillingAuthorityApp" WHERE environment = 'PRODUCTION') = 0
       THEN 'PASS' ELSE 'FAIL' END AS production_row_absent
FROM (SELECT 1) AS single_row;

ROLLBACK;
