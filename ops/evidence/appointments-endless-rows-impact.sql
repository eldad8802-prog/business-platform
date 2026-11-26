-- ============================================================================
-- appointments-endless-rows-impact.sql
--
-- Read-only Production count for PR #1285 (G22, owner approved 2026-11-26), to run BEFORE #1285 lands on main.
-- With #1285 a live appointment that has a start but no end occupies time: its own length
-- ("durationMinutes"), else 60 minutes (availability.core effectiveEnd, UNTIMED_DEFAULT_MINUTES).
-- This file measures what that means for the rows that exist today:
--   - live (PROPOSED / CONFIRMED) rows with a start and no end, starting from 30 days ago onward
--     (future, and the past 30 days), overall and per business;
--   - how many of them would then meet another live appointment of the same lane: the business lane
--     (no staff member) meets every lane, a staff lane meets itself and the business lane; occupied
--     ranges include each row's buffers, the same rule as laneOccupants / Appointment_no_overlap;
--   - live rows with no start at all, counted apart (they occupy nothing; they show under "ללא שעה").
--
-- Counts and flags only (scripts/ci/evidence-redact.mjs): the per-business section carries the business
-- id, which the redactor masks in the public log by design; no customer, title, note or phone is read.
-- Guard-clean: SELECT only, no temporary objects, no write keyword anywhere, prose included.
-- Times: "startsAt" / "endsAt" are UTC timestamps without zone, compared with UTC now.
--
-- OUTPUT: section 1 n | flag | observed_count ; section 2 business_id | endless_count | ... (top 200)
-- ============================================================================

\echo '== appointments with a start and no end (G22): legend =='
\echo ' 1 live rows with a start and no end, starting within the past 30 days or later (count)'
\echo ' 2   of them in the future (count)'
\echo ' 3   of them in the past 30 days (count)'
\echo ' 4   businesses that have at least one (count)'
\echo ' 5   of them in a staff lane (count; the rest are in the business lane)'
\echo ' 6   of them with their own length (count; the rest would take 60 minutes)'
\echo ' 7   of them that would meet another live appointment of the same lane (count)'
\echo ' 8   meetings: pairs of (row 1, another live appointment) that would meet (count)'
\echo ' 9   of the rows in 7, those in the future (count)'
\echo '10 live rows with no start at all, any age (count)'
\echo '11   businesses that have at least one (count)'
\echo '12 business 9 (the test business) has rows of line 1 or line 10 (flag)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';

WITH
now_utc AS (SELECT timezone('UTC', now()) AS t),
live AS (
  SELECT a."id", a."businessId", a."staffMemberId", a."startsAt",
         COALESCE(a."endsAt", a."startsAt" + COALESCE(NULLIF(a."durationMinutes", 0), 60) * interval '1 minute') AS ends_at,
         a."endsAt" IS NULL AS endless,
         a."durationMinutes",
         a."bufferBeforeMinutes", a."bufferAfterMinutes"
  FROM "Appointment" a
  WHERE a."status" IN ('PROPOSED', 'CONFIRMED') AND a."startsAt" IS NOT NULL
),
endless AS (
  SELECT l.* FROM live l, now_utc
  WHERE l.endless AND l."startsAt" >= now_utc.t - interval '30 days'
),
meets AS (
  SELECT e."id" AS endless_id, o."id" AS other_id
  FROM endless e
  JOIN live o
    ON o."businessId" = e."businessId"
   AND o."id" <> e."id"
   AND (e."staffMemberId" IS NULL OR o."staffMemberId" IS NULL OR e."staffMemberId" = o."staffMemberId")
   AND (o."startsAt" - o."bufferBeforeMinutes" * interval '1 minute') < (e.ends_at + e."bufferAfterMinutes" * interval '1 minute')
   AND (e."startsAt" - e."bufferBeforeMinutes" * interval '1 minute') < (o.ends_at + o."bufferAfterMinutes" * interval '1 minute')
),
nostart AS (
  SELECT a."id", a."businessId" FROM "Appointment" a
  WHERE a."status" IN ('PROPOSED', 'CONFIRMED') AND a."startsAt" IS NULL
)
SELECT n, flag, observed_count FROM (
  SELECT  1 AS n, NULL::boolean AS flag, (SELECT count(*) FROM endless)::bigint AS observed_count
  UNION ALL SELECT  2, NULL, (SELECT count(*) FROM endless, now_utc WHERE endless."startsAt" >= now_utc.t)
  UNION ALL SELECT  3, NULL, (SELECT count(*) FROM endless, now_utc WHERE endless."startsAt" < now_utc.t)
  UNION ALL SELECT  4, NULL, (SELECT count(DISTINCT "businessId") FROM endless)
  UNION ALL SELECT  5, NULL, (SELECT count(*) FROM endless WHERE "staffMemberId" IS NOT NULL)
  UNION ALL SELECT  6, NULL, (SELECT count(*) FROM endless WHERE COALESCE("durationMinutes", 0) > 0)
  UNION ALL SELECT  7, NULL, (SELECT count(DISTINCT endless_id) FROM meets)
  UNION ALL SELECT  8, NULL, (SELECT count(*) FROM meets)
  UNION ALL SELECT  9, NULL, (SELECT count(DISTINCT m.endless_id) FROM meets m JOIN endless e ON e."id" = m.endless_id, now_utc WHERE e."startsAt" >= now_utc.t)
  UNION ALL SELECT 10, NULL, (SELECT count(*) FROM nostart)
  UNION ALL SELECT 11, NULL, (SELECT count(DISTINCT "businessId") FROM nostart)
  UNION ALL SELECT 12, (EXISTS (SELECT 1 FROM endless WHERE "businessId" = 9) OR EXISTS (SELECT 1 FROM nostart WHERE "businessId" = 9)), NULL
) s
ORDER BY n;

