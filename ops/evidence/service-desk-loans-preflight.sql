-- ============================================================================
-- service-desk-loans-preflight.sql
--
-- Read-only PREFLIGHT before migration
--   20261201090000_service_desk_loans   (NOT applied)
--
-- Proves Production is the shape the migration expects:
--   * the ledger is clean; this migration is not recorded; nothing after it is finished;
--   * the handover record (20261130090000_service_handover_debt_record) is recorded and finished, and its three loaner
--     columns on ServiceHandover exist — they are a premise;
--   * none of the names it introduces exists yet: the two tables, the five enum types, the eight functions, the two
--     triggers it adds on ServiceCase / ServiceHandover;
--   * the functions it reuses exist (3) and the (businessId, id) keys of ServiceCase and InventoryItem exist (2);
--   * app_runtime exists NOLOGIN NOSUPERUSER NOBYPASSRLS; the owner of ServiceCase carries BYPASSRLS or is a superuser;
--   * informational: cases; version-2 handovers that carry a loaner exception (any of reason / approver / approval time)
--     — none of them can have an open loan, the loan table does not exist yet; the migration's handover rule (no loan
--     out ⇒ no loaner exception) judges NEW rows only, so these rows stay valid and never stop it;
--     legacy version-1 handovers with a loaner reason (the same: never re-judged).
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== service desk loans preflight: legend (n -> check) =='
\echo ' 1 ledger: no unfinished and no rolled-back row'
\echo ' 2 20261201090000_service_desk_loans is NOT recorded'
\echo ' 3 no finished migration sorts after it'
\echo ' 4 the handover record 20261130090000 is recorded and finished'
\echo ' 5 the three ServiceHandover loaner columns exist (of 3)'
\echo ' 6 neither loan table exists yet'
\echo ' 7 none of the five loan enum types exists yet'
\echo ' 8 none of the eight loan functions exists yet'
\echo ' 9 neither loan trigger on ServiceCase / ServiceHandover exists yet'
\echo '10 the functions it reuses exist (of 3)'
\echo '11 the (businessId, id) keys of ServiceCase and InventoryItem exist (of 2)'
\echo '12 app_runtime exists NOLOGIN NOSUPERUSER NOBYPASSRLS'
\echo '13 the owner of ServiceCase carries BYPASSRLS or is a superuser'
\echo '14 service cases (informational)'
\echo '15 version-2 handovers with a loaner exception and no open loan (informational; the rule judges new rows only, they stay valid)'
\echo '16 version-1 (legacy) handovers with a loaner reason (informational; never re-judged)'

WITH c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) AS observed, 0 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261201090000_service_desk_loans'), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name > '20261201090000_service_desk_loans' AND finished_at IS NOT NULL), 0
  UNION ALL SELECT 4, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261130090000_service_handover_debt_record'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL), 1
  UNION ALL SELECT 5, (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ServiceHandover'
                          AND column_name IN ('loanerOverrideReason', 'loanerApprovedByUserId', 'loanerApprovedAt')), 3
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('ServiceLoan', 'ServiceLoanEvent')), 0
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_type WHERE typnamespace = 'public'::regnamespace
                          AND typname IN ('ServiceLoanState', 'ServiceLoanCondition', 'ServiceLoanCloseReason', 'ServiceLoanEventKind', 'ServiceLoanApprovalKind')), 0
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                          AND proname IN ('service_loan_insert_guard', 'service_loan_guard', 'service_loan_has_event', 'service_loan_event_matches_loan',
                                          'service_loan_event_guard', 'service_loan_case_exit_guard', 'service_loan_handover_guard', 'service_loan_erase_business')), 0
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_trigger WHERE tgname IN ('ServiceCase_loan_exit_guard', 'ServiceHandover_loan_guard')), 0
  UNION ALL SELECT 10, (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                          AND proname IN ('service_user_same_business', 'service_journal_truncate_guard', 'service_ui_business_writable')), 3
  UNION ALL SELECT 11, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace
                          AND relname IN ('ServiceCase_businessId_id_key', 'InventoryItem_id_businessId_key')), 2
  UNION ALL SELECT 12, (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls), 1
  UNION ALL SELECT 13, (SELECT count(*) FROM pg_class k JOIN pg_roles r ON r.oid = k.relowner
                         WHERE k.relname = 'ServiceCase' AND k.relnamespace = 'public'::regnamespace AND (r.rolbypassrls OR r.rolsuper)), 1
  UNION ALL SELECT 14, (SELECT count(*) FROM "ServiceCase"), NULL
  UNION ALL SELECT 15, (SELECT count(*) FROM "ServiceHandover" WHERE "recordVersion" = 2
                          AND ("loanerOverrideReason" IS NOT NULL OR "loanerApprovedByUserId" IS NOT NULL OR "loanerApprovedAt" IS NOT NULL)), NULL
  UNION ALL SELECT 16, (SELECT count(*) FROM "ServiceHandover" WHERE "recordVersion" = 1 AND "loanerOverrideReason" IS NOT NULL), NULL
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
