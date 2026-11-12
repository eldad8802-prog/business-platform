-- Service Desk, owner decision 2026-11-11 (no customer signature): aggregate counts only.
-- Run only through .github/workflows/prod-readonly-evidence.yml (production-db approval, SELECT-only guard,
-- read-only session). No personal data, no signature bytes, no document text: every query returns counts.
SET default_transaction_read_only = on;

-- Q1. Intake rows, and how many carry a customer signature written before the decision.
SELECT count(*) AS intakes,
       count(*) FILTER (WHERE "customerSigned") AS signed,
       count(*) FILTER (WHERE "signatureKey" IS NOT NULL) AS with_signature_key
  FROM "ServiceCaseIntake";

-- Q2. Terms snapshots presented to a customer (expected 0: no approved texts exist).
SELECT count(*) AS terms_snapshots FROM "ServiceIntakeTermsSnapshot";

-- Q3. Service text versions by legal status (expected: none LEGALLY_APPROVED).
SELECT "legalStatus"::text AS legal_status, count(*) AS versions FROM "ServiceTextVersion" GROUP BY 1 ORDER BY 1;

-- Q4. Handovers, and how many were recorded as signed (expected 0: DELIVER is out of scope).
SELECT count(*) AS handovers, count(*) FILTER (WHERE "signatureCaptured") AS signed FROM "ServiceHandover";

-- Q5. Service cases by kind and status.
SELECT kind::text AS kind, status::text AS status, count(*) AS cases FROM "ServiceCase" GROUP BY 1, 2 ORDER BY 1, 2;

-- Q6. Intake photos.
SELECT count(*) AS intake_photos FROM "ServiceIntakePhoto";

-- Q7. The service_desk flag: the platform policy and the number of business overrides by state (no business ids).
SELECT d.key, d."defaultEnabled" AS default_enabled, p."globalEnabled" AS global_enabled, p."emergencyDisabled" AS emergency_disabled
  FROM "PlatformFeatureDefinition" d LEFT JOIN "PlatformFeaturePolicy" p ON p."featureKey" = d.key
 WHERE d.key = 'service_desk';
SELECT state::text AS state, count(*) AS businesses FROM "BusinessFeatureAccess" WHERE "featureKey" = 'service_desk' GROUP BY 1 ORDER BY 1;
