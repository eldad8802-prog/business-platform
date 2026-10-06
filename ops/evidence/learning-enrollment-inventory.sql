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
-- OUTPUT: n | item | value (ids are business ids; no names, no content).
-- Guard-clean: no write keyword anywhere.
-- ============================================================================

\echo '== Learning enrollment inventory (knowledge_derivation) =='

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';

WITH
feat AS (SELECT 'knowledge_derivation'::text AS k),
biz AS (SELECT b.id, b."createdAt", (b."deletionRequestedAt" IS NULL AND b."deletedAt" IS NULL) AS active FROM "Business" b),
rows_ AS (SELECT a."businessId", a.state::text AS state, a.reason, a."updatedByUserId", a."createdAt", a."updatedAt"
          FROM "BusinessFeatureAccess" a WHERE a."featureKey" = (SELECT k FROM feat)),
audit AS (SELECT e."targetId", e.metadata->>'oldState' AS old_state, e.metadata->>'newState' AS new_state,
                 e."actorUserId", e."createdAt"
          FROM "PlatformAuditEvent" e
          WHERE e.action = 'PLATFORM_FEATURE_ACCESS_UPDATED'
            AND e.metadata->>'featureKey' = (SELECT k FROM feat)),
runs AS (SELECT r."businessId", count(*) AS n, max(r."startedAt") AS last_run,
                count(*) FILTER (WHERE r.status = 'SUCCEEDED') AS ok_runs
         FROM "KnowledgeDerivationRun" r GROUP BY r."businessId"),
no_row AS (SELECT b.id, b.active FROM biz b WHERE NOT EXISTS (SELECT 1 FROM rows_ r WHERE r."businessId" = b.id)),
lines(n, item, value) AS (
            SELECT 1, 'businesses total', (SELECT count(*)::text FROM biz)
  UNION ALL SELECT 2, 'businesses active (no deletion requested)', (SELECT count(*)::text FROM biz WHERE active)
  UNION ALL SELECT 3, 'businesses in deletion (requested or done)', (SELECT count(*)::text FROM biz WHERE NOT active)
  UNION ALL SELECT 4, 'businesses created in the last 30 days', (SELECT count(*)::text FROM biz WHERE "createdAt" > now() - interval '30 days')
  UNION ALL SELECT 5, 'definition row: defaultEnabled (DB)',
                      coalesce((SELECT d."defaultEnabled"::text FROM "PlatformFeatureDefinition" d WHERE d.key = (SELECT k FROM feat)), 'no row')
  UNION ALL SELECT 6, 'policy row: globalEnabled / emergencyDisabled',
                      coalesce((SELECT p."globalEnabled"::text || ' / ' || p."emergencyDisabled"::text
                                FROM "PlatformFeaturePolicy" p WHERE p."featureKey" = (SELECT k FROM feat)), 'no row')
  UNION ALL SELECT 7, 'ENABLED rows (business ids)',
                      coalesce((SELECT string_agg("businessId"::text, ',' ORDER BY "businessId") FROM rows_ WHERE state = 'ENABLED'), '(none)')
  UNION ALL SELECT 8, 'DISABLED rows (business ids)',
                      coalesce((SELECT string_agg("businessId"::text, ',' ORDER BY "businessId") FROM rows_ WHERE state = 'DISABLED'), '(none)')
  UNION ALL SELECT 9, 'INHERIT rows (business ids)',
                      coalesce((SELECT string_agg("businessId"::text, ',' ORDER BY "businessId") FROM rows_ WHERE state = 'INHERIT'), '(none)')
  UNION ALL SELECT 10, 'rows carrying an actor AND a reason / all rows',
                       (SELECT count(*) FILTER (WHERE "updatedByUserId" IS NOT NULL AND reason IS NOT NULL)::text || ' / ' || count(*)::text FROM rows_)
  UNION ALL SELECT 11, 'businesses with NO row (active / all)',
                       (SELECT count(*) FILTER (WHERE active)::text || ' / ' || count(*)::text FROM no_row)
  UNION ALL SELECT 12, 'audit events for this feature (total)', (SELECT count(*)::text FROM audit)
  UNION ALL SELECT 13, 'audit transitions (business:old->new)',
                       coalesce((SELECT string_agg("targetId" || ':' || coalesce(old_state, '-') || '->' || coalesce(new_state, '-'), ',' ORDER BY "createdAt") FROM audit), '(none)')
  UNION ALL SELECT 14, 'DISABLED rows backed by an audit event setting DISABLED',
                       (SELECT count(*)::text FROM rows_ r WHERE r.state = 'DISABLED'
                          AND EXISTS (SELECT 1 FROM audit a WHERE a."targetId" = r."businessId"::text AND a.new_state = 'DISABLED'))
  UNION ALL SELECT 15, 'rows with NO audit event at all (seeded outside the admin path)',
                       coalesce((SELECT string_agg(r."businessId"::text || ':' || r.state, ',' ORDER BY r."businessId") FROM rows_ r
                                 WHERE NOT EXISTS (SELECT 1 FROM audit a WHERE a."targetId" = r."businessId"::text)), '(none)')
  UNION ALL SELECT 16, 'derivation runs per business (id:runs/succeeded)',
                       coalesce((SELECT string_agg("businessId"::text || ':' || n::text || '/' || ok_runs::text, ',' ORDER BY "businessId") FROM runs), '(none)')
  UNION ALL SELECT 17, 'last derivation run (any business)', coalesce((SELECT max(last_run)::text FROM runs), '(never)')
  UNION ALL SELECT 18, 'a default flip would newly enrol: active businesses with no row or INHERIT (count)',
                       (SELECT count(*)::text FROM biz b WHERE b.active
                          AND NOT EXISTS (SELECT 1 FROM rows_ r WHERE r."businessId" = b.id AND r.state IN ('ENABLED', 'DISABLED')))
  UNION ALL SELECT 19, '...those business ids',
                       coalesce((SELECT string_agg(b.id::text, ',' ORDER BY b.id) FROM biz b WHERE b.active
                                 AND NOT EXISTS (SELECT 1 FROM rows_ r WHERE r."businessId" = b.id AND r.state IN ('ENABLED', 'DISABLED'))), '(none)')
)
SELECT n, item, value FROM lines ORDER BY n;

ROLLBACK;