\echo '== per business (business id masked in the public log; counts visible), top 200 by rows =='

WITH
now_utc AS (SELECT timezone('UTC', now()) AS t),
live AS (
  SELECT a."id", a."businessId", a."staffMemberId", a."startsAt",
         COALESCE(a."endsAt", a."startsAt" + COALESCE(NULLIF(a."durationMinutes", 0), 60) * interval '1 minute') AS ends_at,
         a."endsAt" IS NULL AS endless,
         a."bufferBeforeMinutes", a."bufferAfterMinutes"
  FROM "Appointment" a
  WHERE a."status" IN ('PROPOSED', 'CONFIRMED') AND a."startsAt" IS NOT NULL
),
endless AS (
  SELECT l.* FROM live l, now_utc
  WHERE l.endless AND l."startsAt" >= now_utc.t - interval '30 days'
),
meets AS (
  SELECT DISTINCT e."id" AS endless_id, e."businessId"
  FROM endless e
  JOIN live o
    ON o."businessId" = e."businessId"
   AND o."id" <> e."id"
   AND (e."staffMemberId" IS NULL OR o."staffMemberId" IS NULL OR e."staffMemberId" = o."staffMemberId")
   AND (o."startsAt" - o."bufferBeforeMinutes" * interval '1 minute') < (e.ends_at + e."bufferAfterMinutes" * interval '1 minute')
   AND (e."startsAt" - e."bufferBeforeMinutes" * interval '1 minute') < (o.ends_at + o."bufferAfterMinutes" * interval '1 minute')
),
nostart AS (
  SELECT a."businessId", count(*) AS c FROM "Appointment" a
  WHERE a."status" IN ('PROPOSED', 'CONFIRMED') AND a."startsAt" IS NULL
  GROUP BY a."businessId"
),
per_biz AS (
  SELECT b."businessId",
         count(*) AS endless_count,
         count(*) FILTER (WHERE b."startsAt" >= (SELECT t FROM now_utc)) AS endless_future_count
  FROM endless b GROUP BY b."businessId"
),
ids AS (
  SELECT "businessId" FROM per_biz UNION SELECT "businessId" FROM nostart
)
SELECT i."businessId" AS business_id,
       COALESCE(p.endless_count, 0) AS endless_count,
       COALESCE(p.endless_future_count, 0) AS endless_future_count,
       (SELECT count(*) FROM meets m WHERE m."businessId" = i."businessId") AS overlapping_count,
       COALESCE(ns.c, 0) AS no_start_count
FROM ids i
LEFT JOIN per_biz p ON p."businessId" = i."businessId"
LEFT JOIN nostart ns ON ns."businessId" = i."businessId"
ORDER BY COALESCE(p.endless_count, 0) + COALESCE(ns.c, 0) DESC, i."businessId"
LIMIT 200;

ROLLBACK;
