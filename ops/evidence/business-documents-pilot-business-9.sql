-- ============================================================================
-- business-documents-pilot-business-9.sql
--
-- Read-only Production check for the business_documents pilot in business 9 (owner-approved 2026-11-10). Run it
-- BEFORE the owner's test and AFTER it; the same file both times, so the INFO values can be compared:
--   * the flag stays off by definition and by global policy; the only override of the feature is business 9 ENABLED,
--     and no other business (business 38 named) holds one;
--   * the purchase-order sheets of business 9 (after the test: exactly one), its stored file COMMITTED under
--     business 9's own po-sheets prefix, and its request keys; no sheet of any other business;
--   * no letter or quote-share record was made in business 9 by the test;
--   * the supplier orders, the purchase orders / receiving and the stock of business 9 are unchanged: data
--     fingerprints (a hash of the rows) that must be equal in the two runs.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend. PASS / FAIL where the value is fixed,
-- INFO where it is compared between the two runs. Flags, counts and hashes only — no business data is printed.
-- Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== business_documents pilot, business 9: legend (n -> check) =='
\echo ' 0 the evidence role is a superuser or has BYPASSRLS, so it sees every row of the RLS tables below (want 1)'
\echo ' 1 flag business_documents: definition off and global policy off (want 1)'
\echo ' 2 overrides of business_documents, all businesses (INFO: 0 before the switch-on, 1 after)'
\echo ' 3 overrides of business_documents that are business 9 ENABLED (INFO: 0 before, 1 after)'
\echo ' 4 overrides of business_documents of any business other than 9 (want 0)'
\echo ' 5 overrides of business_documents of business 38 (want 0)'
\echo ' 6 purchase-order sheets of business 9 (INFO: 0 before the test, 1 after)'
\echo ' 7 purchase-order sheets of any business other than 9 (want 0)'
\echo ' 8 sheet files of business 9, COMMITTED (INFO: equals check 6)'
\echo ' 9 sheet files of business 9 in any other state (INFO: 0 expected)'
\echo '10 every sheet of business 9 points at a COMMITTED file under biz/9/business-docs/po-sheets/ (want 1)'
\echo '11 request keys of business 9 for the purchase-order sheet (INFO)'
\echo '12 letters + quote-share records of business 9 (INFO: equal in the two runs)'
\echo '13 data fingerprint: supplier orders of business 9 and their lines (INFO: equal in the two runs)'
\echo '14 data fingerprint: purchase orders of business 9, their lines, receiving sessions and lines (INFO: equal)'
\echo '15 data fingerprint: stock items and stock movements of business 9 (INFO: equal)'

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
  UNION ALL SELECT 12, (SELECT (SELECT count(*) FROM "BusinessLetter" WHERE "businessId" = 9)
                             + (SELECT count(*) FROM "QuoteShareCopy" WHERE "businessId" = 9)
                             + (SELECT count(*) FROM "QuoteShareEvent" WHERE "businessId" = 9)), NULL
  UNION ALL SELECT 13, (SELECT hashtext(coalesce((SELECT string_agg(j, '|' ORDER BY id) FROM drafts), '')
                                    || '#' || coalesce((SELECT string_agg(j, '|' ORDER BY id) FROM draft_lines), ''))::bigint), NULL
  UNION ALL SELECT 14, (SELECT hashtext(coalesce((SELECT string_agg(j, '|' ORDER BY id) FROM pos), '')
                                    || '#' || coalesce((SELECT string_agg(j, '|' ORDER BY id) FROM po_lines), '')
                                    || '#' || coalesce((SELECT string_agg(j, '|' ORDER BY id) FROM sessions), '')
                                    || '#' || coalesce((SELECT string_agg(j, '|' ORDER BY id) FROM session_lines), ''))::bigint), NULL
  UNION ALL SELECT 15, (SELECT hashtext(coalesce((SELECT string_agg(j, '|' ORDER BY id) FROM items), '')
                                    || '#' || coalesce((SELECT string_agg(j, '|' ORDER BY id) FROM moves), ''))::bigint), NULL
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;

ROLLBACK;
