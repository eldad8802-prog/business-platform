-- Business Memory · READ-OBS · bm-read-comparison telemetry evidence (read-only).
--
-- Purpose: read the DURABLE comparison observations that the read path persists to ProductUsageEvent
-- (featureKey='business-memory-read-comparison') during a controlled READ window, so the window is
-- reliably observable WITHOUT depending on ephemeral Vercel runtime logs. OPERATIONAL EVIDENCE ONLY --
-- not a product read path.
--
-- Reads ONLY the ProductUsageEvent telemetry table. It returns only non-sensitive, comparison-safe
-- fields (businessId, action, outcome, the privacy-safe metadata the sink wrote, createdAt). The sink
-- writes NO vendor / normalized subject / category value / evidence payload, so none is present here.
-- SELECT-only; READ ONLY transaction (session read-only + statement timeout + ROLLBACK). businessId is a
-- bound psql variable (:'businessId') -- no injection surface. A CI static guard rejects any write
-- keyword before this file reaches the database.

SET statement_timeout = '30s';
SET default_transaction_read_only = on;
BEGIN TRANSACTION READ ONLY;

-- Global window sanity: counts only, per (action, outcome). No tenant detail, no payload.
\echo '== Q0: bm-read-comparison counts by (action, outcome) -- counts only =='
SELECT p.action,
       p.outcome,
       count(*) AS event_count
FROM "ProductUsageEvent" p
WHERE p."featureKey" = 'business-memory-read-comparison'
GROUP BY p.action, p.outcome
ORDER BY p.action ASC, p.outcome ASC;

-- Tenant-scoped detail for the bound businessId: privacy-safe fields only.
\echo '== Q1: bm-read-comparison rows for the bound businessId (privacy-safe fields) =='
SELECT p."businessId"                            AS business_id,
       p.action                                  AS comparison,
       p.outcome                                 AS outcome,
       p.metadata                                AS safe_metadata,
       p."createdAt"                             AS created_at
FROM "ProductUsageEvent" p
WHERE p."featureKey" = 'business-memory-read-comparison'
  AND p."businessId" = (:'businessId')::int
ORDER BY p."createdAt" DESC
LIMIT 200;

ROLLBACK;
