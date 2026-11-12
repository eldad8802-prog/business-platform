-- ============================================================================
-- service-desk-case-charge-production-evidence.sql
--
-- Read-only EVIDENCE after migration 20261126090000_service_desk_case_charge was applied.
--
-- Proves:
--   * the migration is recorded once, finished, not rolled back; the ledger is clean;
--   * the three enum types with their exact labels in order; the six new ServiceEventType / ServiceCaseAction values;
--   * the journal CHECK ServiceCaseEvent_charge_in_place exists and is validated (every existing journal row passes it);
--   * the two tables with ENABLE + FORCE row-level security; exactly the five per-operation policies (no removal policy,
--     no change policy on the charge history);
--   * the seven table CHECKs (validated); the five indexes (four unique, the one-active-link-per-document one partial);
--     the eight foreign keys by name, the three user keys setting NULL when the user goes;
--   * billing untouched, from the CATALOG only (no billing row is read): no foreign key from the two tables to
--     BillingDocument and no trigger on BillingDocument runs one of the four functions; the link guard reads it as the
--     caller (SECURITY INVOKER, below) and app_runtime holds SELECT on it;
--   * the six triggers by name, function and enabled state;
--   * the four functions: the exact reviewed text (md5 of the body), search_path pg_catalog, public, pg_temp; exactly
--     one SECURITY DEFINER (the erase), owned by the table owner who carries BYPASSRLS or is a superuser; none
--     executable by PUBLIC; app_runtime executes exactly the erase and the erasure-marker helper;
--   * app_runtime rights, read from the ACL letters: ServiceCaseCharge exactly ar (read, append), ServiceCaseBillingLink
--     exactly arw (read, append, change), both sequences exactly rU; no other grantee on the four relations;
--   * data invariants: no gap in a case charge history; every quote-sourced charge equals its quote version's approved
--     ILS amount; no billing document actively linked twice;
--   * informational counts: charge records, active and unlinked links, journal events of the three new actions.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== service desk case charge evidence: legend (n -> check) =='
\echo ' 1 the migration is recorded once, finished, not rolled back'
\echo ' 2 ledger: no unfinished and no rolled-back row'
\echo ' 3 the three enum types exist with their exact labels in order (of 3)'
\echo ' 4 the six new ServiceEventType / ServiceCaseAction values exist (of 6)'
\echo ' 5 the journal CHECK ServiceCaseEvent_charge_in_place exists and is validated'
\echo ' 6 both tables ENABLE + FORCE row-level security (of 2)'
\echo ' 7 exactly the five per-operation policies (5; any other policy counts 10)'
\echo ' 8 the seven table CHECKs exist and are validated (of 7)'
\echo ' 9 the five indexes: four unique, the active-link one partial, the case index plain (of 5)'
\echo '10 the eight foreign keys exist (of 8)'
\echo '11 the three user foreign keys set NULL when the user goes (of 3)'
\echo '12 billing untouched (catalog): foreign keys to BillingDocument + BillingDocument triggers running these functions (expected 0)'
\echo '13 the six triggers exist on their function and are enabled (of 6)'
\echo '14 the four functions carry the exact reviewed text (md5 of the body) (of 4)'
\echo '15 the four functions run with search_path pg_catalog, public, pg_temp (of 4)'
\echo '16 exactly one of them is SECURITY DEFINER: the erase (1)'
\echo '17 the erase is owned by the ServiceCaseCharge owner, who carries BYPASSRLS or is a superuser'
\echo '18 none of the four executable by PUBLIC (expected 0)'
\echo '19 app_runtime executes exactly the erase and the erasure-marker helper (2; any other counts 10)'
\echo '20 app_runtime holds SELECT on BillingDocument (catalog; the link guard reads as the caller)'
\echo '21 app_runtime ACL letters: ServiceCaseCharge ar, ServiceCaseBillingLink arw (of 2)'
\echo '22 app_runtime ACL letters on both sequences: rU (of 2)'
\echo '23 any other grantee on the two tables or their sequences (expected 0)'
\echo '24 cases whose charge history has a gap in seq (expected 0)'
\echo '25 quote-sourced charges not equal to their quote version approved ILS amount (expected 0)'
\echo '26 billing documents actively linked more than once (expected 0)'
\echo '27 charge records (informational)'
\echo '28 active billing links (informational)'
\echo '29 unlinked billing links (informational)'
\echo '30 journal events of the three new actions (informational)'

