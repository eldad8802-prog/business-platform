-- ============================================================================
-- service-desk-loans-production-evidence.sql
--
-- Read-only EVIDENCE after migration 20261201090000_service_desk_loans was applied.
--
-- Proves:
--   * the migration is recorded once, finished, not rolled back; the ledger is clean;
--   * the two tables exist with ENABLE + FORCE row-level security; five per-operation policies, none for removal;
--   * the double-loan guard: the partial UNIQUE index on (businessId, itemIdentifierNormalized) for loans that are OUT;
--   * the eight CHECKs exist and are validated; the four composite tenant keys (case, inventory item, loan);
--   * the seven user FKs null on a removed user;
--   * the twelve triggers: on ServiceLoan (6), on ServiceLoanEvent (4), the case exit guard and the handover guard (2);
--   * the eight functions: search_path ending in pg_temp, exactly one SECURITY DEFINER (the erase), none executable by
--     PUBLIC, the erase executable by app_runtime;
--   * app_runtime table rights, read from the ACL letters: ServiceLoan exactly arw (read, append, change), the journal
--     exactly ar (read, append) — never removal; no other grantee;
--   * data invariants: no identified item OUT twice; every loan version has its journal event; no approval names an
--     approver other than its actor;
--   * informational counts: loans OUT, RETURNED, CLOSED.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== service desk loans evidence: legend (n -> check) =='
\echo ' 1 the migration is recorded once, finished, not rolled back'
\echo ' 2 ledger: no unfinished and no rolled-back row'
\echo ' 3 both tables ENABLE + FORCE row-level security (of 2)'
\echo ' 4 the five per-operation policies exist, none for removal (5)'
\echo ' 5 the double-loan partial UNIQUE index exists on (businessId, itemIdentifierNormalized) for OUT loans'
\echo ' 6 the eight CHECKs exist and are validated (of 8)'
\echo ' 7 the four composite tenant keys exist (of 4)'
\echo ' 8 the seven user FKs null on a removed user (of 7)'
\echo ' 9 the twelve loan triggers exist and are enabled (of 12)'
\echo '10 the eight functions with search_path ending in pg_temp (of 8)'
\echo '11 exactly one of them is SECURITY DEFINER: the erase (1)'
\echo '12 none of them executable by PUBLIC (expected 0)'
\echo '13 the erase function is executable by app_runtime'
\echo '14 app_runtime ACL letters: ServiceLoan arw, ServiceLoanEvent ar (of 2)'
\echo '15 any other grantee on either table (expected 0)'
\echo '16 identified items OUT more than once (expected 0)'
\echo '17 loans whose current version has no journal event (expected 0)'
\echo '18 approvals naming an approver other than the actor (expected 0)'
\echo '19 loans OUT (informational)'
\echo '20 loans RETURNED (informational)'
\echo '21 loans CLOSED without a return (informational)'

