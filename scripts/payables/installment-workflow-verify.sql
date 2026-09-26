-- InstallmentWorkflow (migration 20260927090000) — post-migration VERIFICATION.
-- READ-ONLY: catalog metadata and counts only. Creates no row, changes nothing.
-- Paste into the Production SQL console after release-migrate. Every `ok`
-- column must be true.

SELECT 'table exists' AS "check",
       to_regclass('public."InstallmentWorkflow"') IS NOT NULL AS ok
UNION ALL
SELECT 'columns exactly as reviewed',
       (SELECT array_agg(column_name::text ORDER BY column_name::text)
          FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'InstallmentWorkflow')
       = ARRAY['businessId','createdAt','followUpAt','handledAt','handledByUserId','installmentId','updatedAt']
UNION ALL
SELECT 'RLS enabled',
       (SELECT relrowsecurity FROM pg_class WHERE oid = 'public."InstallmentWorkflow"'::regclass)
UNION ALL
SELECT 'RLS forced',
       (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public."InstallmentWorkflow"'::regclass)
UNION ALL
SELECT 'tenant policy payables_p2_tenant (USING + WITH CHECK on app.current_business_id)',
       EXISTS (SELECT 1 FROM pg_policies
                WHERE schemaname = 'public' AND tablename = 'InstallmentWorkflow'
                  AND policyname = 'payables_p2_tenant'
                  AND qual LIKE '%app.current_business_id%'
                  AND with_check LIKE '%app.current_business_id%')
UNION ALL
SELECT 'same-business trigger present and enabled',
       EXISTS (SELECT 1 FROM pg_trigger
                WHERE tgrelid = 'public."InstallmentWorkflow"'::regclass
                  AND tgname = 'InstallmentWorkflow_same_business'
                  AND NOT tgisinternal AND tgenabled <> 'D')
UNION ALL
SELECT 'same-business function present',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'InstallmentWorkflow_same_business')
UNION ALL
SELECT 'index (businessId, followUpAt)',
       EXISTS (SELECT 1 FROM pg_indexes
                WHERE schemaname = 'public' AND tablename = 'InstallmentWorkflow'
                  AND indexname = 'InstallmentWorkflow_businessId_followUpAt_idx')
UNION ALL
SELECT 'FK → Business (ON DELETE CASCADE)',
       EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = 'public."InstallmentWorkflow"'::regclass
                  AND conname = 'InstallmentWorkflow_businessId_fkey'
                  AND confrelid = 'public."Business"'::regclass AND confdeltype = 'c')
UNION ALL
SELECT 'FK → Installment (ON DELETE CASCADE)',
       EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = 'public."InstallmentWorkflow"'::regclass
                  AND conname = 'InstallmentWorkflow_installmentId_fkey'
                  AND confrelid = 'public."Installment"'::regclass AND confdeltype = 'c')
UNION ALL
SELECT 'app_runtime: SELECT, INSERT, UPDATE granted',
       NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime')
       OR (has_table_privilege('app_runtime', 'public."InstallmentWorkflow"', 'SELECT')
           AND has_table_privilege('app_runtime', 'public."InstallmentWorkflow"', 'INSERT')
           AND has_table_privilege('app_runtime', 'public."InstallmentWorkflow"', 'UPDATE'))
UNION ALL
SELECT 'app_runtime: DELETE and TRUNCATE NOT granted',
       NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime')
       OR (NOT has_table_privilege('app_runtime', 'public."InstallmentWorkflow"', 'DELETE')
           AND NOT has_table_privilege('app_runtime', 'public."InstallmentWorkflow"', 'TRUNCATE'))
UNION ALL
SELECT 'table is empty (no backfill ran; the flag is off, nothing writes it)',
       (SELECT count(*) FROM "InstallmentWorkflow") = 0;

-- Migration history (Production only — a db-push test database has no history table).
SELECT 'migration recorded as applied, and cleanly' AS "check",
       EXISTS (SELECT 1 FROM "_prisma_migrations"
                WHERE migration_name = '20260927090000_payables_installment_workflow'
                  AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS ok
UNION ALL
SELECT 'no migration left unfinished',
       NOT EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL);

-- Context, not a pass/fail: the migration contains no DML at all (it only
-- creates the new table and its objects), so it cannot have written a Payment
-- or an audit event. Rows newer than finished_at are ordinary owner activity.
SELECT
  (SELECT finished_at FROM "_prisma_migrations"
    WHERE migration_name = '20260927090000_payables_installment_workflow')  AS migration_finished_at,
  (SELECT max("createdAt") FROM "Payment")                                    AS newest_payment_created_at,
  (SELECT max("occurredAt") FROM "PayablesAuditEvent")                        AS newest_payables_audit_at,
  (SELECT count(*) FROM "Payment")                                            AS payments_total;
