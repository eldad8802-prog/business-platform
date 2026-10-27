-- ============================================================================
-- public-booking-pilot-business-9.sql
--
-- Read-only Production facts for the public booking pilot on the TEST business (businessId = 9), and the proof
-- that no other business is touched. Run before the pilot (readiness: what is configured), during it (monitoring:
-- requests, response times, expiries, anomalies) and after it is switched back.
--
--   A. readiness  — the link, the open services and their approval modes, the staff offered and the lanes they
--                   give, live push subscriptions, the flag for business 9 and the platform switches;
--   B. requests   — by status, the oldest one still waiting, how long the owner takes to approve or decline,
--                   expiries, customer withdrawals;
--   C. anomalies  — states that must never coexist (a sign the sweep or a decision path failed); each expected 0;
--   D. isolation  — no other business has a link, an open service, a public staff member, a request, a token or
--                   a public_booking override.
--
-- Flags and counts only (scripts/ci/evidence-redact.mjs): no id value, name, phone, token, note or amount.
-- Durations are whole minutes. Guard-clean: no write keyword anywhere, prose included.
--
-- OUTPUT: n | flag | observed_count
-- ============================================================================

\echo '== public booking pilot, business 9: legend =='
\echo '-- A. readiness'
\echo ' 1 business 9 has booking settings (flag)'
\echo ' 2 business 9: the link is switched on (flag)'
\echo ' 3 business 9: the customer may choose a staff member (OPTIONAL or REQUIRED) (flag)'
\echo ' 4 business 9: self-cancel is on (flag)'
\echo ' 5 business 9: active services open on the link (count)'
\echo ' 6 …of them approved by the owner (MANUAL) (count)'
\echo ' 7 …of them approved automatically (AUTO) (count)'
\echo ' 8 business 9: active staff members offered on the link (count)'
\echo ' 9 business 9: lanes a customer can book = offered staff x open services they perform (count)'
\echo '10 business 9: live push subscriptions (not revoked) (count)'
\echo '11 business 9: public_booking override is ENABLED (flag)'
\echo '12 business 9: public_booking override is DISABLED (flag)'
\echo '13 public_booking: global policy off and no emergency switch (flag; expected true)'
\echo '14 public_booking: the platform emergency switch is set (flag)'
\echo '-- B. requests (business 9)'
\echo '15 requests, all time (count)'
\echo '16 waiting now: PENDING and not past their expiry (count)'
\echo '17 the oldest request still waiting, minutes since it was sent (count; 0 when none)'
\echo '18 waiting two hours or more — a reminder is due or was sent (count)'
\echo '19 APPROVED (count)'
\echo '20 DECLINED (count)'
\echo '21 EXPIRED — not answered in time (count)'
\echo '22 WITHDRAWN — cancelled by the customer while waiting (count)'
\echo '23 decided by the owner (automatic confirmations excluded): median minutes from request to decision (count; 0 when none)'
\echo '24 decided by the owner: the longest, minutes (count; 0 when none)'
\echo '25 decided by the owner within two hours (count, of the owner decisions)'
\echo '26 requests in the last 24 hours (count)'
\echo '27 appointments from the link cancelled by the customer after confirmation (count)'
\echo '-- C. anomalies (each expected 0)'
\echo '28 PENDING but past expiry by more than 15 minutes — the sweep did not run (count)'
\echo '29 PENDING but its appointment is not PROPOSED (count)'
\echo '30 APPROVED but its appointment is still PROPOSED (count)'
\echo '31 DECLINED or EXPIRED or WITHDRAWN but its appointment still holds the time (PROPOSED or CONFIRMED) (count)'
\echo '32 a request that expires after its appointment starts (count)'
\echo '33 declined, expired or owner-approved, yet its bell notice is still open (count; a customer cancellation and an automatic booking awaiting its customer link stay open on purpose)'
\echo '34 two live requests holding the same staff member at overlapping times (count)'
\echo '-- D. isolation (each expected 0)'
\echo '35 OTHER businesses: booking settings with the link on (count)'
\echo '36 OTHER businesses: services open on the link (count)'
\echo '37 OTHER businesses: staff members offered on the link (count)'
\echo '38 OTHER businesses: booking requests or manage tokens (count)'
\echo '39 OTHER businesses: public_booking override rows, any state (count)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
now_utc AS (SELECT (now() AT TIME ZONE 'UTC') AS t),
bs AS (SELECT s.* FROM "BookingSettings" s WHERE s."businessId" = 9),
open_svc AS (
  SELECT p."businessServiceId", p."approvalMode"::text AS mode
    FROM "ServiceBookingPolicy" p JOIN "BusinessService" s ON s."id" = p."businessServiceId" AND s."businessId" = p."businessId"
   WHERE p."businessId" = 9 AND p."publicBookable" AND s."active"
),
pub_staff AS (SELECT m."id" FROM "StaffMember" m WHERE m."businessId" = 9 AND m."publicBookable" AND m."active" AND m."erasedAt" IS NULL),
req AS (SELECT r.* FROM "BookingRequest" r WHERE r."businessId" = 9),
-- The owner's own decisions only: an automatically confirmed request carries no deciding user and took no time.
decided AS (
  SELECT EXTRACT(EPOCH FROM (r."decidedAt" - r."createdAt")) / 60.0 AS minutes
    FROM req r WHERE r."status"::text IN ('APPROVED', 'DECLINED') AND r."decidedAt" IS NOT NULL AND r."decidedByUserId" IS NOT NULL
),
ra AS (SELECT r.*, a."status"::text AS appt_status, a."startsAt", a."endsAt", a."staffMemberId", a."sourceChannel"::text AS channel, a."cancelReason"::text AS reason
         FROM req r JOIN "Appointment" a ON a."id" = r."appointmentId" AND a."businessId" = r."businessId"),
