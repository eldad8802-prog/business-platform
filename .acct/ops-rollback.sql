-- Rollback of 20261107090000_accountant_ops_monitor (owner-run). Removes the three monitoring tables.
-- Refuses while any of them holds a row: run history and alerts are operational records, so once the monitor has
-- written anything the rollback is a decision, not a script. Run AFTER .acct/ops-admin-read-rollback.sql.
BEGIN;
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM "AccountantOpsRun") OR EXISTS (SELECT 1 FROM "AccountantOpsAlert")
     OR EXISTS (SELECT 1 FROM "AccountantBusinessAlert") THEN
    RAISE EXCEPTION 'ACCOUNTANT_OPS_ROLLBACK_REFUSED: the monitoring tables hold rows; nothing was changed';
  END IF;
END
$do$;
DROP TABLE "AccountantBusinessAlert";
DROP TABLE "AccountantOpsAlert";
DROP TABLE "AccountantOpsRun";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261107090000_accountant_ops_monitor';
COMMIT;
