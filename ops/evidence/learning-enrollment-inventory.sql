-- ============================================================================
-- learning-enrollment-inventory.sql
--
-- Read-only inventory BEFORE any change to Business Learning enrollment
-- (feature key knowledge_derivation). The owner's rule to be designed:
--     new business  → enrolled by default
--     explicit DISABLED → always wins
--     existing businesses → not silently re-authorised
--
-- Questions it answers, from the catalog of rows only (no business content):
--   * how many businesses exist, and how many are active vs in deletion;
--   * the global policy row (globalEnabled / emergencyDisabled) and the DB
--     definition's defaultEnabled for knowledge_derivation;
--   * which businesses hold an explicit ENABLED / DISABLED / INHERIT row, with
--     whether the row carries an actor and a reason;
--   * which businesses have NO row at all (enrolled-by-absence would change);
--   * the audit trail of every change to this feature (PlatformAuditEvent
--     PLATFORM_FEATURE_ACCESS_UPDATED), so an explicit opt-out can be told
--     apart from a legacy absence;
--   * derivation runs per business (has learning ever run for it);
--   * what a default flip would change: the businesses that resolve to "not
--     allowed" today only because of the default.
--
-- OUTPUT: n | flag | observed_count — booleans and counts only, so it survives
-- scripts/ci/evidence-redact.mjs (ids never reach the public log); an echo
-- legend names each row. Set checks ("exactly {3,9}") stand in for id lists.
-- Guard-clean: no write keyword anywhere.
-- ============================================================================

\echo '== Learning enrollment inventory (knowledge_derivation) — legend =='
\echo ' 1 businesses total (count)'
\echo ' 2 businesses active, no deletion requested (count)'
\echo ' 3 businesses in deletion, requested or done (count)'
\echo ' 4 businesses created in the last 30 days (count)'
\echo ' 5 DB definition defaultEnabled (flag; null = no row)'
\echo ' 6 policy globalEnabled (flag; null = no row)'
\echo ' 7 policy emergencyDisabled (flag; null = no row)'
\echo ' 8 ENABLED rows (count)'
\echo ' 9 the ENABLED set is exactly businesses {3, 9} (flag)'
\echo '10 DISABLED rows (count)'
\echo '11 INHERIT rows (count)'
\echo '12 the INHERIT set is exactly business {38} (flag)'
\echo '13 rows carrying BOTH an actor and a reason (count) of all rows (row 14)'
\echo '14 rows for this feature, any state (count)'
\echo '15 ACTIVE businesses with no row at all (count)'
\echo '16 audit events PLATFORM_FEATURE_ACCESS_UPDATED for this feature (count)'
\echo '17 ...of which set ENABLED (count)'
\echo '18 ...of which set DISABLED (count)'
\echo '19 ...of which set INHERIT (count)'
\echo '20 DISABLED rows backed by an audit event that set DISABLED (count)'
\echo '21 rows with NO audit event at all, i.e. seeded outside the admin path (count)'
\echo '22 businesses with at least one derivation run (count)'
\echo '23 derivation runs SUCCEEDED, all businesses (count)'
\echo '24 only businesses {3, 9} have ever had a derivation run (flag)'
\echo '25 a default flip would newly enrol: ACTIVE businesses with no row or INHERIT (count)'
\echo '26 ...of which created in the last 30 days (count)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';

WITH
feat AS (SELECT 'knowledge_derivation'::text AS k),
biz AS (SELECT b.id, b."createdAt", (b."deletionRequestedAt" IS NULL AND b."deletedAt" IS NULL) AS active FROM "Business" b),
rows_ AS (SELECT a."businessId", a.state::text AS state, a.reason, a."updatedByUserId"
          FROM "BusinessFeatureAccess" a WHERE a."featureKey" = (SELECT k FROM feat)),
audit AS (SELECT e."targetId", e.metadata->>'newState' AS new_state
          FROM "PlatformAuditEvent" e
          WHERE e.action = 'PLATFORM_FEATURE_ACCESS_UPDATED'
            AND e.metadata->>'featureKey' = (SELECT k FROM feat)),
runs AS (SELECT r."businessId", count(*) FILTER (WHERE r.status = 'SUCCEEDED') AS ok_runs
         FROM "KnowledgeDerivationRun" r GROUP BY r."businessId"),
