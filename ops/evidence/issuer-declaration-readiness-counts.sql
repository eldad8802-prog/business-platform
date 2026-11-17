-- ============================================================================
-- Issuer declaration (#1081 / #1091 / #1117) — readiness counts before screens (stage D) and enforcement (stage E).
--
-- Read-only, aggregate counts only. No names, numbers, ids, emails or amounts: every output cell is a count.
-- Runs on today's schema (before 20261126100000_issuer_declaration is applied) — it reads only tables that exist
-- now: Business, User, BusinessProfile, BillingDocument.
--
-- Why: enforcement is one platform-wide row. Once it holds, every business without complete details and a
-- declaration is refused a governed (fiscal) document. A business with more than one user cannot self-declare
-- (NEEDS_DESIGNATION) and needs the platform designation path, which has no screen yet.
--
-- "Details complete" here mirrors lib/billing/issuer-declaration/details.ts (#1117) for presence and shape: the kind,
-- the fields required for that kind, 9-digit numbers, an exempt dealer with no VAT number, length bounds. The check
-- digit is NOT computed here, so this count is an upper bound (the real screen may still find a check-digit problem).
--
-- OUTPUT (redaction-friendly): n | observed_count, plus an \echo legend.
-- ============================================================================

\echo '== issuer declaration readiness: legend (n -> what is counted) =='
\echo ' 1 live businesses (not deleted, no deletion requested)'
\echo ' 2 live businesses with exactly one user'
\echo ' 3 live businesses with two or more users'
\echo ' 4 live businesses that ever issued a governed fiscal document (TAX_INVOICE, TAX_INVOICE_RECEIPT, RECEIPT, CREDIT_NOTE)'
\echo ' 5 ... of those (4), issued in the last 90 days (actively issuing)'
\echo ' 6 ... of those (5), with two or more users (would be refused under enforcement until designated)'
\echo ' 7 ... of those (5), whose details are NOT complete (would be refused under enforcement until completed)'
\echo ' 8 ... of those (5), single-user AND details complete (could self-declare as soon as screens are on)'
\echo ' 9 live businesses with no billing profile row'
\echo '10 live businesses with a profile but no business kind'
\echo '11 live businesses: kind = EXEMPT_DEALER'
\echo '12 live businesses: kind = AUTHORIZED_DEALER'
\echo '13 live businesses: kind = LTD_COMPANY'
\echo '14 live exempt dealers whose profile carries a VAT number (must be cleared before declaring)'
\echo '15 live businesses whose details are complete (presence and shape, check digit not computed)'

WITH live AS (
  SELECT b."id" FROM "Business" b WHERE b."deletedAt" IS NULL AND b."deletionRequestedAt" IS NULL
), users AS (
  SELECT l."id", (SELECT count(*) FROM "User" u WHERE u."businessId" = l."id") AS user_n FROM live l
), fiscal AS (
  SELECT d."businessId", max(d."issuedAt") AS last_issued
  FROM "BillingDocument" d
  WHERE d.status::text = 'ISSUED' AND d."documentType"::text IN ('TAX_INVOICE', 'TAX_INVOICE_RECEIPT', 'RECEIPT', 'CREDIT_NOTE')
  GROUP BY d."businessId"
), prof AS (
  SELECT l."id",
         p."id" IS NOT NULL AS has_profile,
         p."billingBusinessKind" AS kind,
         btrim(coalesce(p."billingLegalName", '')) AS legal_name,
         coalesce(p."billingTaxId", '') AS tax_id,
         coalesce(p."billingVatNumber", '') AS vat,
         btrim(coalesce(p."billingAddress", '')) AS addr,
         btrim(coalesce(p."billingPhone", '')) AS phone,
         btrim(coalesce(p."billingEmail", '')) AS email
  FROM live l LEFT JOIN "BusinessProfile" p ON p."businessId" = l."id"
), complete AS (
  SELECT x."id",
         x.kind IN ('EXEMPT_DEALER', 'AUTHORIZED_DEALER', 'LTD_COMPANY')
         AND length(x.legal_name) BETWEEN 1 AND 120
         AND x.tax_id ~ '^[0-9]{9}$'
         AND length(x.addr) BETWEEN 1 AND 300
         AND length(x.phone) BETWEEN 1 AND 30
         AND length(x.email) BETWEEN 1 AND 320
         AND CASE WHEN x.kind = 'EXEMPT_DEALER' THEN btrim(x.vat) = '' ELSE x.vat ~ '^[0-9]{9}$' END AS ok
  FROM prof x
), active AS (
  SELECT f."businessId" AS id FROM fiscal f JOIN live l ON l."id" = f."businessId"
  WHERE f.last_issued >= now() - interval '90 days'
), c AS (
  SELECT 1 AS n, (SELECT count(*) FROM live) AS observed_count
  UNION ALL SELECT 2, (SELECT count(*) FROM users WHERE user_n = 1)
  UNION ALL SELECT 3, (SELECT count(*) FROM users WHERE user_n >= 2)
  UNION ALL SELECT 4, (SELECT count(*) FROM fiscal f JOIN live l ON l."id" = f."businessId")
  UNION ALL SELECT 5, (SELECT count(*) FROM active)
  UNION ALL SELECT 6, (SELECT count(*) FROM active a JOIN users u ON u."id" = a.id WHERE u.user_n >= 2)
  UNION ALL SELECT 7, (SELECT count(*) FROM active a JOIN complete k ON k."id" = a.id WHERE NOT coalesce(k.ok, false))
  UNION ALL SELECT 8, (SELECT count(*) FROM active a JOIN users u ON u."id" = a.id JOIN complete k ON k."id" = a.id
                       WHERE u.user_n = 1 AND coalesce(k.ok, false))
  UNION ALL SELECT 9, (SELECT count(*) FROM prof WHERE NOT has_profile)
  UNION ALL SELECT 10, (SELECT count(*) FROM prof WHERE has_profile AND kind IS NULL)
  UNION ALL SELECT 11, (SELECT count(*) FROM prof WHERE kind = 'EXEMPT_DEALER')
  UNION ALL SELECT 12, (SELECT count(*) FROM prof WHERE kind = 'AUTHORIZED_DEALER')
  UNION ALL SELECT 13, (SELECT count(*) FROM prof WHERE kind = 'LTD_COMPANY')
  UNION ALL SELECT 14, (SELECT count(*) FROM prof WHERE kind = 'EXEMPT_DEALER' AND btrim(vat) <> '')
  UNION ALL SELECT 15, (SELECT count(*) FROM complete WHERE coalesce(ok, false))
)
SELECT n, observed_count FROM c ORDER BY n;