WITH f AS (
  SELECT p.oid, p.proname, p.prosecdef, p.proowner, p.prosrc, array_to_string(p.proconfig, ',') AS cfg FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('service_charge_in_erasure', 'service_case_charge_guard', 'service_case_billing_link_guard', 'service_case_charge_erase_business')
), t AS (
  SELECT k.oid, k.relname, k.relowner, k.relacl FROM pg_class k
   WHERE k.relnamespace = 'public'::regnamespace
     AND k.relname IN ('ServiceCaseCharge', 'ServiceCaseBillingLink', 'ServiceCaseCharge_id_seq', 'ServiceCaseBillingLink_id_seq')
), e AS (
  SELECT ty.typname, string_agg(en.enumlabel, ',' ORDER BY en.enumsortorder) AS labels
    FROM pg_type ty JOIN pg_enum en ON en.enumtypid = ty.oid
   WHERE ty.typnamespace = 'public'::regnamespace AND ty.typname IN ('ServiceChargeMode', 'ServiceChargeSource', 'ServiceBillingLinkRole')
   GROUP BY ty.typname
), c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261126090000_service_desk_case_charge'
                     AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
               + (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261126090000_service_desk_case_charge'
                     AND (finished_at IS NULL OR rolled_back_at IS NOT NULL)) * 10 AS observed, 1 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM e WHERE (typname, labels) IN (('ServiceChargeMode', 'CHARGEABLE,NO_CHARGE'),
                          ('ServiceChargeSource', 'APPROVED_QUOTE,OWNER_ENTERED'), ('ServiceBillingLinkRole', 'CHARGE,STANDALONE_PAYMENT,AFTER_SALE_CREDIT'))), 3
  UNION ALL SELECT 4, (SELECT count(*) FROM pg_enum en JOIN pg_type ty ON ty.oid = en.enumtypid
                        WHERE ty.typnamespace = 'public'::regnamespace
                          AND ((ty.typname = 'ServiceEventType' AND en.enumlabel IN ('charge.recorded', 'billing.linked', 'billing.unlinked'))
                            OR (ty.typname = 'ServiceCaseAction' AND en.enumlabel IN ('RECORD_CHARGE', 'LINK_BILLING_DOCUMENT', 'UNLINK_BILLING_DOCUMENT')))), 6
  UNION ALL SELECT 5, (SELECT count(*) FROM pg_constraint WHERE conname = 'ServiceCaseEvent_charge_in_place' AND contype = 'c' AND convalidated
                          AND conrelid = to_regclass('public."ServiceCaseEvent"')), 1
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('ServiceCaseCharge', 'ServiceCaseBillingLink')
                          AND relkind = 'r' AND relrowsecurity AND relforcerowsecurity), 2
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_policy p JOIN t ON t.oid = p.polrelid
                        WHERE (t.relname, p.polname, p.polcmd) IN (('ServiceCaseCharge', 'service_case_charge_tenant_select', 'r'),
                                                                   ('ServiceCaseCharge', 'service_case_charge_tenant_insert', 'a'),
                                                                   ('ServiceCaseBillingLink', 'service_case_billing_link_tenant_select', 'r'),
                                                                   ('ServiceCaseBillingLink', 'service_case_billing_link_tenant_insert', 'a'),
                                                                   ('ServiceCaseBillingLink', 'service_case_billing_link_tenant_update', 'w'))
                          AND p.polpermissive AND p.polroles = '{0}')
                    + (SELECT count(*) FROM pg_policy p JOIN t ON t.oid = p.polrelid
                        WHERE (t.relname, p.polname) NOT IN (('ServiceCaseCharge', 'service_case_charge_tenant_select'),
                                                             ('ServiceCaseCharge', 'service_case_charge_tenant_insert'),
                                                             ('ServiceCaseBillingLink', 'service_case_billing_link_tenant_select'),
                                                             ('ServiceCaseBillingLink', 'service_case_billing_link_tenant_insert'),
                                                             ('ServiceCaseBillingLink', 'service_case_billing_link_tenant_update'))) * 10, 5
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_constraint k JOIN t ON t.oid = k.conrelid WHERE k.contype = 'c' AND k.convalidated
                          AND k.conname IN ('ServiceCaseCharge_seq', 'ServiceCaseCharge_currency', 'ServiceCaseCharge_mode', 'ServiceCaseCharge_quote',
                                            'ServiceCaseCharge_reason_text', 'ServiceCaseCharge_reason_required', 'ServiceCaseBillingLink_unlink')), 7
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_index i JOIN pg_class k ON k.oid = i.indexrelid JOIN t ON t.oid = i.indrelid
                        WHERE (k.relname, i.indisunique, i.indpred IS NOT NULL) IN (('ServiceCaseCharge_businessId_id_key', true, false),
                                                                                   ('ServiceCaseCharge_businessId_caseId_seq_key', true, false),
                                                                                   ('ServiceCaseBillingLink_businessId_id_key', true, false),
                                                                                   ('ServiceCaseBillingLink_one_active_per_document', true, true),
                                                                                   ('ServiceCaseBillingLink_businessId_caseId_idx', false, false))), 5
  UNION ALL SELECT 10, (SELECT count(*) FROM pg_constraint k JOIN t ON t.oid = k.conrelid WHERE k.contype = 'f'
                          AND k.conname IN ('ServiceCaseCharge_businessId_fkey', 'ServiceCaseCharge_case_fkey', 'ServiceCaseCharge_quote_fkey',
                                            'ServiceCaseCharge_actor_fkey', 'ServiceCaseBillingLink_businessId_fkey', 'ServiceCaseBillingLink_case_fkey',
                                            'ServiceCaseBillingLink_linkedBy_fkey', 'ServiceCaseBillingLink_unlinkedBy_fkey')), 8
  UNION ALL SELECT 11, (SELECT count(*) FROM pg_constraint k JOIN t ON t.oid = k.conrelid WHERE k.contype = 'f'
                          AND k.confrelid = to_regclass('public."User"') AND k.confdeltype = 'n'), 3
  UNION ALL SELECT 12, (SELECT count(*) FROM pg_constraint k JOIN t ON t.oid = k.conrelid WHERE k.contype = 'f'
                          AND k.confrelid = to_regclass('public."BillingDocument"'))
                     + (SELECT count(*) FROM pg_trigger g JOIN f ON f.oid = g.tgfoid WHERE g.tgrelid = to_regclass('public."BillingDocument"')), 0
  UNION ALL SELECT 13, (SELECT count(*) FROM pg_trigger g JOIN t ON t.oid = g.tgrelid JOIN pg_proc p ON p.oid = g.tgfoid
                         WHERE NOT g.tgisinternal AND g.tgenabled = 'O'
                           AND (t.relname, g.tgname, p.proname) IN (('ServiceCaseCharge', 'ServiceCaseCharge_user_same_business', 'service_user_same_business'),
                                                                    ('ServiceCaseCharge', 'ServiceCaseCharge_guard', 'service_case_charge_guard'),
                                                                    ('ServiceCaseCharge', 'ServiceCaseCharge_no_truncate', 'service_journal_truncate_guard'),
                                                                    ('ServiceCaseBillingLink', 'ServiceCaseBillingLink_user_same_business', 'service_user_same_business'),
                                                                    ('ServiceCaseBillingLink', 'ServiceCaseBillingLink_guard', 'service_case_billing_link_guard'),
                                                                    ('ServiceCaseBillingLink', 'ServiceCaseBillingLink_no_truncate', 'service_journal_truncate_guard'))), 6
  UNION ALL SELECT 14, (SELECT count(*) FROM f WHERE (proname, md5(prosrc)) IN (('service_charge_in_erasure', '26f9d4b039c0b566f9412c22d0833d65'),
                                                                              ('service_case_charge_guard', '39abe74ebf5123df1a92a863b73e4a96'),
                                                                              ('service_case_billing_link_guard', 'fa2d97c2512d3e4fdb818c871becc3ea'),
                                                                              ('service_case_charge_erase_business', '04fe62bd6e9acd6cbb588331f53c3e25'))), 4
  UNION ALL SELECT 15, (SELECT count(*) FROM f WHERE cfg = 'search_path=pg_catalog, public, pg_temp'), 4
  UNION ALL SELECT 16, (SELECT count(*) FROM f WHERE prosecdef AND proname = 'service_case_charge_erase_business')
                     + (SELECT count(*) FROM f WHERE prosecdef AND proname <> 'service_case_charge_erase_business') * 10, 1
  UNION ALL SELECT 17, (SELECT count(*) FROM f JOIN pg_roles r ON r.oid = f.proowner
                         WHERE f.proname = 'service_case_charge_erase_business' AND (r.rolbypassrls OR r.rolsuper)
                           AND f.proowner = (SELECT relowner FROM t WHERE relname = 'ServiceCaseCharge')), 1
  UNION ALL SELECT 18, (SELECT count(*) FROM f WHERE has_function_privilege('public', oid, 'EXECUTE')), 0
  UNION ALL SELECT 19, (SELECT count(*) FROM f WHERE proname IN ('service_case_charge_erase_business', 'service_charge_in_erasure')
                          AND has_function_privilege('app_runtime', oid, 'EXECUTE'))
                     + (SELECT count(*) FROM f WHERE proname NOT IN ('service_case_charge_erase_business', 'service_charge_in_erasure')
                          AND has_function_privilege('app_runtime', oid, 'EXECUTE')) * 10, 2
  UNION ALL SELECT 20, (SELECT count(*) FROM pg_class WHERE oid = to_regclass('public."BillingDocument"')
                          AND has_table_privilege('app_runtime', oid, 'SELECT')), 1
  UNION ALL SELECT 21, (SELECT count(*) FROM t CROSS JOIN LATERAL unnest(t.relacl) a
                         WHERE (t.relname, split_part(a::text, '/', 1)) IN (('ServiceCaseCharge', 'app_runtime=ar'), ('ServiceCaseBillingLink', 'app_runtime=arw'))), 2
  UNION ALL SELECT 22, (SELECT count(*) FROM t CROSS JOIN LATERAL unnest(t.relacl) a
                         WHERE t.relname IN ('ServiceCaseCharge_id_seq', 'ServiceCaseBillingLink_id_seq') AND split_part(a::text, '/', 1) = 'app_runtime=rU'), 2
  UNION ALL SELECT 23, (SELECT count(*) FROM t CROSS JOIN LATERAL aclexplode(t.relacl) x
                         WHERE x.grantee <> t.relowner AND (x.grantee = 0 OR pg_get_userbyid(x.grantee) <> 'app_runtime')), 0
  UNION ALL SELECT 24, (SELECT count(*) FROM (SELECT 1 FROM "ServiceCaseCharge" GROUP BY "businessId", "caseId"
                          HAVING max("seq") <> count(*) OR min("seq") <> 1) g), 0
  UNION ALL SELECT 25, (SELECT count(*) FROM "ServiceCaseCharge" h WHERE h."source" = 'APPROVED_QUOTE'
                          AND NOT EXISTS (SELECT 1 FROM "ServiceQuote" q WHERE q."businessId" = h."businessId" AND q."caseId" = h."caseId"
                                            AND q."version" = h."quoteVersion" AND q."approvedTotalAgorot" = h."amountAgorot" AND q."currency" = 'ILS')), 0
  UNION ALL SELECT 26, (SELECT count(*) FROM (SELECT 1 FROM "ServiceCaseBillingLink" WHERE "unlinkedAt" IS NULL
                          GROUP BY "businessId", "billingDocumentId" HAVING count(*) > 1) d), 0
  UNION ALL SELECT 27, (SELECT count(*) FROM "ServiceCaseCharge"), NULL
  UNION ALL SELECT 28, (SELECT count(*) FROM "ServiceCaseBillingLink" WHERE "unlinkedAt" IS NULL), NULL
  UNION ALL SELECT 29, (SELECT count(*) FROM "ServiceCaseBillingLink" WHERE "unlinkedAt" IS NOT NULL), NULL
  UNION ALL SELECT 30, (SELECT count(*) FROM "ServiceCaseEvent" WHERE "action"::text IN ('RECORD_CHARGE', 'LINK_BILLING_DOCUMENT', 'UNLINK_BILLING_DOCUMENT')), NULL
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
