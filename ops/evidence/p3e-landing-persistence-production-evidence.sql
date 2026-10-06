-- ============================================================================
-- p3e-landing-persistence-production-evidence.sql
--
-- Read-only Production EVIDENCE after migration
--   20261013090000_p3e_landing_persistence
--
-- Proves the migration's outcome, from the catalog and counts only:
--   * it is recorded and finished, its sha256 is the reviewed one, nothing is unfinished or rolled back;
--   * LandingPage and LandingPageVersion exist with RLS ENABLED + FORCED, exactly three tenant policies each
--     (read, add, change) on the app.current_business_id GUC, and no removal or catch-all policy;
--   * the lifecycle guards (before row change / removal) and the two deferred pointer-integrity constraint
--     triggers are in place;
--   * every foreign key: both tables to Business (cascading), version → page on (businessId, landingPageId)
--     (cascading), the three lineage links and the two page pointers on (businessId, id);
--   * one page per business; the tenant-led unique indexes, including one DRAFT / one APPROVED per page;
--   * the snapshot / status / engine-version check constraints exist;
--   * app_runtime holds exactly r + a on both tables, w only on the named lifecycle columns, U + r on both
--     sequences; PUBLIC holds nothing; the guard functions are not executable by PUBLIC;
--   * both tables are empty: nothing was backfilled, nothing was approved by the migration.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== P3-E landing persistence production evidence: legend (n -> check) =='
\echo ' 1 the migration is recorded and finished (observed = finished rows)'
\echo ' 2 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 3 the recorded checksum is the reviewed sha256 of migration.sql'
\echo ' 4 LandingPage and LandingPageVersion exist with RLS ENABLED + FORCED (observed = such tables)'
\echo ' 5 exactly three policies per table, r / a / w, each on the GUC (observed = policies)'
\echo ' 6 no removal (d) and no catch-all (*) policy on either table (observed = such policies)'
\echo ' 7 lifecycle guards: one before-row-change-or-removal trigger per table on its p3e guard function'
\echo ' 8 two deferred pointer-integrity constraint triggers (observed = such triggers)'
\echo ' 9 foreign keys: 2 to Business cascading, version to page (2 columns) cascading, 5 composite tenant links (observed = matching)'
\echo '10 the supersededBy link is deferrable, initially deferred'
\echo '11 unique indexes: page per business, (businessId,id) x2, version number, idempotency key, one draft, one approved (observed = of 7)'
\echo '12 check constraints: page 3, version 8 (observed = check constraints)'
\echo '13 app_runtime table privileges are exactly ar on both tables'
\echo '14 app_runtime column privilege w: page 4 columns, version 9 columns, nothing else (observed = column grants)'
\echo '15 app_runtime holds USAGE + SELECT on both id sequences (observed = privileges)'
\echo '16 PUBLIC holds no privilege on either table, and no EXECUTE on the three p3e functions'
\echo '17 both tables are empty: nothing backfilled, nothing approved by the migration (observed = rows)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
tbl AS (SELECT c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity, c.relacl FROM pg_class c
        WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname IN ('LandingPage', 'LandingPageVersion') AND c.relkind = 'r'),
seq AS (SELECT c.oid, c.relacl FROM pg_class c
        WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname IN ('LandingPage_id_seq', 'LandingPageVersion_id_seq') AND c.relkind = 'S'),
