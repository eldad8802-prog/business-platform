-- ============================================================================
-- service-handover-record-preflight.sql
--
-- Read-only PREFLIGHT before migration
--   20261130090000_service_handover_debt_record   (NOT applied)
--
-- Proves Production is the shape the migration expects:
--   * the ledger is clean; this migration is not recorded; nothing after it is finished;
--   * M1 (20261127090000_service_desk_tracks) is recorded and finished — ServiceCompletion is a premise;
--   * none of the names it introduces exists yet: the six ServiceHandover columns, the seven constraints, the two
--     functions, the handover record trigger;
--   * the functions it reuses or rewrites exist (5) and the two handover triggers it rebuilds / relies on exist;
--   * app_runtime exists NOLOGIN NOSUPERUSER NOBYPASSRLS; the owner of ServiceHandover carries BYPASSRLS or is a superuser;
--   * informational: the existing handovers that become version 1 (legacy shape), of them those with a negative balance
--     (the legacy overpayment form) and those with an open debt carrying only a reason.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== service handover record preflight: legend (n -> check) =='
\echo ' 1 ledger: no unfinished and no rolled-back row'
\echo ' 2 20261130090000_service_handover_debt_record is NOT recorded'
\echo ' 3 no finished migration sorts after it'
\echo ' 4 M1 20261127090000_service_desk_tracks is recorded and finished'
\echo ' 5 none of the six new ServiceHandover columns exists yet'
\echo ' 6 none of the seven new constraints exists yet'
\echo ' 7 none of the two new functions exists yet'
\echo ' 8 the functions it reuses or rewrites exist (of 5)'
\echo ' 9 the handover triggers it relies on exist (of 2) and the record trigger does not'
\echo '10 app_runtime exists NOLOGIN NOSUPERUSER NOBYPASSRLS'
\echo '11 the owner of ServiceHandover carries BYPASSRLS or is a superuser'
\echo '12 handovers (informational; every one becomes version 1, unchanged)'
\echo '13 handovers with a negative balance (informational; legacy overpayment form, kept as is)'
\echo '14 handovers with an open debt (informational; legacy: reason only, no approver column)'

WITH c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) AS observed, 0 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261130090000_service_handover_debt_record'), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name > '20261130090000_service_handover_debt_record' AND finished_at IS NOT NULL), 0
  UNION ALL SELECT 4, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261127090000_service_desk_tracks'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL), 1
  UNION ALL SELECT 5, (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ServiceHandover'
                          AND column_name IN ('recordVersion', 'overpaidAgorot', 'debtApprovedByUserId', 'debtApprovedAt', 'loanerApprovedByUserId', 'loanerApprovedAt')), 0
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_constraint WHERE conname IN ('ServiceHandover_record_version', 'ServiceHandover_legacy_shape',
                          'ServiceHandover_balance', 'ServiceHandover_debt_decided', 'ServiceHandover_loaner_decided',
                          'ServiceHandover_debtApprovedByUserId_fkey', 'ServiceHandover_loanerApprovedByUserId_fkey')), 0
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                          AND proname IN ('service_handover_record_guard', 'service_handover_record_erase_business')), 0
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                          AND proname IN ('service_handover_guard', 'service_completion_guard', 'service_user_same_business',
                                          'service_ui_business_writable', 'service_tracks_in_erasure')), 5
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_trigger WHERE tgrelid = to_regclass('public."ServiceHandover"')
                          AND tgname IN ('ServiceHandover_user_same_business', 'ServiceHandover_guard'))
                    - (SELECT count(*) FROM pg_trigger WHERE tgrelid = to_regclass('public."ServiceHandover"') AND tgname = 'ServiceHandover_record_guard'), 2
  UNION ALL SELECT 10, (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls), 1
  UNION ALL SELECT 11, (SELECT count(*) FROM pg_class k JOIN pg_roles r ON r.oid = k.relowner
                         WHERE k.relname = 'ServiceHandover' AND k.relnamespace = 'public'::regnamespace AND (r.rolbypassrls OR r.rolsuper)), 1
  UNION ALL SELECT 12, (SELECT count(*) FROM "ServiceHandover"), NULL
  UNION ALL SELECT 13, (SELECT count(*) FROM "ServiceHandover" WHERE "openBalanceAgorot" < 0), NULL
  UNION ALL SELECT 14, (SELECT count(*) FROM "ServiceHandover" WHERE "openBalanceAgorot" > 0), NULL
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
