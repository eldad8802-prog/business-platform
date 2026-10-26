-- ============================================================================
-- document-supplier-link-preflight.sql
--
-- Read-only Production PREFLIGHT before migration
--   20261103090000_document_supplier_link
--
-- Every premise the migration stands on, from the catalog and the ledger only:
--   * it is not recorded yet; no ledger row is unfinished or rolled back; the four migrations right before it are
--     recorded and finished (so it can be the FIRST pending migration of a release-migrate run);
--   * none of its objects exist yet: no new table, sequence, index or function, no ExtractedData issuer column or
--     constraint, no flag row, no business override;
--   * what it references exists: the composite keys "Document"(businessId, id) and "Supplier"(businessId, id), the
--     "Business" deletion columns the erasure function reads, the role app_runtime, and app_runtime's read of
--     "User"(id, businessId) that the same-business trigger performs as the runtime.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== document supplier link preflight: legend (n -> check) =='
\echo ' 1 this migration is not recorded yet (observed = ledger rows)'
\echo ' 2 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 3 the four migrations right before it are recorded and finished (observed = of 4)'
\echo ' 4 no relation named DocumentSupplierLink* exists yet (observed = relations)'
\echo ' 5 no document_supplier_link function exists yet (observed = functions)'
\echo ' 6 ExtractedData has none of the five issuer columns yet (observed = columns)'
\echo ' 7 ExtractedData has no ExtractedData_issuer* constraint yet (observed = constraints)'
\echo ' 8 the unique index Document_businessId_id_key exists on (businessId, id), valid (observed = of 1)'
\echo ' 9 the unique constraint Supplier_businessId_id_key exists on (businessId, id) (observed = of 1)'
\echo '10 the role app_runtime exists (observed = of 1)'
\echo '11 Business has deletionRequestedAt and deletedAt (observed = of 2)'
\echo '12 app_runtime may read User id and businessId (observed = of 2)'
\echo '13 no flag row for document_supplier_linking yet, and no business override (observed = rows)'
\echo '14 the tables the migration references exist: Business, User, Document, Supplier, ExtractedData, PlatformFeatureDefinition, PlatformFeaturePolicy (observed = of 7)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
rel AS (SELECT c.oid, c.relname, c.relkind FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub)),
ed AS (SELECT oid FROM rel WHERE relname = 'ExtractedData' AND relkind = 'r'),
prior(m) AS (VALUES ('20261030090000_oauth_identity_foundation'), ('20261031090000_bank_file_import_feature'),
                    ('20261101090000_oauth_ticket_cancel'), ('20261102090000_oauth_identity_link')),
new_cols(attname) AS (VALUES ('issuerTaxId'), ('issuerTaxIdSource'), ('issuerTaxIdValid'), ('issuerCheck'), ('ownBusinessExcluded')),
doc_key AS (
  SELECT i.indexrelid FROM pg_index i JOIN rel r ON r.oid = i.indexrelid
   WHERE r.relname = 'Document_businessId_id_key' AND i.indisunique AND i.indisvalid
     AND i.indrelid = (SELECT oid FROM rel WHERE relname = 'Document' AND relkind = 'r')
     AND array_length(i.indkey::int2[], 1) = 2),
sup_key AS (
  SELECT c.oid FROM pg_constraint c
   WHERE c.conname = 'Supplier_businessId_id_key' AND c.contype = 'u'
     AND c.conrelid = (SELECT oid FROM rel WHERE relname = 'Supplier' AND relkind = 'r')
     AND array_length(c.conkey, 1) = 2),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261103090000_document_supplier_link') = 0,
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261103090000_document_supplier_link')
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, (SELECT count(DISTINCT migration_name) FROM "_prisma_migrations"
                         WHERE migration_name IN (SELECT m FROM prior) AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 4,
                      (SELECT count(DISTINCT migration_name) FROM "_prisma_migrations"
                         WHERE migration_name IN (SELECT m FROM prior) AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 4, (SELECT count(*) FROM rel WHERE relname LIKE 'DocumentSupplierLink%') = 0,
                      (SELECT count(*) FROM rel WHERE relname LIKE 'DocumentSupplierLink%')
  UNION ALL SELECT 5, (SELECT count(*) FROM pg_proc WHERE pronamespace = (SELECT oid FROM pub) AND proname LIKE 'document\_supplier\_link\_%') = 0,
                      (SELECT count(*) FROM pg_proc WHERE pronamespace = (SELECT oid FROM pub) AND proname LIKE 'document\_supplier\_link\_%')
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_attribute WHERE attrelid = (SELECT oid FROM ed) AND NOT attisdropped
                         AND attname IN (SELECT attname FROM new_cols)) = 0,
                      (SELECT count(*) FROM pg_attribute WHERE attrelid = (SELECT oid FROM ed) AND NOT attisdropped
                         AND attname IN (SELECT attname FROM new_cols))
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_constraint WHERE conrelid = (SELECT oid FROM ed) AND conname LIKE 'ExtractedData\_issuer%') = 0,
                      (SELECT count(*) FROM pg_constraint WHERE conrelid = (SELECT oid FROM ed) AND conname LIKE 'ExtractedData\_issuer%')
  UNION ALL SELECT 8, (SELECT count(*) FROM doc_key) = 1, (SELECT count(*) FROM doc_key)
  UNION ALL SELECT 9, (SELECT count(*) FROM sup_key) = 1, (SELECT count(*) FROM sup_key)
  UNION ALL SELECT 10, (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime') = 1,
                       (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime')
  UNION ALL SELECT 11, (SELECT count(*) FROM pg_attribute WHERE attrelid = (SELECT oid FROM rel WHERE relname = 'Business' AND relkind = 'r')
                          AND NOT attisdropped AND attname IN ('deletionRequestedAt', 'deletedAt')) = 2,
                       (SELECT count(*) FROM pg_attribute WHERE attrelid = (SELECT oid FROM rel WHERE relname = 'Business' AND relkind = 'r')
                          AND NOT attisdropped AND attname IN ('deletionRequestedAt', 'deletedAt'))
  UNION ALL SELECT 12, (CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime')
                             THEN has_column_privilege('app_runtime', '"User"', 'id', 'SELECT')::int
                                + has_column_privilege('app_runtime', '"User"', 'businessId', 'SELECT')::int
                             ELSE 0 END) = 2,
                       (CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime')
                             THEN has_column_privilege('app_runtime', '"User"', 'id', 'SELECT')::int
                                + has_column_privilege('app_runtime', '"User"', 'businessId', 'SELECT')::int
                             ELSE 0 END)
  UNION ALL SELECT 13, (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE "key" = 'document_supplier_linking')
                       + (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'document_supplier_linking')
                       + (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'document_supplier_linking') = 0,
                       (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE "key" = 'document_supplier_linking')
                       + (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'document_supplier_linking')
                       + (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'document_supplier_linking')
  UNION ALL SELECT 14, (SELECT count(*) FROM rel WHERE relkind = 'r' AND relname IN
                          ('Business', 'User', 'Document', 'Supplier', 'ExtractedData', 'PlatformFeatureDefinition', 'PlatformFeaturePolicy')) = 7,
                       (SELECT count(*) FROM rel WHERE relkind = 'r' AND relname IN
                          ('Business', 'User', 'Document', 'Supplier', 'ExtractedData', 'PlatformFeatureDefinition', 'PlatformFeaturePolicy'))
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
