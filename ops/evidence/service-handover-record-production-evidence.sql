-- ============================================================================
-- service-handover-record-production-evidence.sql
--
-- Read-only EVIDENCE after migration 20261130090000_service_handover_debt_record was applied.
--
-- Proves:
--   * the migration is recorded once, finished, not rolled back; the ledger is clean;
--   * the six ServiceHandover columns: recordVersion NOT NULL DEFAULT 1, the five others nullable;
--   * the five CHECKs exist and are VALIDATED; the two approver FKs reference "User" that null on a removed user;
--   * the record trigger (before a new row) exists and is enabled; the same-business trigger checks three user columns;
--   * the four functions (record guard, handover guard, completion guard, erase): search_path ending in pg_temp, exactly
--     one SECURITY DEFINER (the erase), none executable by PUBLIC, the erase executable by app_runtime;
--   * legacy compatibility: every version-1 row has every new column empty; no version-2 row names an approver other
--     than its actor;
--   * informational counts: version-1 (legacy) and version-2 handovers.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== service handover record evidence: legend (n -> check) =='
\echo ' 1 the migration is recorded once, finished, not rolled back'
\echo ' 2 ledger: no unfinished and no rolled-back row'
\echo ' 3 recordVersion NOT NULL with the constant default 1'
\echo ' 4 the five other new columns exist and are nullable (of 5)'
\echo ' 5 the five CHECKs exist and are validated (of 5)'
\echo ' 6 the two approver FKs reference User that null on a removed user (of 2)'
\echo ' 7 the record trigger exists, before a new row, enabled'
\echo ' 8 the same-business trigger checks three user columns'
\echo ' 9 the four functions with search_path ending in pg_temp (of 4)'
\echo '10 exactly one of them is SECURITY DEFINER: the erase (1)'
\echo '11 none of them executable by PUBLIC (expected 0)'
\echo '12 the erase function is executable by app_runtime'
\echo '13 version-1 rows with any new column set (expected 0)'
\echo '14 version-2 rows whose approver is not the actor (expected 0)'
\echo '15 version-1 handovers (informational; the rows that existed before)'
\echo '16 version-2 handovers (informational; 0 until the code ships)'

WITH f AS (
  SELECT p.oid, p.proname, p.prosecdef, p.proconfig, p.proacl FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('service_handover_record_guard', 'service_handover_guard', 'service_completion_guard', 'service_handover_record_erase_business')
), c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261130090000_service_handover_debt_record'
                     AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS observed, 1 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ServiceHandover'
                          AND column_name = 'recordVersion' AND is_nullable = 'NO' AND column_default = '1'), 1
  UNION ALL SELECT 4, (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ServiceHandover' AND is_nullable = 'YES'
                          AND column_name IN ('overpaidAgorot', 'debtApprovedByUserId', 'debtApprovedAt', 'loanerApprovedByUserId', 'loanerApprovedAt')), 5
  UNION ALL SELECT 5, (SELECT count(*) FROM pg_constraint WHERE conrelid = to_regclass('public."ServiceHandover"') AND contype = 'c' AND convalidated
                          AND conname IN ('ServiceHandover_record_version', 'ServiceHandover_legacy_shape', 'ServiceHandover_balance',
                                          'ServiceHandover_debt_decided', 'ServiceHandover_loaner_decided')), 5
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_constraint WHERE conrelid = to_regclass('public."ServiceHandover"') AND contype = 'f'
                          AND confrelid = to_regclass('public."User"') AND confdeltype = 'n'
                          AND conname IN ('ServiceHandover_debtApprovedByUserId_fkey', 'ServiceHandover_loanerApprovedByUserId_fkey')), 2
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_trigger WHERE tgrelid = to_regclass('public."ServiceHandover"') AND tgname = 'ServiceHandover_record_guard'
                          AND tgenabled = 'O' AND (tgtype & 2) = 2 AND (tgtype & 4) = 4), 1
  UNION ALL SELECT 8, (SELECT max(tgnargs) FROM pg_trigger WHERE tgrelid = to_regclass('public."ServiceHandover"') AND tgname = 'ServiceHandover_user_same_business'), 3
  UNION ALL SELECT 9, (SELECT count(*) FROM f WHERE proconfig IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(proconfig) s WHERE s LIKE 'search_path=%pg_temp')), 4
  UNION ALL SELECT 10, (SELECT count(*) FROM f WHERE prosecdef AND proname = 'service_handover_record_erase_business')
                     + (SELECT count(*) FROM f WHERE prosecdef AND proname <> 'service_handover_record_erase_business') * 10, 1
  UNION ALL SELECT 11, (SELECT count(*) FROM f WHERE has_function_privilege('public', oid, 'EXECUTE')), 0
  UNION ALL SELECT 12, (SELECT count(*) FROM f WHERE proname = 'service_handover_record_erase_business' AND has_function_privilege('app_runtime', oid, 'EXECUTE')), 1
  UNION ALL SELECT 13, (SELECT count(*) FROM "ServiceHandover" WHERE "recordVersion" = 1 AND ("overpaidAgorot" IS NOT NULL OR "debtApprovedByUserId" IS NOT NULL
                          OR "debtApprovedAt" IS NOT NULL OR "loanerApprovedByUserId" IS NOT NULL OR "loanerApprovedAt" IS NOT NULL)), 0
  UNION ALL SELECT 14, (SELECT count(*) FROM "ServiceHandover" WHERE "recordVersion" = 2
                          AND (("debtApprovedByUserId" IS NOT NULL AND "debtApprovedByUserId" IS DISTINCT FROM "actorUserId")
                            OR ("loanerApprovedByUserId" IS NOT NULL AND "loanerApprovedByUserId" IS DISTINCT FROM "actorUserId"))), 0
  UNION ALL SELECT 15, (SELECT count(*) FROM "ServiceHandover" WHERE "recordVersion" = 1), NULL
  UNION ALL SELECT 16, (SELECT count(*) FROM "ServiceHandover" WHERE "recordVersion" = 2), NULL
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
