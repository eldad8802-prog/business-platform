-- ============================================================================
-- document-supplier-business-9-readonly.sql
--
-- Read-only Production MEASUREMENT for document supplier linking (milestone 1) on the TEST business
-- (businessId = 9), plus platform-wide counts of order → supplier references that cross a business.
-- Runs BEFORE migration 20261102080000: it reads only tables that exist today and needs none of the new ones.
--
-- What it separates:
--   VERIFIED   — a fact by definition, e.g. a non-income document whose vendor name IS the business's own name;
--   SUSPECTED  — a pattern that needs a human look, e.g. the own name INSIDE the vendor name, or two different
--                9-digit numbers on one document (some are phone or bank numbers).
--
-- Name comparison: lower-cased, quotes removed, other punctuation to spaces, spaces collapsed, legal forms (בע"מ / ltd / inc /
-- llc) dropped — the same rule as the application's nameKey (lib/services/documents/issuer/issuer-reading.ts).
-- Tax ids: digits only, compared as text; an 8-digit id is left-padded to 9.
--
-- OUTPUT (scripts/ci/evidence-redact.mjs): flags and counts only. The "masked examples" (50–52) carry no id, name,
-- amount or text: a category number, the document month as YYYYMM, the length of the vendor name, and flags.
-- Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== document supplier linking, business 9: legend =='
\echo '21 the evidence role is a superuser or has BYPASSRLS (runs first; flag)'
\echo '22 row level security is not active on "Document" for the evidence role (runs first; flag)'
\echo ' 1 business 9 exists, not archived, not in deletion (flag)'
\echo ' 2 business 9 has a billing tax id of 8-9 digits (flag)'
\echo ' 3 business 9 has a billing legal name (flag)'
\echo ' 4 documents (count)'
\echo ' 5 documents with an extraction row (count)'
\echo ' 6 documents with OCR text (count)'
\echo ' 7 VERIFIED: non-income documents whose vendor name IS the business own name (count)'
\echo ' 8 VERIFIED: of 7, approved as financial with that name on the FinancialRecord (count)'
\echo ' 9 legitimate: income documents whose vendor name is the own name — documents the business issued (count)'
\echo '10 SUSPECTED: non-income documents whose vendor name CONTAINS the own name but is not it (count)'
\echo '11 the own tax id appears in the OCR text (count — normally the recipient block)'
\echo '12 of 11, a non-income document whose vendor name is the own name (count — the recipient was read as the issuer)'
\echo '13 non-income documents — none is linked to a supplier today, the link does not exist yet (count)'
\echo '14 non-income documents with no vendor name (count)'
\echo '15 POSSIBLE NAME SUGGESTIONS: non-income documents whose vendor name equals exactly one supplier name (count)'
\echo '16 AMBIGUOUS: non-income documents whose vendor name equals two or more supplier names (count)'
\echo '17 POSSIBLE TAX-ID SUGGESTIONS: non-income documents whose OCR text holds a supplier tax id (count)'
\echo '18 CONFLICTING: of 17, the OCR text holds the tax ids of two or more different suppliers (count)'
\echo '19 SUSPECTED CONFLICT: non-income documents with two or more different 9-digit numbers besides the own id (count)'
\echo '20 suppliers (count)'
\echo '23 active suppliers (count)'
\echo '24 suppliers with a tax id of 8-9 digits (count)'
\echo '25 DUPLICATE suppliers by name: groups of two or more with the same name (count of groups)'
\echo '26 DUPLICATE suppliers by name: suppliers in those groups (count)'
\echo '27 DUPLICATE suppliers by tax id: groups of two or more (count of groups)'
\echo '28 a supplier carries the business own name (count)'
\echo '29 a supplier carries the business own tax id (count)'
\echo '30 purchase orders (count)'
\echo '31 purchase orders with no supplier id, by name only (count)'
\echo '32 PLATFORM: purchase orders whose supplier belongs to ANOTHER business (count; expected 0)'
\echo '33 PLATFORM: supplier purchase drafts whose supplier belongs to ANOTHER business (count; expected 0)'
\echo '34 PLATFORM: financial records whose document belongs to ANOTHER business (count; expected 0)'
\echo '50-52 masked examples of 7 / 10 / 16: category, month (YYYYMM), vendor name length, income?, approved record?'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '25s';
-- Hard stop: a query that row level security would filter raises an ERROR instead of undercounting.
SET LOCAL row_security = off;

