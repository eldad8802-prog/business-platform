-- ============================================================================
-- issuer-declaration-production-evidence.sql
--
-- Read-only EVIDENCE right after migration 20261126100000_issuer_declaration is applied (release-migrate).
-- Proves the objects are there exactly as designed AND that nothing is active yet:
--   * recorded and finished; three tables; FORCE row-level security on the two tenant tables;
--   * the 12 functions exist; every SECURITY DEFINER one pins search_path; none is executable by PUBLIC;
--   * the five triggers on existing tables exist and are enabled;
--   * privileges: the runtime may only read/add declarations and openings, read the enforcement switch, run the erase;
--     it holds no other privilege on the three tables and may not execute a designation; app_admin may execute both;
--   * INERT: the enforcement table is empty; no declaration and no opening exists → issuing, profile saves and
--     numbering behave exactly as before (compare 13/14 with the preflight's 13/14).
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== issuer declaration production evidence: legend (n -> check) =='
\echo ' 1 20261126100000_issuer_declaration recorded and finished'
\echo ' 2 the three tables exist'
\echo ' 3 FORCE row-level security on BusinessIssuerDeclaration and BillingSeriesOpening (of 2)'
\echo ' 4 the 12 functions exist'
\echo ' 5 SECURITY DEFINER functions without a pinned search_path (must be 0)'
\echo ' 6 of the 12 functions, executable by PUBLIC (must be 0)'
\echo ' 7 the five triggers on existing tables exist and are enabled'
\echo ' 8 runtime privileges on the three tables beyond SELECT (exactly 2: adding declarations and openings)'
\echo ' 9 runtime may execute a designation function (must be 0)'
\echo '10 app_admin may execute both designation functions (of 2)'
\echo '11 enforcement rows (must be 0 — enforcement is a separate decision)'
\echo '12 declarations + openings (must be 0 — nothing writes them before the code release)'
\echo '13 issued fiscal documents (informational — equal to the preflight value 13)'
\echo '14 number counters (informational — equal to the preflight value 14)'
\echo '15 20261126090000_auth_issuer_declaration_link recorded (informational — applied before this one on 2026-11-14; expect 1)'

WITH fns(name) AS (VALUES ('issuer_records_append_only_guard'), ('issuer_declaration_chain_guard'), ('issuer_designation_origin_guard'),
      ('issuer_designate_authorized_user'), ('issuer_designate_initial'), ('series_opening_unused_guard'), ('series_opening_apply'),
      ('issuer_records_truncate_guard'), ('issuer_issue_requires_declaration'), ('issuer_business_is_being_deleted'),
      ('issuer_profile_identity_lock'), ('issuer_declaration_erase')),
p AS (SELECT pr.* FROM pg_proc pr JOIN fns ON fns.name = pr.proname WHERE pr.pronamespace = 'public'::regnamespace),
c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261126100000_issuer_declaration'
                    AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS observed, 1 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace
      AND relname IN ('BusinessIssuerDeclaration', 'BillingSeriesOpening', 'IssuerDeclarationEnforcement')), 3
  UNION ALL SELECT 3, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace
      AND relname IN ('BusinessIssuerDeclaration', 'BillingSeriesOpening') AND relrowsecurity AND relforcerowsecurity), 2
  UNION ALL SELECT 4, (SELECT count(DISTINCT proname) FROM p), 12
  UNION ALL SELECT 5, (SELECT count(*) FROM p WHERE prosecdef
      AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(proconfig, '{}')) cfg WHERE cfg LIKE 'search_path=%')), 0
  UNION ALL SELECT 6, (SELECT count(*) FROM p WHERE has_function_privilege('public', p.oid, 'EXECUTE')), 0
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'O' AND tgname IN (
      'BillingDocument_issue_requires_declaration', 'BillingDocument_insert_issued_requires_declaration',
      'BusinessProfile_issuer_identity_lock', 'BusinessProfile_issuer_identity_lock_insert', 'BillingDocumentNumberSequence_series_opening')), 5
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_class k CROSS JOIN LATERAL aclexplode(k.relacl) x
      WHERE k.relnamespace = 'public'::regnamespace AND k.relname IN ('BusinessIssuerDeclaration', 'BillingSeriesOpening', 'IssuerDeclarationEnforcement')
        AND x.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime') AND x.privilege_type <> 'SELECT'), 2
  UNION ALL SELECT 9, (SELECT count(*) FROM p WHERE proname IN ('issuer_designate_authorized_user', 'issuer_designate_initial')
      AND has_function_privilege('app_runtime', p.oid, 'EXECUTE')), 0
  UNION ALL SELECT 10, (SELECT count(*) FROM p WHERE proname IN ('issuer_designate_authorized_user', 'issuer_designate_initial')
      AND has_function_privilege('app_admin', p.oid, 'EXECUTE')), 2
  UNION ALL SELECT 11, (SELECT count(*) FROM "IssuerDeclarationEnforcement"), 0
  UNION ALL SELECT 12, (SELECT count(*) FROM "BusinessIssuerDeclaration") + (SELECT count(*) FROM "BillingSeriesOpening"), 0
  UNION ALL SELECT 13, (SELECT count(*) FROM "BillingDocument" WHERE status::text = 'ISSUED'
      AND "documentType"::text IN ('TAX_INVOICE', 'TAX_INVOICE_RECEIPT', 'RECEIPT', 'CREDIT_NOTE')), NULL
  UNION ALL SELECT 14, (SELECT count(*) FROM "BillingDocumentNumberSequence"), NULL
  UNION ALL SELECT 15, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261126090000_auth_issuer_declaration_link' AND finished_at IS NOT NULL), NULL
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
FROM c ORDER BY n;
