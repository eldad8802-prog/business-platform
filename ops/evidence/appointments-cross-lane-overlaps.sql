-- ============================================================================
-- appointments-cross-lane-overlaps.sql
--
-- Read-only: active appointments that overlap ACROSS lanes — the business's own lane (no staff member: general
-- appointments, internal meetings, business-wide blocks) against a staff member's lane. Since P0-1 (#896) every
-- write refuses such an overlap under the per-business lock; rows written before it may still hold one. Nothing
-- is corrected here: this only counts them, so the owner can decide before a wider rollout.
--
-- The same rule as the application and the database (availability.core occupiedRange, Appointment_no_overlap):
--   - occupying = status PROPOSED or CONFIRMED, with an end time (an untimed row occupies nothing);
--   - the occupied range = [startsAt − bufferBeforeMinutes, endsAt + bufferAfterMinutes), half-open, so two
--     appointments that only touch do not overlap;
--   - forbidden = one of the pair in the business lane, the other in a staff lane;
--   - allowed   = two DIFFERENT staff members at the same time (parallel lanes) — counted apart, for context;
--   - same lane = the database constraint already forbids it (expected 0).
--
-- PREPARED, NOT RUN in Production (owner P0-2, 2026-11-01): running it needs a separate owner approval and a check
-- that no other track's evidence run is pending (a dispatch can cancel it). Verified on an isolated lab database by
-- .appt/app-battery.ts section N.
--
-- Counts and flags only (scripts/ci/evidence-redact.mjs): no id, business id, name, phone, note or time. The
-- per-business view is aggregated (how many businesses; business 9 vs the rest), as the repository is public.
-- Guard-clean: no write keyword anywhere, prose included.
--
-- OUTPUT: n | flag | observed_count
-- ============================================================================

\echo '== appointments: cross-lane overlaps: legend =='
\echo ' 1 forbidden pairs: business lane x staff lane, both occupying, ranges overlap (count)'
\echo ' 2 …of them where either appointment ends after now (count)'
\echo ' 3 businesses with at least one forbidden pair (count)'
\echo ' 4 forbidden pairs in business 9, the test business (count)'
\echo ' 5 forbidden pairs in any other business (count)'
\echo ' 6 same-lane overlapping pairs — the database constraint forbids them (count; expected 0)'
\echo ' 7 allowed parallel pairs: two different staff members at the same time (count; context)'
\echo ' 8 no forbidden pair at all (flag)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
occ AS (
  SELECT a."id", a."businessId", a."staffMemberId", a."endsAt",
         tsrange(a."startsAt" - a."bufferBeforeMinutes" * interval '1 minute',
                 a."endsAt" + a."bufferAfterMinutes" * interval '1 minute', '[)') AS r
    FROM "Appointment" a
   WHERE a."status" IN ('PROPOSED', 'CONFIRMED') AND a."startsAt" IS NOT NULL AND a."endsAt" IS NOT NULL
),
pairs AS (
  SELECT x."businessId",
         CASE
           WHEN (x."staffMemberId" IS NULL) <> (y."staffMemberId" IS NULL) THEN 'forbidden'
           WHEN COALESCE(x."staffMemberId", 0) = COALESCE(y."staffMemberId", 0) THEN 'same_lane'
           ELSE 'parallel'
         END AS kind,
         (GREATEST(x."endsAt", y."endsAt") > (now() AT TIME ZONE 'UTC')) AS ahead
    FROM occ x
    JOIN occ y ON y."businessId" = x."businessId" AND y."id" > x."id" AND x.r && y.r
),
lines(n, flag, observed_count) AS (
            SELECT 1, NULL::boolean, (SELECT count(*) FROM pairs WHERE kind = 'forbidden')
  UNION ALL SELECT 2, NULL, (SELECT count(*) FROM pairs WHERE kind = 'forbidden' AND ahead)
  UNION ALL SELECT 3, NULL, (SELECT count(DISTINCT "businessId") FROM pairs WHERE kind = 'forbidden')
  UNION ALL SELECT 4, NULL, (SELECT count(*) FROM pairs WHERE kind = 'forbidden' AND "businessId" = 9)
  UNION ALL SELECT 5, NULL, (SELECT count(*) FROM pairs WHERE kind = 'forbidden' AND "businessId" <> 9)
  UNION ALL SELECT 6, NULL, (SELECT count(*) FROM pairs WHERE kind = 'same_lane')
  UNION ALL SELECT 7, NULL, (SELECT count(*) FROM pairs WHERE kind = 'parallel')
  UNION ALL SELECT 8, (SELECT count(*) = 0 FROM pairs WHERE kind = 'forbidden'), NULL::bigint
)
SELECT n, flag, observed_count FROM lines ORDER BY n;

ROLLBACK;