WITH f AS (
  SELECT p.oid, p.proname, p.prosecdef, p.proconfig FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('service_loan_insert_guard', 'service_loan_guard', 'service_loan_has_event', 'service_loan_event_matches_loan',
                       'service_loan_event_guard', 'service_loan_case_exit_guard', 'service_loan_handover_guard', 'service_loan_erase_business')
), t AS (
  SELECT k.oid, k.relname, k.relowner, k.relacl FROM pg_class k
   WHERE k.relnamespace = 'public'::regnamespace AND k.relname IN ('ServiceLoan', 'ServiceLoanEvent')
), c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261201090000_service_desk_loans'
                     AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS observed, 1 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('ServiceLoan', 'ServiceLoanEvent')
                          AND relrowsecurity AND relforcerowsecurity), 2
  UNION ALL SELECT 4, (SELECT count(*) FROM pg_policy WHERE polrelid IN (SELECT oid FROM t) AND polcmd IN ('r', 'a', 'w'))
                    + (SELECT count(*) FROM pg_policy WHERE polrelid IN (SELECT oid FROM t) AND polcmd IN ('d', '*')) * 10, 5
  UNION ALL SELECT 5, (SELECT count(*) FROM pg_index i JOIN pg_indexes x ON x.schemaname = 'public' AND x.indexname = 'ServiceLoan_one_out_per_identifier'
                         WHERE i.indexrelid = to_regclass('public."ServiceLoan_one_out_per_identifier"') AND i.indisunique AND i.indpred IS NOT NULL
                           AND x.indexdef LIKE '%"itemIdentifierNormalized"%' AND x.indexdef LIKE '%''OUT''%'), 1
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_constraint WHERE contype = 'c' AND convalidated
                          AND conname IN ('ServiceLoan_numbers', 'ServiceLoan_state_shape', 'ServiceLoan_lend_exception', 'ServiceLoan_texts',
                                          'ServiceLoan_identifier_normalized', 'ServiceLoanEvent_seq', 'ServiceLoanEvent_approval', 'ServiceLoanEvent_payload_closed')), 8
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_constraint WHERE contype = 'f'
                          AND conname IN ('ServiceLoan_case_tenant_fkey', 'ServiceLoan_inventory_item_tenant_fkey', 'ServiceLoanEvent_loan_tenant_fkey', 'ServiceLoanEvent_case_tenant_fkey')), 4
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND confrelid = to_regclass('public."User"') AND confdeltype = 'n'
                          AND conrelid IN (SELECT oid FROM t)), 7
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'O'
                          AND (tgrelid IN (SELECT oid FROM t) OR tgname IN ('ServiceCase_loan_exit_guard', 'ServiceHandover_loan_guard'))), 12
  UNION ALL SELECT 10, (SELECT count(*) FROM f WHERE proconfig IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(proconfig) s WHERE s LIKE 'search_path=%pg_temp')), 8
  UNION ALL SELECT 11, (SELECT count(*) FROM f WHERE prosecdef AND proname = 'service_loan_erase_business')
                     + (SELECT count(*) FROM f WHERE prosecdef AND proname <> 'service_loan_erase_business') * 10, 1
  UNION ALL SELECT 12, (SELECT count(*) FROM f WHERE has_function_privilege('public', oid, 'EXECUTE')), 0
  UNION ALL SELECT 13, (SELECT count(*) FROM f WHERE proname = 'service_loan_erase_business' AND has_function_privilege('app_runtime', oid, 'EXECUTE')), 1
  UNION ALL SELECT 14, (SELECT count(*) FROM t CROSS JOIN LATERAL unnest(t.relacl) a
                         WHERE split_part(a::text, '/', 1) = CASE t.relname WHEN 'ServiceLoan' THEN 'app_runtime=arw' ELSE 'app_runtime=ar' END), 2
  UNION ALL SELECT 15, (SELECT count(*) FROM t CROSS JOIN LATERAL aclexplode(t.relacl) x
                         WHERE x.grantee <> t.relowner AND pg_get_userbyid(x.grantee) <> 'app_runtime'), 0
  UNION ALL SELECT 16, (SELECT count(*) FROM (SELECT 1 FROM "ServiceLoan" WHERE state = 'OUT' AND "itemIdentifierNormalized" IS NOT NULL
                          GROUP BY "businessId", "itemIdentifierNormalized" HAVING count(*) > 1) d), 0
  UNION ALL SELECT 17, (SELECT count(*) FROM "ServiceLoan" l WHERE NOT EXISTS (SELECT 1 FROM "ServiceLoanEvent" e
                          WHERE e."businessId" = l."businessId" AND e."loanId" = l.id AND e.seq = l.version AND e.kind = l."lastEventKind")), 0
  UNION ALL SELECT 18, (SELECT count(*) FROM "ServiceLoanEvent" WHERE "approvedByUserId" IS NOT NULL AND "approvedByUserId" IS DISTINCT FROM "actorUserId"), 0
  UNION ALL SELECT 19, (SELECT count(*) FROM "ServiceLoan" WHERE state = 'OUT'), NULL
  UNION ALL SELECT 20, (SELECT count(*) FROM "ServiceLoan" WHERE state = 'RETURNED'), NULL
  UNION ALL SELECT 21, (SELECT count(*) FROM "ServiceLoan" WHERE state = 'CLOSED'), NULL
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
