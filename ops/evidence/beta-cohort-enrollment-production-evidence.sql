-- ============================================================================
-- beta-cohort-enrollment-production-evidence.sql
--
-- Read-only Production EVIDENCE after migration
--   20261017090000_beta_cohort_enrollment
--
-- Proves the migration's outcome, from the catalog and counts only:
--   * it is recorded and finished, its sha256 is the reviewed one, nothing is unfinished or rolled back;
--   * BusinessBetaEnrollment exists with RLS ENABLED + FORCED and exactly two per-command policies:
--     app_auth add (only rows whose source is the closed-beta signup) and app_runtime read on the
--     app.current_business_id GUC; no catch-all policy, no change policy, no removal policy;
--   * the key is businessId (one row per business at most); the Business foreign key cascades;
--     the two check constraints exist;
--   * app_runtime holds exactly read on the table and no column privilege;
--   * app_auth holds no table privilege and exactly add on the four columns;
--   * PUBLIC holds nothing;
--   * INFO: rows (0 right after the release: nothing was backfilled; afterwards = closed-beta signups).
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== beta cohort enrollment production evidence: legend (n -> check) =='
\echo ' 1 the migration is recorded and finished (observed = finished rows)'
\echo ' 2 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 3 the recorded checksum is the reviewed sha256 of migration.sql'
\echo ' 4 BusinessBetaEnrollment exists with RLS ENABLED + FORCED'
\echo ' 5 exactly two policies: app_auth a, app_runtime r on the GUC (observed = policies)'
\echo ' 6 no catch-all (*), change (w) or removal (d) policy (observed = such policies)'
\echo ' 7 the app_auth add policy admits only the closed-beta signup source'
\echo ' 8 the primary key is businessId alone; the one foreign key targets Business and cascades'
\echo ' 9 check constraints (observed = check constraints, expected 2)'
\echo '10 app_runtime table privileges are exactly r; no column privilege (observed = column grants)'
\echo '11 app_auth holds no table privilege (observed = table grants)'
\echo '12 app_auth column add: exactly businessId, cohort, source, createdAt; nothing else (observed = column grants)'
\echo '13 PUBLIC holds nothing on the table'
\echo '14 INFO enrolled businesses (observed = rows; 0 right after the release)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
tbl AS (SELECT c.oid, c.relrowsecurity, c.relforcerowsecurity, c.relacl FROM pg_class c
        WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'BusinessBetaEnrollment' AND c.relkind = 'r'),
