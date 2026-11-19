-- ============================================================================
-- m6-google-live-proof-evidence.sql
--
-- Read-only Production evidence for the Google Ads lead form LIVE PROOF in the pilot
-- business (businessId 9 ONLY), to be run after the owner enabled
-- acquisition_google_lead_forms for business 9, business 9 connected Google (endpoint +
-- key pasted into the lead form's webhook), optionally pressed "Send test data", and at
-- least one GENUINE lead arrived from a live lead form.
--
-- Proves the whole chain, by counts only:
--   business 9 only, one live Google connection, no other lead / commerce / telephony source live
--   → durable receipts, all in business 9, none failed or pending
--   → Google test submissions produced nothing (no Lead, no Customer, no identity link)
--   → each genuine receipt normalized, M4 identity decided, routed to a Lead in business 9
--   → M5 lifecycle evidenced by the receipt, no duplicate Lead
--   → identity: the pilot contact was new to business 9 — no existing Customer was resolved,
--     proposed or linked; every Customer / IdentityLink the pilot produced is in business 9,
--     came from its own receipt, sits on that receipt's own Lead customer, and is newer than the
--     connection; at most one Customer per genuine receipt
--   → a learning signal whose payload carries no personal field, attribution kept, payloads purged.
--
-- Production state this tolerates (expected, not a failure): the closed website pilot of
-- business 9 (its web.form connection REVOKED, its test leads kept). Owner decision 2026-11-09:
-- acquisition_web_forms STAYS ENABLED for business 9 after that pilot. C3 tolerates exactly that
-- one feature row (web forms, business 9) and nothing more: a web form feature with no live
-- web.form connection receives nothing, while any live (non-REVOKED) web.form connection, in
-- business 9 or any other business, and the web form feature ENABLED for any other business,
-- still fail C3.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: counts only — no name, phone, email, answer, campaign or payload is printed.
-- Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== M6 Google lead form live proof (business 9) — legend (n → check) =='
\echo ' 1 C1 exactly one ACTIVE Google connection exists, and it belongs to business 9 (observed = active Google connections)'
\echo ' 2 C2 exactly one business has acquisition_google_lead_forms ENABLED, and it is business 9 (observed = enabled businesses)'
\echo ' 3 C3 nothing else is live: no other lead / commerce / telephony connection, no such feature ENABLED (only web forms for business 9 tolerated), Google not open globally (observed = such rows)'
\echo ' 4 R1 genuine Google receipts exist — routed to a Lead, not a test submission (observed = genuine receipts)'
\echo ' 5 R2 every Google receipt belongs to business 9 (observed = receipts elsewhere)'
\echo ' 6 R3 no Google receipt is failed, dead-lettered or still pending (observed = such receipts)'
\echo ' 7 T1 Google test submissions produced nothing: no Lead lifecycle, no Customer, no identity link (observed = test receipts that did)'
\echo ' 8 N1 every processed Google receipt has exactly one normalized record (observed = receipts without one)'
\echo ' 9 I1 M4 identity was decided for each (state + policy version recorded) (observed = normalized records without it)'
\echo '10 L1 Google Leads exist, all in business 9 (observed = Google leads)'
\echo '11 L2 every receipt routed to a Lead is evidenced by an M5 lifecycle event (observed = routed receipts without one)'
\echo '12 D1 no duplicate: no receipt produced more than one Lead, and Leads never exceed genuine receipts (observed = receipts with more than one)'
\echo '13 K1 the pilot contact was new: no genuine receipt resolved to, or was a candidate for, an existing Customer (observed = receipts with another identity state)'
\echo '14 K2 Customers on Google Leads: all in business 9, none older than the connection, at most one per genuine receipt (observed = offending customers + excess)'
\echo '15 K3 identity links from Google receipts: business 9 only, deterministic, active, on the customer of that receipt''s own Lead, customer newer than the connection (observed = offending links)'
\echo '16 K4 no identity proposal was raised from a Google receipt (observed = proposals)'
\echo '17 G1 a learning signal LEAD_LIFECYCLE_STARTED names the Google source (observed = such events)'
\echo '18 G2 those learning payloads carry only origin / contactKnown / intakeSource — no personal field (observed = offending events)'
\echo '19 A1 attribution kept on every genuine normalized record: provider google, channel lead_form (observed = records lacking it)'
\echo '20 P1 the raw payload of every completed Google receipt is purged (observed = completed receipts still holding a payload)'
\echo '21 X1 the evidence role bypasses row-level security, so every count is whole'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
conn AS (SELECT c."id", c."businessId", c."createdAt" FROM "AcquisitionConnection" c WHERE c."sourceKey" = 'google.lead_form' AND c."status" = 'ACTIVE'),
conn_since AS (SELECT min(c."createdAt") AS at FROM conn c),
fa AS (SELECT "businessId" FROM "BusinessFeatureAccess" WHERE "featureKey" = 'acquisition_google_lead_forms' AND "state"::text = 'ENABLED'),
other_rows AS (
  SELECT (SELECT count(*) FROM "AcquisitionConnection" c
           WHERE c."sourceKey" IN ('web.form', 'meta.lead_ads', 'commerce.woocommerce', 'commerce.wix', 'telephony.cloudtalk', 'telephony.voicenter')
             AND c."status" <> 'REVOKED')
       + (SELECT count(*) FROM "BusinessFeatureAccess"
           WHERE "featureKey" IN ('acquisition_web_forms', 'acquisition_meta_lead_ads', 'commerce_woocommerce', 'commerce_wix', 'telephony_cloudtalk', 'telephony_voicenter')
             AND "state"::text = 'ENABLED'
             -- owner decision 2026-11-09: web forms stay ENABLED for business 9 only (connections above still count)
             AND NOT ("featureKey" = 'acquisition_web_forms' AND "businessId" = 9))
       + (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'acquisition_google_lead_forms' AND "globalEnabled") AS n),
rcpt AS (SELECT e."id", e."businessId", e."status"::text AS status, e."lastErrorCode", e."customerId", e."payload"
           FROM "IntakeEvent" e WHERE e."sourceKey" = 'google.lead_form'),
norm AS (SELECT n."intakeEventId", n."businessId", n."identityState", n."identityPolicyVersion", n."routeTarget", n."attribution"
           FROM "IntakeNormalizedEvent" n JOIN rcpt r ON r."id" = n."intakeEventId" AND r."businessId" = n."businessId"),
genuine AS (SELECT r.* FROM rcpt r JOIN norm n ON n."intakeEventId" = r."id" WHERE n."routeTarget" = 'lead'),
test_rcpt AS (SELECT r.* FROM rcpt r WHERE r."lastErrorCode" = 'test_submission'
                 OR EXISTS (SELECT 1 FROM norm n WHERE n."intakeEventId" = r."id" AND n."routeTarget" = 'none')),
g_leads AS (SELECT l."id", l."businessId", l."customerId" FROM "Lead" l WHERE l."sourceChannel" = 'intake:google.lead_form'),
life AS (SELECT le."evidenceRef", le."kind", le."businessId", le."leadId" FROM "LeadLifecycleEvent" le
          WHERE le."evidenceKind" = 'intake_event' AND le."evidenceRef" IN (SELECT r."id"::text FROM rcpt r)),
dup AS (SELECT l."evidenceRef" FROM life l WHERE l."kind" = 'created' GROUP BY l."evidenceRef" HAVING count(*) > 1),
-- The customer of each receipt's own Lead (through the lifecycle event that receipt evidences).
rcpt_customer AS (SELECT l."evidenceRef"::int AS "intakeEventId", ld."customerId", ld."businessId"
                    FROM life l JOIN "Lead" ld ON ld."id" = l."leadId" AND ld."businessId" = l."businessId"),
g_links AS (SELECT k."id", k."businessId", k."customerId", k."method", k."status", k."sourceIntakeEventId"
              FROM "IdentityLink" k WHERE k."sourceIntakeEventId" IN (SELECT r."id" FROM rcpt r)),
g_customers AS (SELECT DISTINCT cu."id", cu."businessId", cu."createdAt"
                  FROM "Customer" cu WHERE cu."id" IN (SELECT gl."customerId" FROM g_leads gl WHERE gl."customerId" IS NOT NULL)),
bad_test AS (SELECT t."id" FROM test_rcpt t
              WHERE t."customerId" IS NOT NULL
                 OR EXISTS (SELECT 1 FROM life l WHERE l."evidenceRef" = t."id"::text)
                 OR EXISTS (SELECT 1 FROM g_links k WHERE k."sourceIntakeEventId" = t."id")),
bad_customers AS (SELECT cu."id" FROM g_customers cu
                   WHERE cu."businessId" <> 9 OR cu."createdAt" < (SELECT at FROM conn_since) OR (SELECT at FROM conn_since) IS NULL),
bad_links AS (SELECT k."id" FROM g_links k
               WHERE k."businessId" <> 9 OR k."method" <> 'deterministic' OR k."status" <> 'active'
                  OR NOT EXISTS (SELECT 1 FROM rcpt_customer rc WHERE rc."intakeEventId" = k."sourceIntakeEventId" AND rc."customerId" = k."customerId")
                  OR EXISTS (SELECT 1 FROM "Customer" cu WHERE cu."id" = k."customerId"
                               AND (cu."createdAt" < (SELECT at FROM conn_since) OR (SELECT at FROM conn_since) IS NULL))),
g_proposals AS (SELECT p."id" FROM "IdentityProposal" p WHERE p."intakeEventId" IN (SELECT r."id" FROM rcpt r)),
learn AS (SELECT g."payload" FROM "LearningEvent" g WHERE g."eventType" = 'LEAD_LIFECYCLE_STARTED' AND g."payload" ->> 'intakeSource' = 'google.lead_form'),
bad_learn AS (SELECT g."payload" FROM learn g WHERE EXISTS (SELECT 1 FROM jsonb_object_keys(g."payload") k WHERE k NOT IN ('origin', 'contactKnown', 'intakeSource'))),
bad_attr AS (SELECT 1 FROM norm n WHERE n."routeTarget" = 'lead'
               AND (n."attribution" IS NULL OR n."attribution" ->> 'provider' IS DISTINCT FROM 'google'
                    OR n."attribution" ->> 'channel' IS DISTINCT FROM 'lead_form')),
unrouted AS (SELECT 1 FROM norm n WHERE n."routeTarget" = 'lead'
               AND NOT EXISTS (SELECT 1 FROM life l WHERE l."evidenceRef" = n."intakeEventId"::text AND l."businessId" = n."businessId")),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM conn) = 1 AND NOT EXISTS (SELECT 1 FROM conn WHERE "businessId" <> 9), (SELECT count(*) FROM conn)
  UNION ALL SELECT 2, (SELECT count(*) FROM fa) = 1 AND EXISTS (SELECT 1 FROM fa WHERE "businessId" = 9), (SELECT count(*) FROM fa)
  UNION ALL SELECT 3, (SELECT n FROM other_rows) = 0, (SELECT n FROM other_rows)
  UNION ALL SELECT 4, (SELECT count(*) FROM genuine) >= 1, (SELECT count(*) FROM genuine)
  UNION ALL SELECT 5, NOT EXISTS (SELECT 1 FROM rcpt r WHERE r."businessId" <> 9),
                      (SELECT count(*) FROM rcpt r WHERE r."businessId" <> 9)
  UNION ALL SELECT 6, NOT EXISTS (SELECT 1 FROM rcpt r WHERE r.status IN ('FAILED', 'RECEIVED')),
                      (SELECT count(*) FROM rcpt r WHERE r.status IN ('FAILED', 'RECEIVED'))
  UNION ALL SELECT 7, NOT EXISTS (SELECT 1 FROM bad_test), (SELECT count(*) FROM bad_test)
  UNION ALL SELECT 8, NOT EXISTS (SELECT 1 FROM rcpt r WHERE r.status IN ('PERSISTED', 'PROCESSED') AND NOT EXISTS (SELECT 1 FROM norm n WHERE n."intakeEventId" = r."id")),
                      (SELECT count(*) FROM rcpt r WHERE r.status IN ('PERSISTED', 'PROCESSED') AND NOT EXISTS (SELECT 1 FROM norm n WHERE n."intakeEventId" = r."id"))
  UNION ALL SELECT 9, NOT EXISTS (SELECT 1 FROM norm n WHERE n."routeTarget" = 'lead' AND (n."identityState" IS NULL OR n."identityPolicyVersion" IS NULL)),
                      (SELECT count(*) FROM norm n WHERE n."routeTarget" = 'lead' AND (n."identityState" IS NULL OR n."identityPolicyVersion" IS NULL))
  UNION ALL SELECT 10, (SELECT count(*) FROM g_leads) >= 1 AND NOT EXISTS (SELECT 1 FROM g_leads w WHERE w."businessId" <> 9),
                       (SELECT count(*) FROM g_leads)
  UNION ALL SELECT 11, NOT EXISTS (SELECT 1 FROM unrouted), (SELECT count(*) FROM unrouted)
  UNION ALL SELECT 12, NOT EXISTS (SELECT 1 FROM dup) AND (SELECT count(*) FROM g_leads) <= (SELECT count(*) FROM genuine),
                       (SELECT count(*) FROM dup)
  UNION ALL SELECT 13, NOT EXISTS (SELECT 1 FROM norm n WHERE n."routeTarget" = 'lead' AND n."identityState" IS DISTINCT FROM 'unresolved'),
                       (SELECT count(*) FROM norm n WHERE n."routeTarget" = 'lead' AND n."identityState" IS DISTINCT FROM 'unresolved')
  UNION ALL SELECT 14, NOT EXISTS (SELECT 1 FROM bad_customers) AND (SELECT count(*) FROM g_customers) <= (SELECT count(*) FROM genuine),
                       (SELECT count(*) FROM bad_customers) + GREATEST((SELECT count(*) FROM g_customers) - (SELECT count(*) FROM genuine), 0)
  UNION ALL SELECT 15, NOT EXISTS (SELECT 1 FROM bad_links), (SELECT count(*) FROM bad_links)
  UNION ALL SELECT 16, NOT EXISTS (SELECT 1 FROM g_proposals), (SELECT count(*) FROM g_proposals)
  UNION ALL SELECT 17, (SELECT count(*) FROM learn) >= 1, (SELECT count(*) FROM learn)
  UNION ALL SELECT 18, NOT EXISTS (SELECT 1 FROM bad_learn), (SELECT count(*) FROM bad_learn)
  UNION ALL SELECT 19, NOT EXISTS (SELECT 1 FROM bad_attr), (SELECT count(*) FROM bad_attr)
  UNION ALL SELECT 20, NOT EXISTS (SELECT 1 FROM rcpt r WHERE r.status IN ('PERSISTED', 'PROCESSED', 'IGNORED') AND r."payload" IS NOT NULL),
                       (SELECT count(*) FROM rcpt r WHERE r.status IN ('PERSISTED', 'PROCESSED', 'IGNORED') AND r."payload" IS NOT NULL)
  UNION ALL SELECT 21, (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user),
                       (CASE WHEN (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) THEN 1 ELSE 0 END)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
