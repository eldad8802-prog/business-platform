-- ============================================================================
-- service-desk-handover-owner-confirmed-production-evidence.sql
--
-- Read-only EVIDENCE after migration 20261125090000_service_desk_handover_owner_confirmed was applied.
--
-- The migration relaxed two CHECKs of ServiceHandover (expand-only; no authority change): ServiceHandover_signed is
-- gone, ServiceHandover_receiver now reads "receiver name absent, or non-blank and at most 200 characters".
--
-- Proves:
--   * the migration is recorded once, finished, not rolled back, with the reviewed file's checksum; the ledger is clean;
--   * ServiceHandover_signed no longer exists; ServiceHandover_receiver is exactly the new definition (md5 of the
--     deparsed CHECK), validated (every existing row satisfies it);
--   * the columns stay: receivedByName (text, nullable), signatureCaptured (boolean, kept as history), erasedAt;
--   * nothing else moved: the other ServiceHandover constraints are the same pinned set as in the preflight; the four
--     triggers are the same pinned set, all enabled; RLS enabled + forced with the same two tenant policies;
--     app_runtime holds exactly ar, nobody else holds anything;
--   * informational: rows in ServiceHandover, rows without a receiver name, rows without a captured signature (both
--     possible only from now on).
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== service desk handover owner-confirmed evidence: legend (n -> check) =='
\echo ' 1 20261125090000_service_desk_handover_owner_confirmed is recorded once, finished, not rolled back'
\echo ' 2 ledger: no unfinished and no rolled-back row'
\echo ' 3 the ledger checksum is the reviewed migration file'
\echo ' 4 ServiceHandover_signed exists (expected 0)'
\echo ' 5 ServiceHandover_receiver: the new CHECK (name optional; non-blank, at most 200), validated'
\echo ' 6 columns receivedByName (text, nullable), signatureCaptured (boolean), erasedAt present (expected 3)'
\echo ' 7 the other ServiceHandover constraints are the pinned set (unchanged since the preflight)'
\echo ' 8 the ServiceHandover triggers are the pinned set of four, all enabled (unchanged)'
\echo ' 9 RLS enabled and forced on ServiceHandover, with its two tenant policies (unchanged)'
\echo '10 app_runtime holds exactly ar on ServiceHandover (unchanged)'
\echo '11 any other non-owner role holding anything on ServiceHandover (expected 0)'
\echo '12 rows the new receiver CHECK would refuse (expected 0)'
\echo '13 rows in ServiceHandover (informational)'
\echo '14 rows without a receiver name (informational)'
\echo '15 rows without a captured signature (informational)'

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
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261125090000_service_desk_handover_owner_confirmed'
                     AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS observed, 1 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261125090000_service_desk_handover_owner_confirmed'
                          AND checksum = '1d5e93bd5afea33dac70729c06bca50cc19be1d3c5e96225192b41cafbb5c91b'), 1
  UNION ALL SELECT 4, (SELECT count(*) FROM con WHERE con.conname = 'ServiceHandover_signed'), 0
  UNION ALL SELECT 5, (SELECT count(*) FROM con WHERE con.conname = 'ServiceHandover_receiver' AND con.contype = 'c' AND con.convalidated
                          AND md5(con.def) = 'c0e0e4019d1332ca874a7cefa556dd90'), 1
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_attribute a JOIN h ON h.oid = a.attrelid WHERE NOT a.attisdropped AND a.attnum > 0
                          AND ((a.attname = 'receivedByName' AND a.atttypid = 'text'::regtype AND NOT a.attnotnull)
                            OR (a.attname = 'signatureCaptured' AND a.atttypid = 'boolean'::regtype)
                            OR a.attname = 'erasedAt')), 3
  UNION ALL SELECT 7, (SELECT count(*) FROM (SELECT md5(string_agg(con.conname || ':' || con.contype::text || ':' || con.convalidated::text || ':' || con.def,
                                                                   '|' ORDER BY con.conname)) AS m
                                               FROM con WHERE con.conname NOT IN ('ServiceHandover_signed', 'ServiceHandover_receiver')) z
                        WHERE z.m = '6e6748a295b9f2b461ceda5bc6ff1c77'), 1
  UNION ALL SELECT 8, (SELECT count(*) FROM (SELECT md5(string_agg(trg.tgname || ':' || trg.tgtype::text || ':' || trg.tgenabled::text || ':' || trg.proname,
                                                                   '|' ORDER BY trg.tgname)) AS m FROM trg) z
                        WHERE z.m = '8027f492aa8e9e3b73ccb3fdc57db83d'), 1
  UNION ALL SELECT 9, (SELECT count(*) FROM h WHERE h.relrowsecurity AND h.relforcerowsecurity
                          AND (SELECT count(*) FROM pg_policy y WHERE y.polrelid = h.oid
                                 AND ((y.polname = 'service_handover_tenant_insert' AND y.polcmd = 'a')
                                   OR (y.polname = 'service_handover_tenant_select' AND y.polcmd = 'r'))) = 2
                          AND (SELECT count(*) FROM pg_policy y WHERE y.polrelid = h.oid) = 2), 1
  UNION ALL SELECT 10, (SELECT count(*) FROM h WHERE h.relacl::text LIKE '%app_runtime=ar/%'), 1
  UNION ALL SELECT 11, (SELECT count(*) FROM h CROSS JOIN LATERAL aclexplode(h.relacl) x
                         WHERE x.grantee <> h.relowner AND x.grantee <> 'app_runtime'::regrole), 0
  UNION ALL SELECT 12, (SELECT count(*) FROM "ServiceHandover" s
                         WHERE s."receivedByName" IS NOT NULL AND (btrim(s."receivedByName") = '' OR char_length(s."receivedByName") > 200)), 0
  UNION ALL SELECT 13, (SELECT count(*) FROM "ServiceHandover"), NULL
  UNION ALL SELECT 14, (SELECT count(*) FROM "ServiceHandover" s WHERE s."receivedByName" IS NULL), NULL
  UNION ALL SELECT 15, (SELECT count(*) FROM "ServiceHandover" s WHERE NOT s."signatureCaptured"), NULL
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
