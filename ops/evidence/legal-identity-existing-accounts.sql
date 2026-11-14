-- ============================================================================
-- legal-identity-existing-accounts.sql
--
-- Read-only: how complete the legal identity of EXISTING live businesses is — the input to the (not yet approved)
-- controlled completion for existing accounts. COUNTS ONLY: no name, number, address or id is selected.
-- Valid before and after 20261128090000 (it reads no column that migration adds).
-- "tax id passes" = the same rule as lib/identity/tax-id.ts: separators removed, 8 digits left-padded, not all one
-- digit, Israeli check digit. A local FORMAT check — never a confirmation against any registry.
-- OUTPUT: bucket | businesses. Guard-clean: SELECT only.
-- ============================================================================
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH live AS (
  SELECT b."id", p."id" AS pid, p."billingBusinessKind" AS kind, p."billingTaxId" AS raw_tax,
         nullif(btrim(p."billingLegalName"), '') AS legal_name, nullif(btrim(p."billingAddress"), '') AS address,
         nullif(btrim(p."billingPhone"), '') AS phone, nullif(btrim(p."billingEmail"), '') AS email,
         regexp_replace(coalesce(p."billingTaxId", ''), '[[:space:]-]', '', 'g') AS tax
    FROM "Business" b LEFT JOIN "BusinessProfile" p ON p."businessId" = b."id"
   WHERE b."deletedAt" IS NULL AND b."deletionRequestedAt" IS NULL AND b."archivedAt" IS NULL
),
norm AS (
  SELECT l.*, CASE WHEN l.tax ~ '^[0-9]{8,9}$' THEN lpad(l.tax, 9, '0') END AS tax9 FROM live l
),
graded AS (
  SELECT n.*,
         coalesce(n.tax9 IS NOT NULL AND n.tax9 !~ '^(.)\1{8}$'
          AND (SELECT sum(CASE WHEN d > 9 THEN d - 9 ELSE d END)
                 FROM (SELECT substr(n.tax9, i, 1)::int * (CASE WHEN i % 2 = 1 THEN 1 ELSE 2 END) AS d
                         FROM generate_series(1, 9) AS i) s) % 10 = 0, false) AS tax_ok,
         coalesce(n.kind IN ('EXEMPT_DEALER', 'AUTHORIZED_DEALER', 'LTD_COMPANY') AND n.legal_name IS NOT NULL
          AND n.address IS NOT NULL AND n.phone IS NOT NULL AND n.email IS NOT NULL AND n.tax <> '', false) AS complete
    FROM norm n
)
SELECT bucket, businesses FROM (
            SELECT 1 AS o, 'live businesses' AS bucket, count(*) AS businesses FROM graded
  UNION ALL SELECT 2, 'no BusinessProfile row', count(*) FROM graded WHERE pid IS NULL
  UNION ALL SELECT 3, 'business kind missing', count(*) FROM graded WHERE pid IS NOT NULL AND kind IS NULL
  UNION ALL SELECT 4, 'kind EXEMPT_DEALER', count(*) FROM graded WHERE kind = 'EXEMPT_DEALER'
  UNION ALL SELECT 5, 'kind AUTHORIZED_DEALER', count(*) FROM graded WHERE kind = 'AUTHORIZED_DEALER'
  UNION ALL SELECT 6, 'kind LTD_COMPANY', count(*) FROM graded WHERE kind = 'LTD_COMPANY'
  UNION ALL SELECT 7, 'legal identity incomplete (any of the 6 fields missing)', count(*) FROM graded WHERE NOT complete
  UNION ALL SELECT 8, 'complete, tax id passes the local format check', count(*) FROM graded WHERE complete AND tax_ok
  UNION ALL SELECT 9, 'complete, tax id FAILS the local format check', count(*) FROM graded WHERE complete AND NOT tax_ok
  UNION ALL SELECT 10, 'tax id passes but is not stored as 9 plain digits (completion would normalise it)', count(*)
              FROM graded WHERE tax_ok AND raw_tax IS DISTINCT FROM tax9
) t ORDER BY o;

ROLLBACK;
