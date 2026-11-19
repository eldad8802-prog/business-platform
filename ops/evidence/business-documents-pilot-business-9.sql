-- ============================================================================
-- business-documents-pilot-business-9.sql
--
-- Read-only Production check for the business_documents pilot in business 9 (owner-approved 2026-11-10). The same
-- file runs at each stage, so its INFO values can be compared between runs:
--   S1 baseline, before the switch-on: no override of the feature anywhere;
--   S2 after the owner's switch-on in the admin screen, before any save: the only override is business 9 ENABLED;
--   S3 after the owner's phone test: the same override, one more purchase-order sheet of business 9 whose file is
--      COMMITTED under business 9's own po-sheets prefix, and business 9's orders and stock unchanged.
--
-- What it reads: the flag (definition + global policy), the overrides (business 9, business 38, any other),
-- business 9's sheets, their files and request keys, its letters and quote-share records, and data fingerprints of
-- business 9's supplier orders, purchase orders + receiving, and stock, each with its row count.
--
-- Fingerprints are stable: hashtext over every row as JSON (all columns, table column order), joined in a fixed
-- order (ORDER BY id), per table, in a fixed table order. Equal rows give an equal value in every run. A fingerprint
-- changes when any of those rows changes, is added or removed — or when a migration adds a column to that table:
-- check 21 (finished migrations) shows whether one ran between two runs. A change between runs is reported as
-- observed; it is not attributed to the feature without its own evidence (the row counts show what moved).
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend. PASS / FAIL where the value is fixed,
-- INFO where it is compared between runs. Flags, counts and hashes only: no business data is printed.
-- Read only: one READ ONLY transaction, rolled back; the workflow also starts the session read-only.
-- Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== business_documents pilot, business 9: legend (n -> check) =='
\echo ' 0 the evidence role is a superuser or has BYPASSRLS, so it sees every row of the RLS tables below (want 1)'
\echo ' 1 flag business_documents: definition off and global policy off (want 1)'
\echo ' 2 overrides of business_documents, all businesses (INFO: S1 0, S2 1, S3 1)'
\echo ' 3 overrides of business_documents that are business 9 ENABLED (INFO: S1 0, S2 1, S3 1)'
\echo ' 4 overrides of business_documents of any business other than 9 (want 0)'
\echo ' 5 overrides of business_documents of business 38 (want 0)'
\echo ' 6 purchase-order sheets of business 9 (INFO: S1 0, S2 0, S3 1)'
\echo ' 7 purchase-order sheets of any business other than 9 (want 0)'
\echo ' 8 sheet files of business 9, COMMITTED (INFO: equals check 6)'
\echo ' 9 sheet files of business 9 in any other state (INFO: 0 expected)'
\echo '10 every sheet of business 9 points at a COMMITTED file under biz/9/business-docs/po-sheets/ (want 1)'
\echo '11 request keys of business 9 for the purchase-order sheet (INFO: one per save attempt)'
\echo '12 letters of business 9 (INFO: equal in every run)'
\echo '13 quote-share stored copies of business 9 (INFO: equal in every run)'
\echo '14 quote-share recorded events of business 9 (INFO: equal in every run)'
\echo '15 data fingerprint: supplier orders of business 9 and their lines (INFO: equal in every run)'
\echo '16 data fingerprint: purchase orders of business 9, their lines, receiving sessions and lines (INFO: equal)'
\echo '17 data fingerprint: stock items and stock movements of business 9 (INFO: equal)'
\echo '18 rows behind 15: supplier orders + lines of business 9 (INFO)'
\echo '19 rows behind 16: purchase orders + lines + receiving sessions + lines of business 9 (INFO)'
\echo '20 rows behind 17: stock items + movements of business 9 (INFO)'
\echo '21 finished migrations in the ledger (INFO: equal in every run, or a fingerprint change may be a new column)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
drafts AS (SELECT d.id, row_to_json(d)::text AS j FROM "SupplierPurchaseDraft" d WHERE d."businessId" = 9),
draft_lines AS (SELECT l.id, row_to_json(l)::text AS j FROM "SupplierPurchaseDraftLine" l WHERE l."draftId" IN (SELECT id FROM drafts)),
pos AS (SELECT o.id, row_to_json(o)::text AS j FROM "PurchaseOrder" o WHERE o."businessId" = 9),
po_lines AS (SELECT l.id, row_to_json(l)::text AS j FROM "PurchaseOrderLine" l WHERE l."purchaseOrderId" IN (SELECT id FROM pos)),
sessions AS (SELECT s.id, row_to_json(s)::text AS j FROM "ReceivingSession" s WHERE s."businessId" = 9),
session_lines AS (SELECT l.id, row_to_json(l)::text AS j FROM "ReceivingLine" l WHERE l."receivingSessionId" IN (SELECT id FROM sessions)),
items AS (SELECT i.id, row_to_json(i)::text AS j FROM "InventoryItem" i WHERE i."businessId" = 9),
moves AS (SELECT m.id, row_to_json(m)::text AS j FROM "InventoryMovement" m WHERE m."businessId" = 9),
c(n, observed, want) AS (
            SELECT 0, (SELECT CASE WHEN (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) IS TRUE
                             THEN 1 ELSE 0 END)::bigint, 1::bigint
  UNION ALL SELECT 1, (SELECT CASE WHEN
        (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE "key" = 'business_documents' AND NOT "defaultEnabled") = 1
    AND (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'business_documents' AND NOT "globalEnabled") = 1
    THEN 1 ELSE 0 END)::bigint, 1
  UNION ALL SELECT 2, (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'business_documents'), NULL
  UNION ALL SELECT 3, (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'business_documents'
                         AND "businessId" = 9 AND state::text = 'ENABLED'), NULL
  UNION ALL SELECT 4, (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'business_documents' AND "businessId" <> 9), 0
  UNION ALL SELECT 5, (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'business_documents' AND "businessId" = 38), 0
  UNION ALL SELECT 6, (SELECT count(*) FROM "PurchaseOrderSheet" WHERE "businessId" = 9), NULL
  UNION ALL SELECT 7, (SELECT count(*) FROM "PurchaseOrderSheet" WHERE "businessId" <> 9), 0
  UNION ALL SELECT 8, (SELECT count(*) FROM "BusinessDocumentFile" WHERE "businessId" = 9
                         AND purpose::text = 'PURCHASE_ORDER_SHEET' AND state::text = 'COMMITTED'), NULL
  UNION ALL SELECT 9, (SELECT count(*) FROM "BusinessDocumentFile" WHERE "businessId" = 9
                         AND purpose::text = 'PURCHASE_ORDER_SHEET' AND state::text <> 'COMMITTED'), NULL
  UNION ALL SELECT 10, (SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM "PurchaseOrderSheet" s
          LEFT JOIN "BusinessDocumentFile" f ON f."businessId" = s."businessId" AND f.id = s."fileId"
         WHERE s."businessId" = 9
           AND (f.id IS NULL OR f.state::text <> 'COMMITTED' OR f."objectKey" NOT LIKE 'biz/9/business-docs/po-sheets/%'))
    THEN 1 ELSE 0 END)::bigint, 1
  UNION ALL SELECT 11, (SELECT count(*) FROM "BusinessDocumentRequest" WHERE "businessId" = 9 AND operation::text = 'PURCHASE_ORDER_SHEET'), NULL
  UNION ALL SELECT 12, (SELECT count(*) FROM "BusinessLetter" WHERE "businessId" = 9), NULL
  UNION ALL SELECT 13, (SELECT count(*) FROM "QuoteShareCopy" WHERE "businessId" = 9), NULL
  UNION ALL SELECT 14, (SELECT count(*) FROM "QuoteShareEvent" WHERE "businessId" = 9), NULL
  UNION ALL SELECT 15, (SELECT hashtext(coalesce((SELECT string_agg(j, '|' ORDER BY id) FROM drafts), '')
                                    || '#' || coalesce((SELECT string_agg(j, '|' ORDER BY id) FROM draft_lines), ''))::bigint), NULL
  UNION ALL SELECT 16, (SELECT hashtext(coalesce((SELECT string_agg(j, '|' ORDER BY id) FROM pos), '')
                                    || '#' || coalesce((SELECT string_agg(j, '|' ORDER BY id) FROM po_lines), '')
                                    || '#' || coalesce((SELECT string_agg(j, '|' ORDER BY id) FROM sessions), '')
                                    || '#' || coalesce((SELECT string_agg(j, '|' ORDER BY id) FROM session_lines), ''))::bigint), NULL
  UNION ALL SELECT 17, (SELECT hashtext(coalesce((SELECT string_agg(j, '|' ORDER BY id) FROM items), '')
                                    || '#' || coalesce((SELECT string_agg(j, '|' ORDER BY id) FROM moves), ''))::bigint), NULL
  UNION ALL SELECT 18, (SELECT (SELECT count(*) FROM drafts) + (SELECT count(*) FROM draft_lines)), NULL
  UNION ALL SELECT 19, (SELECT (SELECT count(*) FROM pos) + (SELECT count(*) FROM po_lines)
                             + (SELECT count(*) FROM sessions) + (SELECT count(*) FROM session_lines)), NULL
  UNION ALL SELECT 20, (SELECT (SELECT count(*) FROM items) + (SELECT count(*) FROM moves)), NULL
  UNION ALL SELECT 21, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL), NULL
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;

ROLLBACK;
