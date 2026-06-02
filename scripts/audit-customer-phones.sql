-- ─────────────────────────────────────────────────────────────────────────
-- Customer phone audit — run BEFORE the
-- 20260528120000_whatsapp_connection_and_customer_phone_unique migration.
--
-- This script is READ-ONLY. It does not modify any data.
--
-- It surfaces:
--   (A) Existing literal (businessId, phone) duplicates
--   (B) Duplicates that the migration's normalization step would create
--   (C) Phone format distribution per business (sanity check)
--
-- Recommended ways to run:
--   npx prisma db execute --file scripts/audit-customer-phones.sql \
--     --schema prisma/schema.prisma
--   OR paste each section into psql / pgAdmin / DataGrip.
--
-- If any of (A) or (B) returns rows: STOP. Do NOT run the migration.
-- The implementing engineer must surface the rows and wait for a manual
-- merge decision per business policy.
-- ─────────────────────────────────────────────────────────────────────────

\echo '────────────────────────────────────────'
\echo 'Section A — Literal (businessId, phone) duplicates today'
\echo '────────────────────────────────────────'
SELECT
  "businessId",
  "phone",
  COUNT(*)               AS duplicate_count,
  array_agg(id ORDER BY "createdAt") AS customer_ids,
  MIN("createdAt")       AS first_created_at,
  MAX("createdAt")       AS last_created_at
FROM "Customer"
WHERE "phone" IS NOT NULL
GROUP BY "businessId", "phone"
HAVING COUNT(*) > 1
ORDER BY duplicate_count DESC, "businessId" ASC;

\echo ''
\echo '────────────────────────────────────────'
\echo 'Section B — Duplicates the migration would introduce after normalization'
\echo '         (digits-only, with leading 0 → 972)'
\echo '────────────────────────────────────────'
WITH normalized AS (
  SELECT
    id,
    "businessId",
    "phone" AS raw_phone,
    "createdAt",
    CASE
      WHEN regexp_replace("phone", '\D', '', 'g') ~ '^972'
        THEN regexp_replace("phone", '\D', '', 'g')
      WHEN regexp_replace("phone", '\D', '', 'g') ~ '^0'
        THEN '972' || substring(regexp_replace("phone", '\D', '', 'g') from 2)
      ELSE regexp_replace("phone", '\D', '', 'g')
    END AS normalized_phone
  FROM "Customer"
  WHERE "phone" IS NOT NULL
    AND length(regexp_replace("phone", '\D', '', 'g')) >= 8
)
SELECT
  "businessId",
  normalized_phone,
  COUNT(*)                              AS group_size,
  array_agg(id ORDER BY "createdAt")    AS customer_ids,
  array_agg(raw_phone ORDER BY "createdAt") AS raw_phones,
  MIN("createdAt")                      AS first_created_at,
  MAX("createdAt")                      AS last_created_at
FROM normalized
GROUP BY "businessId", normalized_phone
HAVING COUNT(*) > 1
ORDER BY group_size DESC, "businessId" ASC;

\echo ''
\echo '────────────────────────────────────────'
\echo 'Section C — Phone format distribution (sanity / null-rate)'
\echo '────────────────────────────────────────'
SELECT
  "businessId",
  COUNT(*) FILTER (WHERE "phone" IS NULL)                                        AS null_phones,
  COUNT(*) FILTER (WHERE "phone" IS NOT NULL AND "phone" LIKE '+%')              AS plus_prefixed,
  COUNT(*) FILTER (WHERE "phone" IS NOT NULL AND "phone" LIKE '0%')              AS local_prefix_zero,
  COUNT(*) FILTER (WHERE "phone" IS NOT NULL AND "phone" LIKE '972%')            AS intl_prefix_972,
  COUNT(*) FILTER (WHERE "phone" IS NOT NULL AND "phone" ~ '[^0-9+\-\s]')        AS contains_non_digit_non_format,
  COUNT(*) FILTER (WHERE "phone" IS NOT NULL AND length(regexp_replace("phone", '\D', '', 'g')) < 8) AS too_short_after_strip,
  COUNT(*)                                                                       AS total_customers
FROM "Customer"
GROUP BY "businessId"
ORDER BY "businessId" ASC;

\echo ''
\echo '────────────────────────────────────────'
\echo 'Section D — Total Customer row count (context)'
\echo '────────────────────────────────────────'
SELECT
  COUNT(*)                                          AS total_customers,
  COUNT(*) FILTER (WHERE "phone" IS NOT NULL)       AS with_phone,
  COUNT(*) FILTER (WHERE "phone" IS NULL)           AS without_phone,
  COUNT(DISTINCT "businessId")                      AS distinct_businesses
FROM "Customer";