flip AS (SELECT b.id, b."createdAt" FROM biz b WHERE b.active
         AND NOT EXISTS (SELECT 1 FROM rows_ r WHERE r."businessId" = b.id AND r.state IN ('ENABLED', 'DISABLED'))),
lines(n, flag, observed_count) AS (
            SELECT 1, NULL::boolean, (SELECT count(*) FROM biz)
  UNION ALL SELECT 2, NULL, (SELECT count(*) FROM biz WHERE active)
  UNION ALL SELECT 3, NULL, (SELECT count(*) FROM biz WHERE NOT active)
  UNION ALL SELECT 4, NULL, (SELECT count(*) FROM biz WHERE "createdAt" > now() - interval '30 days')
  UNION ALL SELECT 5, (SELECT d."defaultEnabled" FROM "PlatformFeatureDefinition" d WHERE d.key = (SELECT k FROM feat)), NULL
  UNION ALL SELECT 6, (SELECT p."globalEnabled" FROM "PlatformFeaturePolicy" p WHERE p."featureKey" = (SELECT k FROM feat)), NULL
  UNION ALL SELECT 7, (SELECT p."emergencyDisabled" FROM "PlatformFeaturePolicy" p WHERE p."featureKey" = (SELECT k FROM feat)), NULL
  UNION ALL SELECT 8, NULL, (SELECT count(*) FROM rows_ WHERE state = 'ENABLED')
  UNION ALL SELECT 9, (SELECT coalesce(array_agg("businessId" ORDER BY "businessId"), '{}') = ARRAY[3, 9] FROM rows_ WHERE state = 'ENABLED'), NULL
  UNION ALL SELECT 10, NULL, (SELECT count(*) FROM rows_ WHERE state = 'DISABLED')
  UNION ALL SELECT 11, NULL, (SELECT count(*) FROM rows_ WHERE state = 'INHERIT')
  UNION ALL SELECT 12, (SELECT coalesce(array_agg("businessId" ORDER BY "businessId"), '{}') = ARRAY[38] FROM rows_ WHERE state = 'INHERIT'), NULL
  UNION ALL SELECT 13, NULL, (SELECT count(*) FROM rows_ WHERE "updatedByUserId" IS NOT NULL AND reason IS NOT NULL)
  UNION ALL SELECT 14, NULL, (SELECT count(*) FROM rows_)
  UNION ALL SELECT 15, NULL, (SELECT count(*) FROM biz b WHERE b.active AND NOT EXISTS (SELECT 1 FROM rows_ r WHERE r."businessId" = b.id))
  UNION ALL SELECT 16, NULL, (SELECT count(*) FROM audit)
  UNION ALL SELECT 17, NULL, (SELECT count(*) FROM audit WHERE new_state = 'ENABLED')
  UNION ALL SELECT 18, NULL, (SELECT count(*) FROM audit WHERE new_state = 'DISABLED')
  UNION ALL SELECT 19, NULL, (SELECT count(*) FROM audit WHERE new_state = 'INHERIT')
  UNION ALL SELECT 20, NULL, (SELECT count(*) FROM rows_ r WHERE r.state = 'DISABLED'
                                AND EXISTS (SELECT 1 FROM audit a WHERE a."targetId" = r."businessId"::text AND a.new_state = 'DISABLED'))
  UNION ALL SELECT 21, NULL, (SELECT count(*) FROM rows_ r WHERE NOT EXISTS (SELECT 1 FROM audit a WHERE a."targetId" = r."businessId"::text))
  UNION ALL SELECT 22, NULL, (SELECT count(*) FROM runs)
  UNION ALL SELECT 23, NULL, (SELECT coalesce(sum(ok_runs), 0) FROM runs)
  UNION ALL SELECT 24, (SELECT coalesce(array_agg("businessId" ORDER BY "businessId"), '{}') <@ ARRAY[3, 9] FROM runs), NULL
  UNION ALL SELECT 25, NULL, (SELECT count(*) FROM flip)
  UNION ALL SELECT 26, NULL, (SELECT count(*) FROM flip WHERE "createdAt" > now() - interval '30 days')
)
SELECT n, flag, observed_count FROM lines ORDER BY n;

ROLLBACK;
