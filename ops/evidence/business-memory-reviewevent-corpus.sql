-- Business Memory · SHADOW-COMPARISON-2 · ReviewEvent corpus discovery (read-only).
--
-- Purpose: classify existing owner-decision evidence (ReviewEvent rows) into vendor-category
-- comparison scenarios, so a human can pick a small representative corpus WITHOUT any Production
-- write and WITHOUT enabling Shadow. OPERATIONAL EVIDENCE ONLY -- not a product read path, not an
-- admin reader. No inputs (fixed query) => no injection surface.
--
-- Output is minimal + non-sensitive: businessId, an APPROXIMATE normalized vendor subject key, event
-- counts, verdict counts, the qualifying category values, and a scenario label. It returns NO document
-- contents, NO amounts, NO dates, NO customer/personal data, NO raw extraction payloads, NO raw vendor
-- string. SELECT-only; READ ONLY transaction (session read-only + statement timeout + ROLLBACK).
--
-- NORMALIZATION NOTE: the subject key below is an SQL APPROXIMATION of the TypeScript normalizer
-- (normalizeVendorForLearning). It is for human overview/selection only. The dry-run comparison harness
-- re-normalizes every row with the REAL normalizer and is the authoritative grouping. Small differences
-- here never cause a write; they only affect this overview's grouping.

SET statement_timeout = '30s';
SET default_transaction_read_only = on;
BEGIN TRANSACTION READ ONLY;

-- Per (businessId, approx normalized vendor subject) classification.
\echo '== Q1: vendor-category evidence scenarios per (businessId, normalized subject) =='
WITH ev AS (
  SELECT
    r."businessId" AS business_id,
    lower(btrim(
      regexp_replace(
        regexp_replace(
          translate(coalesce(r."vendorFinal", ''), E'"''`׳״', ''),
          '[.,:;(){}\[\]\-–—־]+', ' ', 'g'
        ),
        '\s+', ' ', 'g'
      )
    )) AS normalized_subject,
    (r.verdicts -> 'category' ->> 'verdict') AS category_verdict,
    nullif(btrim(r.verdicts -> 'category' ->> 'final'), '') AS category_final
  FROM "ReviewEvent" r
),
tagged AS (
  SELECT
    business_id,
    normalized_subject,
    category_verdict,
    category_final,
    (category_verdict IN ('confirmed','corrected') AND category_final IS NOT NULL) AS qualifying
  FROM ev
)
SELECT
  business_id,
  normalized_subject,
  count(*)                                                        AS event_count,
  count(*) FILTER (WHERE qualifying)                              AS qualifying_event_count,
  count(*) FILTER (WHERE category_verdict = 'confirmed')          AS confirmed_count,
  count(*) FILTER (WHERE category_verdict = 'corrected')          AS corrected_count,
  count(*) FILTER (WHERE NOT qualifying)                          AS non_supporting_count,
  count(DISTINCT category_final) FILTER (WHERE qualifying)        AS distinct_qualifying_category_count,
  array_agg(DISTINCT category_final) FILTER (WHERE qualifying)    AS qualifying_category_values,
  CASE
    WHEN count(*) FILTER (WHERE qualifying) = 0 THEN 'insufficient_non_supporting'
    WHEN count(DISTINCT category_final) FILTER (WHERE qualifying) >= 2 THEN 'conflicting'
    WHEN count(*) FILTER (WHERE qualifying) = 1 AND count(*) FILTER (WHERE category_verdict = 'corrected') = 1 THEN 'single_corrected'
    WHEN count(*) FILTER (WHERE qualifying) = 1 THEN 'single_confirmed'
    ELSE 'repeated_agreement'
  END                                                            AS scenario
FROM tagged
GROUP BY business_id, normalized_subject
ORDER BY business_id ASC, scenario ASC, normalized_subject ASC;

-- Cross-tenant: same approx normalized subject present in more than one business (tenant-isolation targets).
\echo '== Q2: same normalized subject across multiple tenants (isolation comparison targets) =='
WITH ev AS (
  SELECT
    r."businessId" AS business_id,
    lower(btrim(
      regexp_replace(
        regexp_replace(
          translate(coalesce(r."vendorFinal", ''), E'"''`׳״', ''),
          '[.,:;(){}\[\]\-–—־]+', ' ', 'g'
        ),
        '\s+', ' ', 'g'
      )
    )) AS normalized_subject
  FROM "ReviewEvent" r
)
SELECT
  normalized_subject,
  count(DISTINCT business_id) AS tenant_count,
  array_agg(DISTINCT business_id ORDER BY business_id) AS business_ids
FROM ev
WHERE normalized_subject <> ''
GROUP BY normalized_subject
HAVING count(DISTINCT business_id) >= 2
ORDER BY tenant_count DESC, normalized_subject ASC;

-- Control: the SHADOW-VERIFY-EXECUTION-1 subject (should show one businessId=1 qualifying 'general').
\echo '== Q3: control subject shadow qa vendor =='
SELECT
  r."businessId" AS business_id,
  count(*) AS event_count,
  array_agg(DISTINCT nullif(btrim(r.verdicts -> 'category' ->> 'final'), '')) AS category_values,
  array_agg(DISTINCT (r.verdicts -> 'category' ->> 'verdict')) AS category_verdicts
FROM "ReviewEvent" r
WHERE lower(btrim(
        regexp_replace(
          regexp_replace(
            translate(coalesce(r."vendorFinal", ''), E'"''`׳״', ''),
            '[.,:;(){}\[\]\-–—־]+', ' ', 'g'
          ),
          '\s+', ' ', 'g'
        )
      )) = 'shadow qa vendor'
GROUP BY r."businessId"
ORDER BY r."businessId" ASC;

ROLLBACK;