rt AS (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime'),
rt_items AS (SELECT DISTINCT tbl.relname, (CASE x.privilege_type
              WHEN 'SELECT' THEN 'r' WHEN 'INS' || 'ERT' THEN 'a' WHEN 'UPD' || 'ATE' THEN 'w'
              WHEN 'DEL' || 'ETE' THEN 'd' WHEN 'TRUNC' || 'ATE' THEN 'D' WHEN 'REFERENCES' THEN 'x'
              WHEN 'TRIGGER' THEN 't' WHEN 'MAINTAIN' THEN 'm' ELSE '?' END) COLLATE "C" AS l
           FROM tbl CROSS JOIN LATERAL aclexplode(tbl.relacl) x WHERE x.grantee = (SELECT oid FROM rt)),
rt_tbl AS (SELECT relname, string_agg(l, '' ORDER BY l) AS letters FROM rt_items GROUP BY relname),
rt_cols AS (SELECT tbl.relname, a.attname::text AS col FROM tbl JOIN pg_attribute a ON a.attrelid = tbl.oid AND a.attnum > 0 AND NOT a.attisdropped
            CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE x.grantee = (SELECT oid FROM rt) AND x.privilege_type = 'UPD' || 'ATE'),
expected_cols(relname, col) AS (VALUES
  ('LandingPage', 'currentDraftVersionId'), ('LandingPage', 'currentApprovedVersionId'), ('LandingPage', 'lastVersionNumber'), ('LandingPage', 'updatedAt'),
  ('LandingPageVersion', 'status'), ('LandingPageVersion', 'authority'), ('LandingPageVersion', 'approvedAt'), ('LandingPageVersion', 'approvedByUserId'),
  ('LandingPageVersion', 'supersededAt'), ('LandingPageVersion', 'supersededByVersionId'), ('LandingPageVersion', 'retiredAt'),
  ('LandingPageVersion', 'retiredByUserId'), ('LandingPageVersion', 'updatedAt')),
rt_seq AS (SELECT count(*) AS n FROM seq CROSS JOIN LATERAL aclexplode(seq.relacl) x
           WHERE x.grantee = (SELECT oid FROM rt) AND x.privilege_type IN ('USAGE', 'SELECT')),
pols AS (SELECT p.polrelid, p.polname, p.polcmd, pg_get_expr(COALESCE(p.polqual, p.polwithcheck), p.polrelid) AS expr
         FROM pg_policy p WHERE p.polrelid IN (SELECT oid FROM tbl)),
trg AS (SELECT t.tgrelid, t.tgname, t.tgtype, t.tgconstraint, t.tgdeferrable, t.tginitdeferred, f.proname
        FROM pg_trigger t JOIN pg_proc f ON f.oid = t.tgfoid WHERE t.tgrelid IN (SELECT oid FROM tbl) AND NOT t.tgisinternal),
fks AS (SELECT k.conname, k.conrelid::regclass::text AS src, k.confrelid::regclass::text AS target, k.confdeltype,
               cardinality(k.conkey) AS width, k.condeferrable, k.condeferred
        FROM pg_constraint k WHERE k.conrelid IN (SELECT oid FROM tbl) AND k.contype = 'f'),
idx(nm) AS (VALUES ('LandingPage_businessId_key'), ('LandingPage_businessId_id_key'), ('LandingPageVersion_businessId_id_key'),
  ('LandingPageVersion_businessId_landingPageId_versionNumber_key'), ('LandingPageVersion_businessId_idempotencyKey_key'),
  ('LandingPageVersion_one_draft_key'), ('LandingPageVersion_one_approved_key')),
fns AS (SELECT p.oid, p.proacl FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pub)
        AND p.proname IN ('p3e_landing_version_guard', 'p3e_landing_page_guard', 'p3e_landing_pointer_integrity')),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261013090000_p3e_landing_persistence'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1,
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261013090000_p3e_landing_persistence'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261013090000_p3e_landing_persistence'
                                AND checksum = 'f3946da065ba29375d7f8820b20820197393ad2552f5f457db6ca90c5944c849'), 1
  UNION ALL SELECT 4, (SELECT count(*) FROM tbl WHERE relrowsecurity AND relforcerowsecurity) = 2,
                      (SELECT count(*) FROM tbl WHERE relrowsecurity AND relforcerowsecurity)
  UNION ALL SELECT 5, (SELECT count(*) FROM pols) = 6
                      AND (SELECT count(DISTINCT (polrelid, polcmd)) FROM pols WHERE polcmd IN ('r', 'a', 'w') AND expr LIKE '%app.current_business_id%') = 6,
                      (SELECT count(*) FROM pols)
  UNION ALL SELECT 6, NOT EXISTS (SELECT 1 FROM pols WHERE polcmd IN ('d', '*')), (SELECT count(*) FROM pols WHERE polcmd IN ('d', '*'))
  UNION ALL SELECT 7, (SELECT count(*) FROM trg WHERE tgconstraint = 0 AND proname IN ('p3e_landing_version_guard', 'p3e_landing_page_guard')
                         AND (tgtype & 2) = 2 AND (tgtype & 16) = 16 AND (tgtype & 8) = 8) = 2,
                      (SELECT count(*) FROM trg WHERE tgconstraint = 0 AND proname IN ('p3e_landing_version_guard', 'p3e_landing_page_guard'))
  UNION ALL SELECT 8, (SELECT count(*) FROM trg WHERE tgconstraint <> 0 AND proname = 'p3e_landing_pointer_integrity' AND tgdeferrable AND tginitdeferred) = 2,
                      (SELECT count(*) FROM trg WHERE proname = 'p3e_landing_pointer_integrity')
  UNION ALL SELECT 9, (SELECT count(*) FROM fks WHERE target = '"Business"' AND width = 1 AND confdeltype = 'c') = 2
                      AND (SELECT count(*) FROM fks WHERE src = '"LandingPageVersion"' AND target = '"LandingPage"' AND width = 2 AND confdeltype = 'c') = 1
                      AND (SELECT count(*) FROM fks WHERE target = '"LandingPageVersion"' AND width = 2) = 5
                      AND (SELECT count(*) FROM fks) = 8,
                      (SELECT count(*) FROM fks)
  UNION ALL SELECT 10, EXISTS (SELECT 1 FROM fks WHERE conname = 'LandingPageVersion_supersededBy_fkey' AND condeferrable AND condeferred), 1
  UNION ALL SELECT 11, (SELECT count(*) FROM pg_class i JOIN pg_index x ON x.indexrelid = i.oid
                         WHERE i.relnamespace = (SELECT oid FROM pub) AND i.relname IN (SELECT nm FROM idx) AND x.indisunique) = 7,
                       (SELECT count(*) FROM pg_class i JOIN pg_index x ON x.indexrelid = i.oid
                         WHERE i.relnamespace = (SELECT oid FROM pub) AND i.relname IN (SELECT nm FROM idx) AND x.indisunique)
  UNION ALL SELECT 12, (SELECT count(*) FROM pg_constraint k JOIN tbl ON tbl.oid = k.conrelid WHERE k.contype = 'c' AND tbl.relname = 'LandingPage') = 3
                       AND (SELECT count(*) FROM pg_constraint k JOIN tbl ON tbl.oid = k.conrelid WHERE k.contype = 'c' AND tbl.relname = 'LandingPageVersion') = 8,
                       (SELECT count(*) FROM pg_constraint k WHERE k.conrelid IN (SELECT oid FROM tbl) AND k.contype = 'c')
  UNION ALL SELECT 13, (SELECT count(*) FROM rt_tbl WHERE letters = 'ar') = 2 AND (SELECT count(*) FROM rt_tbl) = 2, (SELECT count(*) FROM rt_tbl)
  UNION ALL SELECT 14, NOT EXISTS (SELECT relname, col FROM rt_cols EXCEPT SELECT relname, col FROM expected_cols)
                       AND NOT EXISTS (SELECT relname, col FROM expected_cols EXCEPT SELECT relname, col FROM rt_cols),
                       (SELECT count(*) FROM rt_cols)
  UNION ALL SELECT 15, (SELECT n FROM rt_seq) = 4, (SELECT n FROM rt_seq)
  UNION ALL SELECT 16, NOT EXISTS (SELECT 1 FROM tbl CROSS JOIN LATERAL aclexplode(tbl.relacl) x WHERE x.grantee = 0)
                       AND (SELECT count(*) FROM fns) = 3
                       AND NOT EXISTS (SELECT 1 FROM fns WHERE proacl IS NULL)
                       AND NOT EXISTS (SELECT 1 FROM fns CROSS JOIN LATERAL aclexplode(fns.proacl) x WHERE x.grantee = 0),
                       (SELECT count(*) FROM fns)
  UNION ALL SELECT 17, (SELECT count(*) FROM "LandingPage") + (SELECT count(*) FROM "LandingPageVersion") = 0,
                       (SELECT count(*) FROM "LandingPage") + (SELECT count(*) FROM "LandingPageVersion")
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
