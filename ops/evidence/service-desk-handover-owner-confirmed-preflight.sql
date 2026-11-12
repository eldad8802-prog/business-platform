-- ============================================================================
-- service-desk-handover-owner-confirmed-preflight.sql
--
-- Read-only PREFLIGHT before migration
--   20261125090000_service_desk_handover_owner_confirmed   (NOT applied)
--
-- The migration relaxes two CHECKs of ServiceHandover (expand-only; no authority change): ServiceHandover_signed
-- (signatureCaptured must be true) goes away, and ServiceHandover_receiver is restated so the receiver name is
-- optional (when present: non-blank, at most 200 characters). Nothing else.
--
-- Proves Production is the shape the migration expects:
--   * the ledger is clean; this migration is not recorded; the Service Desk foundation (which made ServiceHandover)
--     is recorded and finished;
--   * ServiceHandover exists; ServiceHandover_signed and ServiceHandover_receiver are exactly the foundation
--     definitions (md5 of the deparsed CHECK), validated; the columns they name exist;
--   * the other constraints of ServiceHandover (keys, foreign keys, the other CHECKs) are the pinned set — the
--     evidence file proves the same set afterwards;
--   * the four ServiceHandover triggers are the pinned set, all enabled; RLS enabled + forced, the two tenant policies;
--     app_runtime holds exactly ar, nobody else holds anything;
--   * existing data: no row breaks the new receiver CHECK;
--   * informational: whether 20261123090000 (#1061, the release order puts it first) and 20261124090000 (#1131) are
--     recorded — the migration needs neither (it touches no function); rows in ServiceHandover; finished migrations
--     sorting after this one; finished total.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== service desk handover owner-confirmed preflight: legend (n -> check) =='
\echo ' 1 ledger: no unfinished and no rolled-back row'
\echo ' 2 20261125090000_service_desk_handover_owner_confirmed is NOT recorded'
\echo ' 3 the foundation 20261112090000_service_desk_foundation is recorded and finished'
\echo ' 4 the table ServiceHandover exists'
\echo ' 5 ServiceHandover_signed: the foundation CHECK (signatureCaptured), validated'
\echo ' 6 ServiceHandover_receiver: the foundation CHECK (name required unless erased), validated'
\echo ' 7 columns receivedByName (text, nullable), signatureCaptured (boolean), erasedAt present (expected 3)'
\echo ' 8 the other ServiceHandover constraints are the pinned set (keys, foreign keys, three CHECKs)'
\echo ' 9 the ServiceHandover triggers are the pinned set of four, all enabled'
\echo '10 RLS enabled and forced on ServiceHandover, with its two tenant policies'
\echo '11 app_runtime holds exactly ar on ServiceHandover'
\echo '12 any other non-owner role holding anything on ServiceHandover (expected 0)'
\echo '13 rows the new receiver CHECK would refuse (expected 0)'
\echo '14 20261123090000_service_desk_ui_erasure_text recorded (informational: release order, not needed by this migration)'
\echo '15 20261124090000_service_user_same_business_fix recorded (informational: not needed by this migration)'
\echo '16 rows in ServiceHandover (informational)'
\echo '17 finished migrations sorting after 20261125090000 (informational)'
\echo '18 finished migrations in the ledger (informational)'

WITH h AS (
  SELECT k.oid, k.relowner, k.relacl, k.relrowsecurity, k.relforcerowsecurity FROM pg_class k
   WHERE k.relnamespace = 'public'::regnamespace AND k.relkind = 'r' AND k.relname = 'ServiceHandover'
), con AS (
  SELECT k.conname, k.contype, k.convalidated, pg_get_constraintdef(k.oid) AS def
    FROM pg_constraint k JOIN h ON h.oid = k.conrelid WHERE k.contype IN ('c', 'f', 'p', 'u', 'x')
), trg AS (
  SELECT g.tgname, g.tgtype, g.tgenabled, p.proname FROM pg_trigger g JOIN h ON h.oid = g.tgrelid JOIN pg_proc p ON p.oid = g.tgfoid
   WHERE NOT g.tgisinternal
), c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) AS observed, 0 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261125090000_service_desk_handover_owner_confirmed'), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261112090000_service_desk_foundation'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL), 1
  UNION ALL SELECT 4, (SELECT count(*) FROM h), 1
  UNION ALL SELECT 5, (SELECT count(*) FROM con WHERE con.conname = 'ServiceHandover_signed' AND con.contype = 'c' AND con.convalidated
                          AND md5(con.def) = 'e84bb2c67cf7f9cee3fddb9e6a288472'), 1
  UNION ALL SELECT 6, (SELECT count(*) FROM con WHERE con.conname = 'ServiceHandover_receiver' AND con.contype = 'c' AND con.convalidated
                          AND md5(con.def) = '6c7041cd7519be0b07221448619e34c9'), 1
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_attribute a JOIN h ON h.oid = a.attrelid WHERE NOT a.attisdropped AND a.attnum > 0
                          AND ((a.attname = 'receivedByName' AND a.atttypid = 'text'::regtype AND NOT a.attnotnull)
                            OR (a.attname = 'signatureCaptured' AND a.atttypid = 'boolean'::regtype)
                            OR a.attname = 'erasedAt')), 3
  UNION ALL SELECT 8, (SELECT count(*) FROM (SELECT md5(string_agg(con.conname || ':' || con.contype::text || ':' || con.convalidated::text || ':' || con.def,
                                                                   '|' ORDER BY con.conname)) AS m
                                               FROM con WHERE con.conname NOT IN ('ServiceHandover_signed', 'ServiceHandover_receiver')) z
                        WHERE z.m = '6e6748a295b9f2b461ceda5bc6ff1c77'), 1
  UNION ALL SELECT 9, (SELECT count(*) FROM (SELECT md5(string_agg(trg.tgname || ':' || trg.tgtype::text || ':' || trg.tgenabled::text || ':' || trg.proname,
                                                                   '|' ORDER BY trg.tgname)) AS m FROM trg) z
                        WHERE z.m = '8027f492aa8e9e3b73ccb3fdc57db83d'), 1
  UNION ALL SELECT 10, (SELECT count(*) FROM h WHERE h.relrowsecurity AND h.relforcerowsecurity
                           AND (SELECT count(*) FROM pg_policy y WHERE y.polrelid = h.oid
                                  AND ((y.polname = 'service_handover_tenant_insert' AND y.polcmd = 'a')
                                    OR (y.polname = 'service_handover_tenant_select' AND y.polcmd = 'r'))) = 2
                           AND (SELECT count(*) FROM pg_policy y WHERE y.polrelid = h.oid) = 2), 1
  UNION ALL SELECT 11, (SELECT count(*) FROM h WHERE h.relacl::text LIKE '%app_runtime=ar/%'), 1
  UNION ALL SELECT 12, (SELECT count(*) FROM h CROSS JOIN LATERAL aclexplode(h.relacl) x
                         WHERE x.grantee <> h.relowner AND x.grantee <> 'app_runtime'::regrole), 0
  UNION ALL SELECT 13, (SELECT count(*) FROM "ServiceHandover" s
                         WHERE s."receivedByName" IS NOT NULL AND (btrim(s."receivedByName") = '' OR char_length(s."receivedByName") > 200)), 0
  UNION ALL SELECT 14, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261123090000_service_desk_ui_erasure_text'
                           AND finished_at IS NOT NULL AND rolled_back_at IS NULL), NULL
  UNION ALL SELECT 15, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261124090000_service_user_same_business_fix'
                           AND finished_at IS NOT NULL AND rolled_back_at IS NULL), NULL
  UNION ALL SELECT 16, (SELECT count(*) FROM "ServiceHandover"), NULL
  UNION ALL SELECT 17, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name > '20261125090000_service_desk_handover_owner_confirmed' AND finished_at IS NOT NULL), NULL
  UNION ALL SELECT 18, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL), NULL
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
