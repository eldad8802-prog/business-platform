-- ============================================================================
-- appointments-business-9-breakdown.sql
--
-- Read-only Production facts for the TEST business (businessId = 9), to explain two pilot questions:
--   A. why the calendar shows fewer appointments than the table holds — the calendar lists TIMED appointments in
--      the dates on screen, without the cancelled ones (unless asked), per the staff filter; an untimed appointment
--      (the older path) never appears on it;
--   B. how the staff members' own weekly hours relate to the business hours — a staff member with own hours is
--      offered by those hours (they stand in for the business hours, they are not intersected with them); one without
--      own hours inherits the business hours.
--
-- Flags and counts only (scripts/ci/evidence-redact.mjs): no id value, name, phone, note or amount. Minutes after
-- midnight are clock positions, not personal data. Guard-clean: no write keyword anywhere, prose included.
--
-- OUTPUT: n | flag | observed_count
-- ============================================================================

\echo '== business 9: appointments and hours breakdown: legend =='
\echo '-- A. appointments'
\echo ' 1 appointments, all (count)'
\echo ' 2 CANCELED — hidden by default (count)'
\echo ' 3 without a start time — never on the calendar (count)'
\echo ' 4 timed, not cancelled, before today (count)'
\echo ' 5 timed, not cancelled, today to 6 days ahead (count)'
\echo ' 6 timed, not cancelled, 7 days ahead or later (count)'
\echo ' 7 kind CUSTOMER (count)'
\echo ' 8 kind INTERNAL (count)'
\echo ' 9 kind BLOCK (count)'
\echo '10 COMPLETED or NO_SHOW (count)'
\echo '11 timed, not cancelled, with no staff member — the business lane (count)'
\echo '12 timed, not cancelled, with an inactive or erased staff member (count)'
\echo '13 timed, not cancelled, PROPOSED — waiting for approval (count)'
\echo '-- B. hours (rules in force today)'
\echo '14 business-wide weekly windows (count)'
\echo '15 the latest business closing, minutes after midnight, any weekday (count; 0 when none)'
\echo '16 active staff members (count)'
\echo '17 active staff members with their own weekly hours (count)'
\echo '18 own windows ending later than the business closes on that weekday (count)'
\echo '19 own windows starting earlier than the business opens on that weekday (count)'
\echo '20 own windows on a weekday the business has no hours (count)'
\echo '21 own windows ending after 17:00 (count)'
\echo '22 the latest closing among staff own windows, minutes after midnight (count; 0 when none)'
\echo '23 active staff members offered on the booking link (count)'
\echo '24 …of them with their own weekly hours (count)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
today AS (SELECT (now() AT TIME ZONE 'Asia/Jerusalem')::date AS d),
ap AS (
  SELECT a."status"::text AS status, a."kind"::text AS kind, a."staffMemberId",
         CASE WHEN a."startsAt" IS NULL THEN NULL ELSE ((a."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Jerusalem')::date END AS day
    FROM "Appointment" a WHERE a."businessId" = 9
),
live AS (SELECT * FROM ap WHERE status <> 'CANCELED' AND day IS NOT NULL),
staff AS (SELECT m."id", m."publicBookable" FROM "StaffMember" m WHERE m."businessId" = 9 AND m."active" AND m."erasedAt" IS NULL),
rules AS (
  SELECT r."staffMemberId", r."weekday", r."startMinute", r."endMinute"
    FROM "AvailabilityRule" r, today
   WHERE r."businessId" = 9 AND r."removedAt" IS NULL
     AND (r."validFrom" IS NULL OR r."validFrom"::date <= today.d) AND (r."validUntil" IS NULL OR r."validUntil"::date >= today.d)
),
biz AS (SELECT "weekday", min("startMinute") AS opens, max("endMinute") AS closes FROM rules WHERE "staffMemberId" IS NULL GROUP BY "weekday"),
own AS (SELECT r.* FROM rules r JOIN staff s ON s."id" = r."staffMemberId"),
lines(n, flag, observed_count) AS (
            SELECT 1, NULL::boolean, (SELECT count(*) FROM ap)
  UNION ALL SELECT 2, NULL, (SELECT count(*) FROM ap WHERE status = 'CANCELED')
  UNION ALL SELECT 3, NULL, (SELECT count(*) FROM ap WHERE day IS NULL)
  UNION ALL SELECT 4, NULL, (SELECT count(*) FROM live, today WHERE live.day < today.d)
  UNION ALL SELECT 5, NULL, (SELECT count(*) FROM live, today WHERE live.day >= today.d AND live.day < today.d + 7)
  UNION ALL SELECT 6, NULL, (SELECT count(*) FROM live, today WHERE live.day >= today.d + 7)
  UNION ALL SELECT 7, NULL, (SELECT count(*) FROM ap WHERE kind = 'CUSTOMER')
  UNION ALL SELECT 8, NULL, (SELECT count(*) FROM ap WHERE kind = 'INTERNAL')
  UNION ALL SELECT 9, NULL, (SELECT count(*) FROM ap WHERE kind = 'BLOCK')
  UNION ALL SELECT 10, NULL, (SELECT count(*) FROM ap WHERE status IN ('COMPLETED', 'NO_SHOW'))
  UNION ALL SELECT 11, NULL, (SELECT count(*) FROM live WHERE "staffMemberId" IS NULL)
  UNION ALL SELECT 12, NULL, (SELECT count(*) FROM live WHERE "staffMemberId" IS NOT NULL AND "staffMemberId" NOT IN (SELECT "id" FROM staff))
  UNION ALL SELECT 13, NULL, (SELECT count(*) FROM live WHERE status = 'PROPOSED')
  UNION ALL SELECT 14, NULL, (SELECT count(*) FROM rules WHERE "staffMemberId" IS NULL)
  UNION ALL SELECT 15, NULL, (SELECT COALESCE(max(closes), 0)::bigint FROM biz)
  UNION ALL SELECT 16, NULL, (SELECT count(*) FROM staff)
  UNION ALL SELECT 17, NULL, (SELECT count(DISTINCT "staffMemberId") FROM own)
  UNION ALL SELECT 18, NULL, (SELECT count(*) FROM own o JOIN biz b ON b."weekday" = o."weekday" WHERE o."endMinute" > b.closes)
  UNION ALL SELECT 19, NULL, (SELECT count(*) FROM own o JOIN biz b ON b."weekday" = o."weekday" WHERE o."startMinute" < b.opens)
  UNION ALL SELECT 20, NULL, (SELECT count(*) FROM own o WHERE NOT EXISTS (SELECT 1 FROM biz b WHERE b."weekday" = o."weekday"))
  UNION ALL SELECT 21, NULL, (SELECT count(*) FROM own WHERE "endMinute" > 17 * 60)
  UNION ALL SELECT 22, NULL, (SELECT COALESCE(max("endMinute"), 0)::bigint FROM own)
  UNION ALL SELECT 23, NULL, (SELECT count(*) FROM staff WHERE "publicBookable")
  UNION ALL SELECT 24, NULL, (SELECT count(DISTINCT o."staffMemberId") FROM own o JOIN staff s ON s."id" = o."staffMemberId" WHERE s."publicBookable")
)
SELECT n, flag, observed_count FROM lines ORDER BY n;

ROLLBACK;