\echo '== visibility checks (21, 22) =='
SELECT 21 AS n,
       (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS flag;
SELECT 22 AS n, NOT row_security_active('"Document"') AS flag;

\echo '== business 9 =='
WITH
own AS (
  SELECT b."name" AS biz_name, p."billingLegalName" AS legal_name,
         NULLIF(regexp_replace(COALESCE(p."billingTaxId", ''), '\D', '', 'g'), '') AS tax_raw,
         NULLIF(regexp_replace(COALESCE(p."billingVatNumber", ''), '\D', '', 'g'), '') AS vat_raw
    FROM "Business" b LEFT JOIN "BusinessProfile" p ON p."businessId" = b."id"
   WHERE b."id" = 9
),
own_ids AS (
  SELECT lpad(v, 9, '0') AS id FROM own, LATERAL (VALUES (tax_raw), (vat_raw)) x(v)
   WHERE v IS NOT NULL AND length(v) BETWEEN 8 AND 9
),
own_keys AS (
  SELECT DISTINCT btrim(regexp_replace(
           regexp_replace(' ' || regexp_replace(regexp_replace(lower(x.v), '[״"׳'']', '', 'g'), '[.,:;()\[\]{}\-–—־]', ' ', 'g') || ' ',
                          '\s(בעמ|ltd|inc|llc)(?=\s)', ' ', 'g'),
           '\s+', ' ', 'g')) AS key
    FROM own, LATERAL (VALUES (biz_name), (legal_name)) x(v)
   WHERE x.v IS NOT NULL
),
docs AS (
  SELECT d."id", d."createdAt", d."ocrText", e."vendorName", e."direction",
         NULLIF(btrim(regexp_replace(
           regexp_replace(' ' || regexp_replace(regexp_replace(lower(COALESCE(e."vendorName", '')), '[״"׳'']', '', 'g'), '[.,:;()\[\]{}\-–—־]', ' ', 'g') || ' ',
                          '\s(בעמ|ltd|inc|llc)(?=\s)', ' ', 'g'),
           '\s+', ' ', 'g')), '') AS vkey,
         (e."documentId" IS NOT NULL) AS has_extraction,
         EXISTS (SELECT 1 FROM "FinancialRecord" f WHERE f."documentId" = d."id" AND f."businessId" = 9) AS has_record
    FROM "Document" d LEFT JOIN "ExtractedData" e ON e."documentId" = d."id"
   WHERE d."businessId" = 9
),
doc_flags AS (
  SELECT docs.*,
         (vkey IS NOT NULL AND vkey IN (SELECT key FROM own_keys WHERE key <> '')) AS vendor_is_own,
         (vkey IS NOT NULL AND vkey NOT IN (SELECT key FROM own_keys)
            AND EXISTS (SELECT 1 FROM own_keys k WHERE length(k.key) >= 3 AND position(k.key IN vkey) > 0)) AS vendor_contains_own,
         (COALESCE("direction", '') <> 'income') AS non_income,
         COALESCE((SELECT array_agg(DISTINCT m[1]) FROM regexp_matches(COALESCE("ocrText", ''), '(?<!\d)(\d{9})(?!\d)', 'g') AS m), '{}') AS nine_digit
    FROM docs
),
sup AS (
  SELECT s."id", s."isActive",
         NULLIF(btrim(regexp_replace(
           regexp_replace(' ' || regexp_replace(regexp_replace(lower(s."name"), '[״"׳'']', '', 'g'), '[.,:;()\[\]{}\-–—־]', ' ', 'g') || ' ',
                          '\s(בעמ|ltd|inc|llc)(?=\s)', ' ', 'g'),
           '\s+', ' ', 'g')), '') AS skey,
         CASE WHEN length(regexp_replace(COALESCE(s."taxId", ''), '\D', '', 'g')) BETWEEN 8 AND 9
              THEN lpad(regexp_replace(s."taxId", '\D', '', 'g'), 9, '0') END AS stax
    FROM "Supplier" s WHERE s."businessId" = 9
),
doc_sup AS (
  SELECT f."id",
         (SELECT count(*) FROM sup WHERE sup.skey IS NOT NULL AND sup.skey = f.vkey) AS by_name,
         (SELECT count(DISTINCT sup."id") FROM sup
            WHERE sup.stax IS NOT NULL AND sup.stax = ANY (f.nine_digit)
              AND sup.stax NOT IN (SELECT id FROM own_ids)) AS by_tax,
         (SELECT count(*) FROM unnest(f.nine_digit) v WHERE v NOT IN (SELECT id FROM own_ids)) AS other_ids
    FROM doc_flags f WHERE f.non_income
),
lines(n, flag, observed_count) AS (
            SELECT 1, EXISTS (SELECT 1 FROM "Business" b WHERE b."id" = 9 AND b."archivedAt" IS NULL
                               AND b."deletionRequestedAt" IS NULL AND b."deletedAt" IS NULL), NULL::bigint
  UNION ALL SELECT 2, EXISTS (SELECT 1 FROM own WHERE length(COALESCE(tax_raw, '')) BETWEEN 8 AND 9), NULL
  UNION ALL SELECT 3, EXISTS (SELECT 1 FROM own WHERE NULLIF(btrim(legal_name), '') IS NOT NULL), NULL
  UNION ALL SELECT 4, NULL, (SELECT count(*) FROM docs)
  UNION ALL SELECT 5, NULL, (SELECT count(*) FROM docs WHERE has_extraction)
  UNION ALL SELECT 6, NULL, (SELECT count(*) FROM docs WHERE NULLIF(btrim(COALESCE("ocrText", '')), '') IS NOT NULL)
  UNION ALL SELECT 7, NULL, (SELECT count(*) FROM doc_flags WHERE vendor_is_own AND non_income)
  UNION ALL SELECT 8, NULL, (SELECT count(*) FROM doc_flags WHERE vendor_is_own AND non_income AND has_record)
  UNION ALL SELECT 9, NULL, (SELECT count(*) FROM doc_flags WHERE vendor_is_own AND NOT non_income)
  UNION ALL SELECT 10, NULL, (SELECT count(*) FROM doc_flags WHERE vendor_contains_own AND non_income)
  UNION ALL SELECT 11, NULL, (SELECT count(*) FROM doc_flags WHERE nine_digit && ARRAY(SELECT id FROM own_ids))
  UNION ALL SELECT 12, NULL, (SELECT count(*) FROM doc_flags WHERE vendor_is_own AND non_income AND nine_digit && ARRAY(SELECT id FROM own_ids))
  UNION ALL SELECT 13, NULL, (SELECT count(*) FROM doc_flags WHERE non_income)
  UNION ALL SELECT 14, NULL, (SELECT count(*) FROM doc_flags WHERE non_income AND vkey IS NULL)
  UNION ALL SELECT 15, NULL, (SELECT count(*) FROM doc_sup WHERE by_name = 1)
  UNION ALL SELECT 16, NULL, (SELECT count(*) FROM doc_sup WHERE by_name >= 2)
  UNION ALL SELECT 17, NULL, (SELECT count(*) FROM doc_sup WHERE by_tax >= 1)
  UNION ALL SELECT 18, NULL, (SELECT count(*) FROM doc_sup WHERE by_tax >= 2)
  UNION ALL SELECT 19, NULL, (SELECT count(*) FROM doc_sup WHERE other_ids >= 2)
  UNION ALL SELECT 20, NULL, (SELECT count(*) FROM sup)
  UNION ALL SELECT 23, NULL, (SELECT count(*) FROM sup WHERE "isActive")
  UNION ALL SELECT 24, NULL, (SELECT count(*) FROM sup WHERE stax IS NOT NULL)
  UNION ALL SELECT 25, NULL, (SELECT count(*) FROM (SELECT skey FROM sup WHERE skey IS NOT NULL GROUP BY skey HAVING count(*) >= 2) g)
  UNION ALL SELECT 26, NULL, (SELECT COALESCE(sum(c), 0) FROM (SELECT count(*) AS c FROM sup WHERE skey IS NOT NULL GROUP BY skey HAVING count(*) >= 2) g)
  UNION ALL SELECT 27, NULL, (SELECT count(*) FROM (SELECT stax FROM sup WHERE stax IS NOT NULL GROUP BY stax HAVING count(*) >= 2) g)
  UNION ALL SELECT 28, NULL, (SELECT count(*) FROM sup WHERE skey IN (SELECT key FROM own_keys WHERE key <> ''))
  UNION ALL SELECT 29, NULL, (SELECT count(*) FROM sup WHERE stax IN (SELECT id FROM own_ids))
  UNION ALL SELECT 30, NULL, (SELECT count(*) FROM "PurchaseOrder" po WHERE po."businessId" = 9)
  UNION ALL SELECT 31, NULL, (SELECT count(*) FROM "PurchaseOrder" po WHERE po."businessId" = 9 AND po."supplierId" IS NULL)
  UNION ALL SELECT 32, NULL, (SELECT count(*) FROM "PurchaseOrder" po JOIN "Supplier" s ON s."id" = po."supplierId"
                               WHERE s."businessId" <> po."businessId")
  UNION ALL SELECT 33, NULL, (SELECT count(*) FROM "SupplierPurchaseDraft" sd JOIN "Supplier" s ON s."id" = sd."supplierId"
                               WHERE s."businessId" <> sd."businessId")
  UNION ALL SELECT 34, NULL, (SELECT count(*) FROM "FinancialRecord" f JOIN "Document" d ON d."id" = f."documentId"
                               WHERE d."businessId" <> f."businessId")
)
SELECT n, flag, observed_count FROM lines ORDER BY n;

\echo '== masked examples (no id, name, amount or text) =='
WITH
own AS (
  SELECT b."name" AS biz_name, p."billingLegalName" AS legal_name
    FROM "Business" b LEFT JOIN "BusinessProfile" p ON p."businessId" = b."id" WHERE b."id" = 9
),
own_keys AS (
  SELECT DISTINCT btrim(regexp_replace(
           regexp_replace(' ' || regexp_replace(regexp_replace(lower(x.v), '[״"׳'']', '', 'g'), '[.,:;()\[\]{}\-–—־]', ' ', 'g') || ' ',
                          '\s(בעמ|ltd|inc|llc)(?=\s)', ' ', 'g'),
           '\s+', ' ', 'g')) AS key
    FROM own, LATERAL (VALUES (biz_name), (legal_name)) x(v) WHERE x.v IS NOT NULL
),
docs AS (
  SELECT d."id", d."createdAt", e."direction", e."vendorName",
         NULLIF(btrim(regexp_replace(
           regexp_replace(' ' || regexp_replace(regexp_replace(lower(COALESCE(e."vendorName", '')), '[״"׳'']', '', 'g'), '[.,:;()\[\]{}\-–—־]', ' ', 'g') || ' ',
                          '\s(בעמ|ltd|inc|llc)(?=\s)', ' ', 'g'),
           '\s+', ' ', 'g')), '') AS vkey,
         EXISTS (SELECT 1 FROM "FinancialRecord" f WHERE f."documentId" = d."id" AND f."businessId" = 9) AS has_record
    FROM "Document" d JOIN "ExtractedData" e ON e."documentId" = d."id"
   WHERE d."businessId" = 9
),
sup_keys AS (
  SELECT NULLIF(btrim(regexp_replace(
           regexp_replace(' ' || regexp_replace(regexp_replace(lower(s."name"), '[״"׳'']', '', 'g'), '[.,:;()\[\]{}\-–—־]', ' ', 'g') || ' ',
                          '\s(בעמ|ltd|inc|llc)(?=\s)', ' ', 'g'),
           '\s+', ' ', 'g')), '') AS skey
    FROM "Supplier" s WHERE s."businessId" = 9
),
cat AS (
  SELECT 50 AS cat_n, docs.* FROM docs
   WHERE COALESCE("direction", '') <> 'income' AND vkey IN (SELECT key FROM own_keys WHERE key <> '')
  UNION ALL
  SELECT 51, docs.* FROM docs
   WHERE COALESCE("direction", '') <> 'income' AND vkey IS NOT NULL AND vkey NOT IN (SELECT key FROM own_keys)
     AND EXISTS (SELECT 1 FROM own_keys k WHERE length(k.key) >= 3 AND position(k.key IN vkey) > 0)
  UNION ALL
  SELECT 52, docs.* FROM docs
   WHERE COALESCE("direction", '') <> 'income' AND vkey IS NOT NULL
     AND (SELECT count(*) FROM sup_keys WHERE skey = vkey) >= 2
),
ranked AS (
  SELECT cat.*, row_number() OVER (PARTITION BY cat_n ORDER BY "createdAt" DESC) AS rn FROM cat
)
SELECT cat_n,
       rn AS example_n,
       (extract(year FROM "createdAt")::int * 100 + extract(month FROM "createdAt")::int) AS month_n,
       char_length(COALESCE("vendorName", '')) AS vendor_len_n,
       (COALESCE("direction", '') = 'income') AS is_income,
       has_record AS approved_record
  FROM ranked WHERE rn <= 3
 ORDER BY cat_n, rn;

ROLLBACK;
