-- ============================================================================
-- m6-website-live-proof-evidence.sql
--
-- Read-only Production evidence for the Website acquisition LIVE PROOF, to be run
-- after the owner enabled acquisition_web_forms for ONE business, that business
-- connected its site, and at least one GENUINE enquiry arrived from its real form
-- (then the same enquiry resubmitted naturally, e.g. back + resubmit).
--
-- Proves the whole chain, by counts only:
--   one business, one live website connection, nothing else enabled
--   → durable receipts, all in that business, none failed or pending
--   → each normalized, M4 identity decided, routed to a Lead
--   → the Lead in that business, M5 lifecycle evidenced by the receipt
--   → recognised as a website lead (the Secretary groups by this channel)
--   → a learning signal whose payload carries no personal field
--   → attribution kept (provider web, landing page without its query)
--   → no duplicate: one lifecycle "created" per receipt at most, payloads purged.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: counts only — no name, phone, email, answer, message or payload is printed.
-- Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== M6 website live proof — legend (n → check) =='
\echo ' 1 W1 exactly one ACTIVE website connection exists (observed = active website connections)'
\echo ' 2 W2 exactly one business has acquisition_web_forms ENABLED, and it owns that connection (observed = enabled businesses)'
\echo ' 3 W3 nothing else is enabled: no Google / Meta connection or feature row (observed = such rows)'
\echo ' 4 R1 genuine website receipts exist (observed = receipts)'
\echo ' 5 R2 every website receipt belongs to the connected business — the correct tenant (observed = receipts elsewhere)'
\echo ' 6 R3 no website receipt is failed, dead-lettered or still pending (observed = such receipts)'
\echo ' 7 N1 every processed website receipt has exactly one normalized record (observed = receipts without one)'
\echo ' 8 I1 M4 identity was decided for each (state + policy version recorded) (observed = normalized records without it)'
\echo ' 9 L1 website Leads exist, all in the connected business (observed = website leads)'
\echo '10 L2 every receipt routed to a Lead is evidenced by an M5 lifecycle event (observed = routed receipts without one)'
\echo '11 D1 no duplicate: no receipt created more than one Lead, and Leads created never exceed receipts (observed = receipts with more than one creation)'
\echo '12 S1 the website channel the Secretary groups on carries the Leads (observed = leads on intake:web.form)'
\echo '13 G1 a learning signal LEAD_LIFECYCLE_STARTED names the website source (observed = such events)'
\echo '14 G2 those learning payloads carry only origin / contactKnown / intakeSource — no personal field (observed = offending events)'
\echo '15 A1 attribution kept on every normalized website record: provider web, landing page without a query (observed = records lacking it)'
\echo '16 P1 the raw payload of every completed website receipt is purged (observed = completed receipts still holding a payload)'
\echo '17 X1 the evidence role bypasses row-level security, so every count is whole'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
conn AS (SELECT c."id", c."businessId" FROM "AcquisitionConnection" c WHERE c."sourceKey" = 'web.form' AND c."status" = 'ACTIVE'),
biz AS (SELECT DISTINCT "businessId" FROM conn),
fa AS (SELECT "businessId" FROM "BusinessFeatureAccess" WHERE "featureKey" = 'acquisition_web_forms' AND "state"::text = 'ENABLED'),
other_rows AS (
  SELECT (SELECT count(*) FROM "AcquisitionConnection" c WHERE c."sourceKey" <> 'web.form' AND c."status" <> 'REVOKED')
       + (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" IN ('acquisition_google_lead_forms', 'acquisition_meta_lead_ads') AND "state"::text = 'ENABLED') AS n),
rcpt AS (SELECT e."id", e."businessId", e."status"::text AS status, e."payload" FROM "IntakeEvent" e WHERE e."sourceKey" = 'web.form'),
norm AS (SELECT n."intakeEventId", n."businessId", n."identityState", n."identityPolicyVersion", n."routeTarget", n."attribution"
           FROM "IntakeNormalizedEvent" n JOIN rcpt r ON r."id" = n."intakeEventId" AND r."businessId" = n."businessId"),
web_leads AS (SELECT l."id", l."businessId" FROM "Lead" l WHERE l."sourceChannel" = 'intake:web.form'),
life AS (SELECT le."evidenceRef", le."kind", le."businessId" FROM "LeadLifecycleEvent" le
          WHERE le."evidenceKind" = 'intake_event' AND le."evidenceRef" IN (SELECT r."id"::text FROM rcpt r)),
dup AS (SELECT l."evidenceRef" FROM life l WHERE l."kind" = 'created' GROUP BY l."evidenceRef" HAVING count(*) > 1),
learn AS (SELECT g."payload" FROM "LearningEvent" g WHERE g."eventType" = 'LEAD_LIFECYCLE_STARTED' AND g."payload" ->> 'intakeSource' = 'web.form'),
bad_learn AS (SELECT g."payload" FROM learn g WHERE EXISTS (SELECT 1 FROM jsonb_object_keys(g."payload") k WHERE k NOT IN ('origin', 'contactKnown', 'intakeSource'))),
bad_attr AS (SELECT 1 FROM norm n WHERE n."attribution" IS NULL OR n."attribution" ->> 'provider' IS DISTINCT FROM 'web'
               OR COALESCE(n."attribution" ->> 'landingPage', '') LIKE '%?%'),
unrouted AS (SELECT 1 FROM norm n WHERE n."routeTarget" = 'lead'
               AND NOT EXISTS (SELECT 1 FROM life l WHERE l."evidenceRef" = n."intakeEventId"::text AND l."businessId" = n."businessId")),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM conn) = 1, (SELECT count(*) FROM conn)
  UNION ALL SELECT 2, (SELECT count(*) FROM fa) = 1 AND EXISTS (SELECT 1 FROM fa WHERE "businessId" IN (SELECT "businessId" FROM biz)),
                      (SELECT count(*) FROM fa)
  UNION ALL SELECT 3, (SELECT n FROM other_rows) = 0, (SELECT n FROM other_rows)
  UNION ALL SELECT 4, (SELECT count(*) FROM rcpt) >= 1, (SELECT count(*) FROM rcpt)
  UNION ALL SELECT 5, NOT EXISTS (SELECT 1 FROM rcpt r WHERE r."businessId" NOT IN (SELECT "businessId" FROM biz)),
                      (SELECT count(*) FROM rcpt r WHERE r."businessId" NOT IN (SELECT "businessId" FROM biz))
  UNION ALL SELECT 6, NOT EXISTS (SELECT 1 FROM rcpt r WHERE r.status IN ('FAILED', 'RECEIVED')),
                      (SELECT count(*) FROM rcpt r WHERE r.status IN ('FAILED', 'RECEIVED'))
  UNION ALL SELECT 7, NOT EXISTS (SELECT 1 FROM rcpt r WHERE r.status IN ('PERSISTED', 'PROCESSED') AND NOT EXISTS (SELECT 1 FROM norm n WHERE n."intakeEventId" = r."id")),
                      (SELECT count(*) FROM rcpt r WHERE r.status IN ('PERSISTED', 'PROCESSED') AND NOT EXISTS (SELECT 1 FROM norm n WHERE n."intakeEventId" = r."id"))
  UNION ALL SELECT 8, NOT EXISTS (SELECT 1 FROM norm n WHERE n."identityState" IS NULL OR n."identityPolicyVersion" IS NULL),
                      (SELECT count(*) FROM norm n WHERE n."identityState" IS NULL OR n."identityPolicyVersion" IS NULL)
  UNION ALL SELECT 9, (SELECT count(*) FROM web_leads) >= 1 AND NOT EXISTS (SELECT 1 FROM web_leads w WHERE w."businessId" NOT IN (SELECT "businessId" FROM biz)),
                      (SELECT count(*) FROM web_leads)
  UNION ALL SELECT 10, NOT EXISTS (SELECT 1 FROM unrouted), (SELECT count(*) FROM unrouted)
  UNION ALL SELECT 11, NOT EXISTS (SELECT 1 FROM dup) AND (SELECT count(*) FROM life l WHERE l."kind" = 'created') <= (SELECT count(*) FROM rcpt),
                       (SELECT count(*) FROM dup)
  UNION ALL SELECT 12, (SELECT count(*) FROM web_leads) >= 1, (SELECT count(*) FROM web_leads)
  UNION ALL SELECT 13, (SELECT count(*) FROM learn) >= 1, (SELECT count(*) FROM learn)
  UNION ALL SELECT 14, NOT EXISTS (SELECT 1 FROM bad_learn), (SELECT count(*) FROM bad_learn)
  UNION ALL SELECT 15, NOT EXISTS (SELECT 1 FROM bad_attr), (SELECT count(*) FROM bad_attr)
  UNION ALL SELECT 16, NOT EXISTS (SELECT 1 FROM rcpt r WHERE r.status IN ('PERSISTED', 'PROCESSED', 'IGNORED') AND r."payload" IS NOT NULL),
                       (SELECT count(*) FROM rcpt r WHERE r.status IN ('PERSISTED', 'PROCESSED', 'IGNORED') AND r."payload" IS NOT NULL)
  UNION ALL SELECT 17, (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user),
                       (CASE WHEN (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) THEN 1 ELSE 0 END)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
