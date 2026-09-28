-- SEC N-1 — READ-ONLY pre-/post-apply evidence for the five P0 evidence tables.
-- For the owner to run through the evidence-redacted production-db path; nothing in this
-- program runs it against Production. Every statement is a SELECT inside a READ ONLY
-- transaction. Expected before N-1: rls=false/force=false, app_runtime holding a,r,w,d.
-- Expected after N-1: rls=true/force=true, the exact grants in the migration, and zero
-- rows in every "violations" column (a row whose tenant column could fail WITH CHECK on
-- a later write would have to reference a missing business or a foreign parent).
BEGIN TRANSACTION READ ONLY;

SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
       (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
       array(SELECT p FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p
             WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime')
               AND has_table_privilege('app_runtime', c.oid, p)) AS app_runtime_privs
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('InventorySale','InventorySaleLine','InventorySourceSaleLine','BusinessAsset','CouponSurfaceEvent')
ORDER BY 1;

SELECT 'InventorySale' AS t, count(*) AS rows, count(DISTINCT "businessId") AS tenants,
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM "Business" b WHERE b."id" = s."businessId")) AS violations
FROM "InventorySale" s
UNION ALL
SELECT 'InventorySaleLine', count(*), count(DISTINCT l."businessId"),
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM "InventorySale" s WHERE s."id" = l."saleId" AND s."businessId" = l."businessId"))
FROM "InventorySaleLine" l
UNION ALL
SELECT 'InventorySourceSaleLine', count(*), count(DISTINCT x."businessId"),
       count(*) FILTER (WHERE x."saleLineId" IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM "InventorySaleLine" l WHERE l."id" = x."saleLineId" AND l."businessId" = x."businessId"))
FROM "InventorySourceSaleLine" x
UNION ALL
SELECT 'BusinessAsset', count(*), count(DISTINCT a."businessId"),
       count(*) FILTER (WHERE a."contentRunId" IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM "ContentRun" r WHERE r."id" = a."contentRunId" AND r."businessId" = a."businessId"))
FROM "BusinessAsset" a
UNION ALL
SELECT 'CouponSurfaceEvent', count(*), count(DISTINCT e."issuingBusinessId"),
       count(*) FILTER (WHERE NOT EXISTS (
         SELECT 1 FROM "Coupon" c WHERE c."id" = e."couponId" AND c."issuingBusinessId" = e."issuingBusinessId"))
FROM "CouponSurfaceEvent" e;

ROLLBACK;