o9 AS (SELECT a.state::text AS state FROM "BusinessFeatureAccess" a WHERE a."businessId" = 9 AND a."featureKey" = 'public_booking'),
lines(n, flag, observed_count) AS (
            SELECT 1, EXISTS (SELECT 1 FROM bs), NULL::bigint
  UNION ALL SELECT 2, COALESCE((SELECT bool_or(enabled) FROM bs), false), NULL
  UNION ALL SELECT 3, COALESCE((SELECT bool_or("staffChoiceMode"::text IN ('OPTIONAL', 'REQUIRED')) FROM bs), false), NULL
  UNION ALL SELECT 4, COALESCE((SELECT bool_or("selfCancelEnabled") FROM bs), false), NULL
  UNION ALL SELECT 5, NULL, (SELECT count(*) FROM open_svc)
  UNION ALL SELECT 6, NULL, (SELECT count(*) FROM open_svc WHERE mode = 'MANUAL')
  UNION ALL SELECT 7, NULL, (SELECT count(*) FROM open_svc WHERE mode = 'AUTO')
  UNION ALL SELECT 8, NULL, (SELECT count(*) FROM pub_staff)
  UNION ALL SELECT 9, NULL, (SELECT count(*) FROM "StaffServiceAssignment" x
                              WHERE x."businessId" = 9 AND x."removedAt" IS NULL
                                AND x."staffMemberId" IN (SELECT "id" FROM pub_staff)
                                AND x."businessServiceId" IN (SELECT "businessServiceId" FROM open_svc))
  UNION ALL SELECT 10, NULL, (SELECT count(*) FROM "PushSubscription" ps WHERE ps."businessId" = 9 AND ps."revokedAt" IS NULL)
  UNION ALL SELECT 11, COALESCE((SELECT bool_or(state = 'ENABLED') FROM o9), false), NULL
  UNION ALL SELECT 12, COALESCE((SELECT bool_or(state = 'DISABLED') FROM o9), false), NULL
  UNION ALL SELECT 13, (SELECT bool_and(NOT p."globalEnabled" AND NOT p."emergencyDisabled") FROM "PlatformFeaturePolicy" p WHERE p."featureKey" = 'public_booking'), NULL
  UNION ALL SELECT 14, COALESCE((SELECT bool_or(p."emergencyDisabled") FROM "PlatformFeaturePolicy" p WHERE p."featureKey" = 'public_booking'), false), NULL
  UNION ALL SELECT 15, NULL, (SELECT count(*) FROM req)
  UNION ALL SELECT 16, NULL, (SELECT count(*) FROM req r, now_utc WHERE r."status"::text = 'PENDING' AND r."expiresAt" > now_utc.t)
  UNION ALL SELECT 17, NULL, (SELECT COALESCE(floor(max(EXTRACT(EPOCH FROM (now_utc.t - r."createdAt")) / 60.0)), 0)::bigint
                               FROM req r, now_utc WHERE r."status"::text = 'PENDING' AND r."expiresAt" > now_utc.t)
  UNION ALL SELECT 18, NULL, (SELECT count(*) FROM req r, now_utc
                              WHERE r."status"::text = 'PENDING' AND r."expiresAt" > now_utc.t AND r."createdAt" <= now_utc.t - interval '2 hours')
  UNION ALL SELECT 19, NULL, (SELECT count(*) FROM req WHERE "status"::text = 'APPROVED')
  UNION ALL SELECT 20, NULL, (SELECT count(*) FROM req WHERE "status"::text = 'DECLINED')
  UNION ALL SELECT 21, NULL, (SELECT count(*) FROM req WHERE "status"::text = 'EXPIRED')
  UNION ALL SELECT 22, NULL, (SELECT count(*) FROM req WHERE "status"::text = 'WITHDRAWN')
  UNION ALL SELECT 23, NULL, (SELECT COALESCE(round(percentile_cont(0.5) WITHIN GROUP (ORDER BY minutes)), 0)::bigint FROM decided)
  UNION ALL SELECT 24, NULL, (SELECT COALESCE(round(max(minutes)), 0)::bigint FROM decided)
  UNION ALL SELECT 25, NULL, (SELECT count(*) FROM decided WHERE minutes <= 120)
  UNION ALL SELECT 26, NULL, (SELECT count(*) FROM req r, now_utc WHERE r."createdAt" > now_utc.t - interval '24 hours')
  UNION ALL SELECT 27, NULL, (SELECT count(*) FROM ra WHERE "status"::text = 'APPROVED' AND appt_status = 'CANCELED' AND reason = 'CUSTOMER_CANCELED')
  UNION ALL SELECT 28, NULL, (SELECT count(*) FROM req r, now_utc WHERE r."status"::text = 'PENDING' AND r."expiresAt" < now_utc.t - interval '15 minutes')
  UNION ALL SELECT 29, NULL, (SELECT count(*) FROM ra WHERE "status"::text = 'PENDING' AND appt_status <> 'PROPOSED')
  UNION ALL SELECT 30, NULL, (SELECT count(*) FROM ra WHERE "status"::text = 'APPROVED' AND appt_status = 'PROPOSED')
  UNION ALL SELECT 31, NULL, (SELECT count(*) FROM ra WHERE "status"::text IN ('DECLINED', 'EXPIRED', 'WITHDRAWN') AND appt_status IN ('PROPOSED', 'CONFIRMED'))
  UNION ALL SELECT 32, NULL, (SELECT count(*) FROM ra WHERE "startsAt" IS NOT NULL AND "expiresAt" > "startsAt")
  -- Open on purpose (not counted): a customer's cancellation notice, and an automatically confirmed booking waiting
  -- for the owner to link the customer (D6).
  UNION ALL SELECT 33, NULL, (SELECT count(*) FROM ra r JOIN "Notification" x ON x."businessId" = 9 AND x."dedupeKey" = 'booking-request:' || r."id"
                              WHERE x."resolvedAt" IS NULL
                                AND (r."status"::text IN ('DECLINED', 'EXPIRED')
                                  OR (r."status"::text = 'APPROVED' AND r."decidedByUserId" IS NOT NULL AND COALESCE(r.reason, '') <> 'CUSTOMER_CANCELED')))
  UNION ALL SELECT 34, NULL, (SELECT count(*) FROM ra a1 JOIN ra a2 ON a1."id" < a2."id" AND a1."staffMemberId" = a2."staffMemberId"
                              WHERE a1."staffMemberId" IS NOT NULL AND a1.appt_status IN ('PROPOSED', 'CONFIRMED') AND a2.appt_status IN ('PROPOSED', 'CONFIRMED')
                                AND a1."startsAt" < a2."endsAt" AND a2."startsAt" < a1."endsAt")
  UNION ALL SELECT 35, NULL, (SELECT count(*) FROM "BookingSettings" s WHERE s."businessId" <> 9 AND s.enabled)
  UNION ALL SELECT 36, NULL, (SELECT count(*) FROM "ServiceBookingPolicy" p WHERE p."businessId" <> 9 AND p."publicBookable")
  UNION ALL SELECT 37, NULL, (SELECT count(*) FROM "StaffMember" m WHERE m."businessId" <> 9 AND m."publicBookable")
  UNION ALL SELECT 38, NULL, (SELECT (SELECT count(*) FROM "BookingRequest" WHERE "businessId" <> 9) + (SELECT count(*) FROM "AppointmentManageToken" WHERE "businessId" <> 9))
  UNION ALL SELECT 39, NULL, (SELECT count(*) FROM "BusinessFeatureAccess" a WHERE a."businessId" <> 9 AND a."featureKey" = 'public_booking')
)
SELECT n, flag, observed_count FROM lines ORDER BY n;

ROLLBACK;
