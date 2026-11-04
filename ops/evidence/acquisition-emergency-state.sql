-- ============================================================================
-- acquisition-emergency-state.sql
--
-- Read-only Production state check BEFORE merging Leads L1.5-a part 2 (#952, the emergency switch HOLDS deliveries):
-- what the platform emergency switch and the connections look like right now, for the seven intake sources
-- (acquisition_web_forms, acquisition_google_lead_forms, acquisition_meta_lead_ads, commerce_woocommerce,
-- commerce_wix, telephony_cloudtalk, telephony_voicenter). Each check is reported on its own, so a FAIL names one fact.
--
--   1 S1 every one of the seven has its policy row (observed = policy rows)
--   2 S2 the emergency switch is OFF for all seven (observed = sources with emergencyDisabled on)
--   3 S3 none of the seven is open globally (observed = sources with globalEnabled on)
--   4 S4 per-business ENABLED overrides for the seven (observed = such rows; informational, PASS when zero)
--   5 S5 per-business DISABLED overrides for the seven (observed = such rows; informational — the closed website
--        pilot of business 9 is expected here; always PASS)
--   6 S6 no non-revoked connection of the seven sources exists (observed = live connections — ACTIVE, PAUSED or ERROR)
--   7 S7 no receipt of the seven sources is unfinished (observed = RECEIVED / PERSISTED / FAILED-with-retry receipts)
--   8 S8 no receipt carries a held:* code (observed = such receipts)
--   9 S9 the evidence role bypasses row-level security, so every count is whole
--
-- Reading: S2 + S6 PASS ⇒ merging #952 changes no intake outcome in Production (no live connection can reach the
-- gate, and the switch is off). OUTPUT: n | result | observed_count. PRIVACY: counts only.
-- Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
fkeys(k) AS (VALUES ('acquisition_web_forms'), ('acquisition_google_lead_forms'), ('acquisition_meta_lead_ads'),
                    ('commerce_woocommerce'), ('commerce_wix'), ('telephony_cloudtalk'), ('telephony_voicenter')),
skeys(k) AS (VALUES ('web.form'), ('google.lead_form'), ('meta.lead_ads'),
                    ('commerce.woocommerce'), ('commerce.wix'), ('telephony.cloudtalk'), ('telephony.voicenter')),
pol AS (SELECT p."featureKey", p."globalEnabled", p."emergencyDisabled" FROM "PlatformFeaturePolicy" p WHERE p."featureKey" IN (SELECT k FROM fkeys)),
ovr AS (SELECT o."state"::text AS state FROM "BusinessFeatureAccess" o WHERE o."featureKey" IN (SELECT k FROM fkeys)),
live AS (SELECT 1 FROM "AcquisitionConnection" c WHERE c."sourceKey" IN (SELECT k FROM skeys) AND c."status" <> 'REVOKED'),
unfinished AS (SELECT 1 FROM "IntakeEvent" e WHERE e."sourceKey" IN (SELECT k FROM skeys)
                 AND (e."status"::text IN ('RECEIVED', 'PERSISTED') OR (e."status"::text = 'FAILED' AND e."nextAttemptAt" IS NOT NULL))),
held AS (SELECT 1 FROM "IntakeEvent" e WHERE e."lastErrorCode" LIKE 'held:%'),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM pol) = 7, (SELECT count(*) FROM pol)
  UNION ALL SELECT 2, (SELECT count(*) FROM pol WHERE "emergencyDisabled") = 0, (SELECT count(*) FROM pol WHERE "emergencyDisabled")
  UNION ALL SELECT 3, (SELECT count(*) FROM pol WHERE "globalEnabled") = 0, (SELECT count(*) FROM pol WHERE "globalEnabled")
  UNION ALL SELECT 4, (SELECT count(*) FROM ovr WHERE state = 'ENABLED') = 0, (SELECT count(*) FROM ovr WHERE state = 'ENABLED')
  UNION ALL SELECT 5, true, (SELECT count(*) FROM ovr WHERE state = 'DISABLED')
  UNION ALL SELECT 6, (SELECT count(*) FROM live) = 0, (SELECT count(*) FROM live)
  UNION ALL SELECT 7, (SELECT count(*) FROM unfinished) = 0, (SELECT count(*) FROM unfinished)
  UNION ALL SELECT 8, (SELECT count(*) FROM held) = 0, (SELECT count(*) FROM held)
  UNION ALL SELECT 9, (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user),
                      (CASE WHEN (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) THEN 1 ELSE 0 END)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