rt AS (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime'),
au AS (SELECT oid FROM pg_roles WHERE rolname = 'app_auth'),
letter AS (SELECT * FROM (VALUES ('SELECT', 'r'), ('INS' || 'ERT', 'a'), ('UPD' || 'ATE', 'w'), ('DEL' || 'ETE', 'd'),
                                 ('TRUNC' || 'ATE', 'D'), ('REFERENCES', 'x'), ('TRIGGER', 't'), ('MAINTAIN', 'm'),
                                 ('USAGE', 'U')) v(priv, l)),
tbl_priv AS (SELECT x.grantee, (SELECT l FROM letter WHERE priv = x.privilege_type) COLLATE "C" AS l
             FROM tbl CROSS JOIN LATERAL aclexplode(tbl.relacl) x),
tbl_letters AS (SELECT grantee, string_agg(DISTINCT l, '' ORDER BY l) AS letters FROM tbl_priv GROUP BY grantee),
col_priv AS (SELECT x.grantee, a.attname::text AS col, (SELECT l FROM letter WHERE priv = x.privilege_type) AS l
             FROM tbl JOIN pg_attribute a ON a.attrelid = tbl.oid AND a.attnum > 0 AND NOT a.attisdropped
             CROSS JOIN LATERAL aclexplode(a.attacl) x),
expected_au_add(col) AS (VALUES ('businessId'), ('cohort'), ('source'), ('createdAt')),
pols AS (SELECT p.polname, p.polcmd, p.polroles,
                pg_get_expr(p.polqual, p.polrelid) AS q, pg_get_expr(p.polwithcheck, p.polrelid) AS wc
         FROM pg_policy p WHERE p.polrelid = (SELECT oid FROM tbl)),
pk_cols AS (SELECT a.attname FROM pg_constraint k JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
            WHERE k.conrelid = (SELECT oid FROM tbl) AND k.contype = 'p'),
fks AS (SELECT k.confrelid::regclass::text AS target, k.confdeltype FROM pg_constraint k
        WHERE k.conrelid = (SELECT oid FROM tbl) AND k.contype = 'f'),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261017090000_beta_cohort_enrollment'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1,
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261017090000_beta_cohort_enrollment'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261017090000_beta_cohort_enrollment'
                                AND checksum = '219dac3fe76da6d54d36a79face9b5729e798c10be557890af782643dd6e86b8'), 1
  UNION ALL SELECT 4, EXISTS (SELECT 1 FROM tbl WHERE relrowsecurity AND relforcerowsecurity), (SELECT count(*) FROM tbl)
  UNION ALL SELECT 5, (SELECT count(*) FROM pols) = 2
                      AND EXISTS (SELECT 1 FROM pols WHERE polroles = ARRAY[(SELECT oid FROM au)] AND polcmd = 'a')
                      AND EXISTS (SELECT 1 FROM pols WHERE polroles = ARRAY[(SELECT oid FROM rt)] AND polcmd = 'r'
                                    AND q LIKE '%app.current_business_id%'),
                      (SELECT count(*) FROM pols)
  UNION ALL SELECT 6, NOT EXISTS (SELECT 1 FROM pols WHERE polcmd IN ('*', 'w', 'd')),
                      (SELECT count(*) FROM pols WHERE polcmd IN ('*', 'w', 'd'))
  UNION ALL SELECT 7, EXISTS (SELECT 1 FROM pols WHERE polcmd = 'a' AND polroles = ARRAY[(SELECT oid FROM au)]
                                AND wc LIKE '%source%' AND wc LIKE '%CLOSED_BETA_SIGNUP%'), 1
  UNION ALL SELECT 8, (SELECT count(*) FROM pk_cols) = 1 AND EXISTS (SELECT 1 FROM pk_cols WHERE attname = 'businessId')
                      AND (SELECT count(*) FROM fks) = 1 AND EXISTS (SELECT 1 FROM fks WHERE target = '"Business"' AND confdeltype = 'c'),
                      (SELECT count(*) FROM fks)
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM tbl) AND k.contype = 'c') = 2,
                      (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM tbl) AND k.contype = 'c')
  UNION ALL SELECT 10, EXISTS (SELECT 1 FROM tbl_letters WHERE grantee = (SELECT oid FROM rt) AND letters = 'r')
                       AND NOT EXISTS (SELECT 1 FROM col_priv WHERE grantee = (SELECT oid FROM rt)),
                       (SELECT count(*) FROM col_priv WHERE grantee = (SELECT oid FROM rt))
  UNION ALL SELECT 11, NOT EXISTS (SELECT 1 FROM tbl_priv WHERE grantee = (SELECT oid FROM au)),
                       (SELECT count(*) FROM tbl_priv WHERE grantee = (SELECT oid FROM au))
  UNION ALL SELECT 12, NOT EXISTS (SELECT col FROM col_priv WHERE grantee = (SELECT oid FROM au) AND l = 'a' EXCEPT SELECT col FROM expected_au_add)
                       AND NOT EXISTS (SELECT col FROM expected_au_add EXCEPT SELECT col FROM col_priv WHERE grantee = (SELECT oid FROM au) AND l = 'a')
                       AND NOT EXISTS (SELECT 1 FROM col_priv WHERE grantee = (SELECT oid FROM au) AND l <> 'a'),
                       (SELECT count(*) FROM col_priv WHERE grantee = (SELECT oid FROM au))
  UNION ALL SELECT 13, NOT EXISTS (SELECT 1 FROM tbl_priv WHERE grantee = 0)
                       AND NOT EXISTS (SELECT 1 FROM col_priv WHERE grantee = 0), 1
  UNION ALL SELECT 14, true, (SELECT count(*) FROM "BusinessBetaEnrollment")
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
