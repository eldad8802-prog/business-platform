-- ============================================================================
-- issuer-declaration-preflight.sql
--
-- Read-only PREFLIGHT before migration
--   20261126100000_issuer_declaration   (NOT applied)
--
-- Proves Production is the shape the migration expects:
--   * the ledger is clean; this migration is not recorded; no finished migration sorts after it (release-migrate
--     applies the first pending migrations in Prisma order — a later migration already applied would leave this one
--     out of order); and 20261126090000_auth_issuer_declaration_link (#1105) IS recorded and finished — it was applied
--     alone in Production on 2026-11-14 (release-migrate 43617171163), so this migration was re-timestamped to sort
--     right after it and is applied ALONE;
--   * none of the names it introduces exists yet (3 tables, 8 enum types, 12 functions, 5 triggers on existing tables);
--   * the existing tables it attaches triggers to exist (BillingDocument, BusinessProfile, BillingDocumentNumberSequence,
--     User, Business);
--   * app_runtime exists NOLOGIN NOSUPERUSER NOBYPASSRLS; app_admin exists (designation grants);
--   * no long transaction holds BillingDocument / BusinessProfile / BillingDocumentNumberSequence (the migration runs
--     with lock_timeout 3s — it fails fast instead of queueing issuance; re-run when this is 0);
--   * informational: enforcement-relevant counts the migration must NOT change (issued fiscal documents, counters).
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== issuer declaration preflight: legend (n -> check) =='
\echo ' 1 ledger: no unfinished and no rolled-back row'
\echo ' 2 20261126100000_issuer_declaration is NOT recorded'
\echo ' 3 no finished migration sorts after it (nothing applied out of order ahead of it)'
\echo ' 4 none of the three new tables exists yet'
\echo ' 5 none of the eight new enum types exists yet'
\echo ' 6 none of the 12 new functions exists yet'
\echo ' 7 none of the five new triggers on existing tables exists yet'
\echo ' 8 the existing tables it attaches to exist (of 5)'
\echo ' 9 app_runtime exists NOLOGIN NOSUPERUSER NOBYPASSRLS'
\echo '10 app_admin exists (designation functions are granted to it)'
\echo '11 transactions older than 60 s touching the billing tables (must be 0 to apply)'
\echo '12 20261126090000_auth_issuer_declaration_link (#1105) is recorded and finished (applied before this one)'
\echo '13 issued fiscal documents (informational — the migration changes none)'
\echo '14 number counters (informational — the migration changes none)'

WITH c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) AS observed, 0 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261126100000_issuer_declaration'), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name > '20261126100000_issuer_declaration' AND finished_at IS NOT NULL), 0
  UNION ALL SELECT 4, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace
      AND relname IN ('BusinessIssuerDeclaration', 'BillingSeriesOpening', 'IssuerDeclarationEnforcement')), 0
  UNION ALL SELECT 5, (SELECT count(*) FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typname IN ('IssuerTrack', 'IssuerLegalForm',
      'IssuerVatStatus', 'IssuerIdType', 'IssuerDeclarationKind', 'IssuerAuthorityBasis', 'IssuerReauthMethod', 'SeriesOpeningSource')), 0
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('issuer_records_append_only_guard',
      'issuer_declaration_chain_guard', 'issuer_designation_origin_guard', 'issuer_designate_authorized_user', 'issuer_designate_initial',
      'series_opening_unused_guard', 'series_opening_apply', 'issuer_records_truncate_guard', 'issuer_issue_requires_declaration',
      'issuer_business_is_being_deleted', 'issuer_profile_identity_lock', 'issuer_declaration_erase')), 0
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('BillingDocument_issue_requires_declaration',
      'BillingDocument_insert_issued_requires_declaration', 'BusinessProfile_issuer_identity_lock', 'BusinessProfile_issuer_identity_lock_insert',
      'BillingDocumentNumberSequence_series_opening')), 0
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p')
      AND relname IN ('BillingDocument', 'BusinessProfile', 'BillingDocumentNumberSequence', 'User', 'Business')), 5
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls), 1
  UNION ALL SELECT 10, (SELECT count(*) FROM pg_roles WHERE rolname = 'app_admin'), 1
  UNION ALL SELECT 11, (SELECT count(DISTINCT a.pid) FROM pg_stat_activity a JOIN pg_locks l ON l.pid = a.pid
      JOIN pg_class k ON k.oid = l.relation
      WHERE k.relname IN ('BillingDocument', 'BusinessProfile', 'BillingDocumentNumberSequence')
        AND a.xact_start < now() - interval '60 seconds' AND a.pid <> pg_backend_pid()), 0
  UNION ALL SELECT 12, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261126090000_auth_issuer_declaration_link'
      AND finished_at IS NOT NULL AND rolled_back_at IS NULL), 1
  UNION ALL SELECT 13, (SELECT count(*) FROM "BillingDocument" WHERE status::text = 'ISSUED'
      AND "documentType"::text IN ('TAX_INVOICE', 'TAX_INVOICE_RECEIPT', 'RECEIPT', 'CREDIT_NOTE')), NULL
  UNION ALL SELECT 14, (SELECT count(*) FROM "BillingDocumentNumberSequence"), NULL
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
FROM c ORDER BY n;
