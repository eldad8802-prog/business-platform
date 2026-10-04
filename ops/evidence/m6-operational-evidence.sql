-- ============================================================================
-- m6-operational-evidence.sql
--
-- Read-only Production evidence for M6 OPERATIONAL closure (after M6 was applied,
-- #630 deployed, and the scheduled intake sweep ran): every acquisition source is
-- OFF and nothing acquisition-related exists in Production.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: counts only; no name, no row content is printed.
-- Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== M6 operational evidence — legend (n → check) =='
\echo ' 1 C1 no AcquisitionConnection row (observed = rows)'
\echo ' 2 C2 no intake receipt from web.form / google.lead_form / meta.lead_ads (observed = receipts)'
\echo ' 3 C3 no Lead whose source channel is an acquisition source (observed = leads)'
\echo ' 4 C4 no learning event naming an acquisition source (observed = events)'
\echo ' 5 F1 the three acquisition features are defined OFF by default and their global policies are OFF (observed = features defined)'
\echo ' 6 F2 no business has a feature-access row for the three acquisition features (observed = rows)'
\echo ' 7 X1 the evidence role bypasses row-level security, so 1-4 and 6 are whole counts'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
feature_keys(k) AS (VALUES ('acquisition_meta_lead_ads'), ('acquisition_google_lead_forms'), ('acquisition_web_forms')),
source_keys(k) AS (VALUES ('web.form'), ('google.lead_form'), ('meta.lead_ads')),
channels(c) AS (VALUES ('intake:web.form'), ('intake:google.lead_form'), ('intake:meta.lead_ads')),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM "AcquisitionConnection") = 0, (SELECT count(*) FROM "AcquisitionConnection")
  UNION ALL SELECT 2, (SELECT count(*) FROM "IntakeEvent" WHERE "sourceKey" IN (SELECT k FROM source_keys)) = 0,
                      (SELECT count(*) FROM "IntakeEvent" WHERE "sourceKey" IN (SELECT k FROM source_keys))
  UNION ALL SELECT 3, (SELECT count(*) FROM "Lead" WHERE "sourceChannel" IN (SELECT c FROM channels)) = 0,
                      (SELECT count(*) FROM "Lead" WHERE "sourceChannel" IN (SELECT c FROM channels))
  UNION ALL SELECT 4, (SELECT count(*) FROM "LearningEvent" WHERE "payload" ->> 'intakeSource' IN (SELECT k FROM source_keys)) = 0,
                      (SELECT count(*) FROM "LearningEvent" WHERE "payload" ->> 'intakeSource' IN (SELECT k FROM source_keys))
  UNION ALL SELECT 5, (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE key IN (SELECT k FROM feature_keys) AND NOT "defaultEnabled") = 3
                      AND (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" IN (SELECT k FROM feature_keys) AND NOT "globalEnabled") = 3,
                      (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE key IN (SELECT k FROM feature_keys))
  UNION ALL SELECT 6, (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" IN (SELECT k FROM feature_keys)) = 0,
                      (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" IN (SELECT k FROM feature_keys))
  UNION ALL SELECT 7, (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user),
                      (CASE WHEN (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) THEN 1 ELSE 0 END)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
