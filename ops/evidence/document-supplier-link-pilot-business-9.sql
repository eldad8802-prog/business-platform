-- ============================================================================
-- document-supplier-link-pilot-business-9.sql
--
-- Read-only Production facts for the document supplier linking pilot on the TEST business (businessId = 9), and
-- the proof that no other business is touched. Run right after the owner switches `document_supplier_linking` ON
-- for business 9 only, during the pilot, and again after it is switched back.
--
-- Flags and counts only (scripts/ci/evidence-redact.mjs): no id value, name, amount or text.
-- Guard-clean: no write keyword anywhere, prose included.
--
-- OUTPUT: n | flag | observed_count
-- ============================================================================

\echo '== document supplier linking pilot, business 9: legend =='
\echo ' 1 business 9 exists, not archived, not in deletion (flag)'
\echo ' 2 the flag policy: global OFF and no emergency switch (flag; expected true)'
\echo ' 3 business 9: override ENABLED (flag)'
\echo ' 4 business 9: override DISABLED (flag)'
\echo ' 5 business 9: no effective override (no row or INHERIT) (flag)'
\echo ' 6 OTHER businesses with an effective override, ENABLED or DISABLED (count; expected 0)'
\echo ' 7 business 9: document-supplier decisions, all (count)'
\echo ' 8 business 9: decisions currently ACTIVE (count)'
\echo ' 9 business 9: trail rows LINKED (count)'
\echo '10 business 9: trail rows RELINKED (count)'
\echo '11 business 9: trail rows UNLINKED (count)'
\echo '12 business 9: trail rows SUGGESTION_DISMISSED (count)'
\echo '13 OTHER businesses: decisions or trail rows (count; expected 0)'
\echo '14 OTHER businesses: documents carrying an issuer reading (count; expected 0)'
\echo '15 business 9: documents carrying an issuer reading (count)'
\echo '16 business 9: of 15, documents created BEFORE the override was last changed (count; expected 0 — no history re-read)'
\echo '17 business 9: of 15, the own business was kept out of the issuer (count)'
\echo '18 business 9: decisions on documents created BEFORE the override was last changed (count; the owner''s own choices only)'
\echo '19 every decision names a supplier and a document of its own business (count of mismatches; expected 0)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
biz AS (
  SELECT b."id" FROM "Business" b
  WHERE b."id" = 9 AND b."archivedAt" IS NULL AND b."deletionRequestedAt" IS NULL AND b."deletedAt" IS NULL
),
o9 AS (
  SELECT a.state::text AS state, a."updatedAt" AS changed_at FROM "BusinessFeatureAccess" a
  WHERE a."businessId" = 9 AND a."featureKey" = 'document_supplier_linking'
),
since AS (SELECT COALESCE((SELECT max(changed_at) FROM o9), now()) AS at),
docs9 AS (SELECT d."id", d."createdAt" FROM "Document" d WHERE d."businessId" = 9),
read9 AS (
  SELECT d."id", d."createdAt", e."ownBusinessExcluded" FROM docs9 d JOIN "ExtractedData" e ON e."documentId" = d."id"
  WHERE e."issuerCheck" IS NOT NULL
),
lines(n, flag, observed_count) AS (
            SELECT 1, EXISTS (SELECT 1 FROM biz), NULL::bigint
  UNION ALL SELECT 2, (SELECT bool_and(NOT p."globalEnabled" AND NOT p."emergencyDisabled") FROM "PlatformFeaturePolicy" p
                        WHERE p."featureKey" = 'document_supplier_linking'), NULL
  UNION ALL SELECT 3, COALESCE((SELECT bool_or(state = 'ENABLED') FROM o9), false), NULL
  UNION ALL SELECT 4, COALESCE((SELECT bool_or(state = 'DISABLED') FROM o9), false), NULL
  UNION ALL SELECT 5, NOT EXISTS (SELECT 1 FROM o9 WHERE state IN ('ENABLED', 'DISABLED')), NULL
  UNION ALL SELECT 6, NULL, (SELECT count(*) FROM "BusinessFeatureAccess" a
                              WHERE a."featureKey" = 'document_supplier_linking' AND a."businessId" <> 9 AND a.state::text IN ('ENABLED', 'DISABLED'))
  UNION ALL SELECT 7, NULL, (SELECT count(*) FROM "DocumentSupplierLink" l WHERE l."businessId" = 9)
  UNION ALL SELECT 8, NULL, (SELECT count(*) FROM "DocumentSupplierLink" l WHERE l."businessId" = 9 AND l."status" = 'ACTIVE')
  UNION ALL SELECT 9, NULL, (SELECT count(*) FROM "DocumentSupplierLinkEvent" e WHERE e."businessId" = 9 AND e."action" = 'LINKED')
  UNION ALL SELECT 10, NULL, (SELECT count(*) FROM "DocumentSupplierLinkEvent" e WHERE e."businessId" = 9 AND e."action" = 'RELINKED')
  UNION ALL SELECT 11, NULL, (SELECT count(*) FROM "DocumentSupplierLinkEvent" e WHERE e."businessId" = 9 AND e."action" = 'UNLINKED')
  UNION ALL SELECT 12, NULL, (SELECT count(*) FROM "DocumentSupplierLinkEvent" e WHERE e."businessId" = 9 AND e."action" = 'SUGGESTION_DISMISSED')
  UNION ALL SELECT 13, NULL, (SELECT (SELECT count(*) FROM "DocumentSupplierLink" WHERE "businessId" <> 9)
                                    + (SELECT count(*) FROM "DocumentSupplierLinkEvent" WHERE "businessId" <> 9))
  UNION ALL SELECT 14, NULL, (SELECT count(*) FROM "ExtractedData" e JOIN "Document" d ON d."id" = e."documentId"
                               WHERE d."businessId" <> 9 AND e."issuerCheck" IS NOT NULL)
  UNION ALL SELECT 15, NULL, (SELECT count(*) FROM read9)
  UNION ALL SELECT 16, NULL, (SELECT count(*) FROM read9 WHERE "createdAt" < (SELECT at FROM since))
  UNION ALL SELECT 17, NULL, (SELECT count(*) FROM read9 WHERE "ownBusinessExcluded")
  UNION ALL SELECT 18, NULL, (SELECT count(*) FROM "DocumentSupplierLink" l JOIN docs9 d ON d."id" = l."documentId"
                               WHERE l."businessId" = 9 AND d."createdAt" < (SELECT at FROM since))
  UNION ALL SELECT 19, NULL, (SELECT count(*) FROM "DocumentSupplierLink" l
                               LEFT JOIN "Document" d ON d."id" = l."documentId"
                               LEFT JOIN "Supplier" s ON s."id" = l."supplierId"
                               WHERE d."businessId" IS DISTINCT FROM l."businessId"
                                  OR (l."supplierId" IS NOT NULL AND s."businessId" IS DISTINCT FROM l."businessId"))
)
SELECT n, flag, observed_count FROM lines ORDER BY n;

ROLLBACK;
