-- Rollback of 20261107092000_accountant_ops_admin_read (owner-run). Takes the console's read of the monitoring
-- tables back: the admin policy and the three SELECT grants. Rows are untouched; the monitor keeps working.
BEGIN;
DROP POLICY IF EXISTS p7adm_read ON "AccountantBusinessAlert";
REVOKE SELECT ON "AccountantOpsRun", "AccountantOpsAlert", "AccountantBusinessAlert" FROM app_admin;
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261107092000_accountant_ops_admin_read';
COMMIT;
