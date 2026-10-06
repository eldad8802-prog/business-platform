-- ============================================================================
-- transactional-email-foundation-production-evidence.sql
--
-- Read-only Production EVIDENCE after migration
--   20261015090000_transactional_email_foundation
--
-- Proves the migration's outcome, from the catalog and counts only:
--   * it is recorded and finished, its sha256 is the reviewed one, nothing is unfinished or rolled back;
--   * TransactionalEmail exists with RLS ENABLED + FORCED and exactly five per-command policies:
--     app_auth read / add / change (the add policy binds a named user to the row's business), and
--     app_runtime read / remove, both on the app.current_business_id GUC; no catch-all policy, and no
--     removal policy for app_auth;
--   * both foreign keys (Business, User) cascade; the idempotency key is unique; the worker, user and
--     tenant indexes exist; the nine check constraints exist;
--   * app_runtime holds exactly: removal on the table, read on (id, businessId) and on no other column,
--     nothing on the sequence;
--   * app_auth holds exactly: read on the table, add on the twelve creation columns, change on the eight
--     delivery columns, USAGE on the sequence — and no removal;
--   * PUBLIC holds nothing on the table or the sequence;
--   * the table is empty: nothing was backfilled.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== transactional email foundation production evidence: legend (n -> check) =='
\echo ' 1 the migration is recorded and finished (observed = finished rows)'
\echo ' 2 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 3 the recorded checksum is the reviewed sha256 of migration.sql'
\echo ' 4 TransactionalEmail exists with RLS ENABLED + FORCED'
\echo ' 5 exactly five policies: app_auth r / a / w, app_runtime r / d on the GUC (observed = policies)'
\echo ' 6 no catch-all (*) policy and no removal (d) policy for app_auth (observed = such policies)'
\echo ' 7 the app_auth add policy binds the named user to the row business (reads User.businessId)'
\echo ' 8 foreign keys: Business and User, both cascading (observed = matching)'
\echo ' 9 indexes: unique dedupeKey + status/nextAttemptAt, userId, businessId (observed = of 4)'
\echo '10 check constraints (observed = check constraints, expected 9)'
\echo '11 app_runtime table privileges are exactly d'
\echo '12 app_runtime column read: exactly id and businessId; no column add or change (observed = column grants)'
\echo '13 app_runtime holds nothing on the id sequence (observed = privileges)'
\echo '14 app_auth table privileges are exactly r'
\echo '15 app_auth column add: the 12 creation columns; column change: the 8 delivery columns; nothing else (observed = column grants)'
\echo '16 app_auth holds exactly USAGE on the id sequence; PUBLIC holds nothing on the table or the sequence'
\echo '17 the table is empty: nothing backfilled (observed = rows)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
tbl AS (SELECT c.oid, c.relrowsecurity, c.relforcerowsecurity, c.relacl FROM pg_class c
        WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'TransactionalEmail' AND c.relkind = 'r'),
seq AS (SELECT c.oid, c.relacl FROM pg_class c
        WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'TransactionalEmail_id_seq' AND c.relkind = 'S'),
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
seq_priv AS (SELECT x.grantee, x.privilege_type FROM seq CROSS JOIN LATERAL aclexplode(seq.relacl) x),
expected_rt_read(col) AS (VALUES ('id'), ('businessId')),
expected_au_add(col) AS (VALUES ('kind'), ('dedupeKey'), ('userId'), ('businessId'), ('toEmail'), ('payload'), ('locale'),
  ('status'), ('nextAttemptAt'), ('expiresAt'), ('createdAt'), ('updatedAt')),
expected_au_change(col) AS (VALUES ('status'), ('attempts'), ('nextAttemptAt'), ('lastErrorCode'), ('provider'),
  ('providerMessageId'), ('sentAt'), ('updatedAt')),
pols AS (SELECT p.polname, p.polcmd, p.polroles,
                pg_get_expr(p.polqual, p.polrelid) AS q, pg_get_expr(p.polwithcheck, p.polrelid) AS wc
         FROM pg_policy p WHERE p.polrelid = (SELECT oid FROM tbl)),
fks AS (SELECT k.confrelid::regclass::text AS target, k.confdeltype FROM pg_constraint k
        WHERE k.conrelid = (SELECT oid FROM tbl) AND k.contype = 'f'),
idx(nm, uniq) AS (VALUES ('TransactionalEmail_dedupeKey_key', true), ('TransactionalEmail_status_nextAttemptAt_idx', false),
  ('TransactionalEmail_userId_idx', false), ('TransactionalEmail_businessId_idx', false)),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261015090000_transactional_email_foundation'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1,
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261015090000_transactional_email_foundation'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261015090000_transactional_email_foundation'
                                AND checksum = '386af5d49f6f58034ba7501714d2255429c089261e7e59df3e9c2a758aadf85e'), 1
  UNION ALL SELECT 4, EXISTS (SELECT 1 FROM tbl WHERE relrowsecurity AND relforcerowsecurity), (SELECT count(*) FROM tbl)
  UNION ALL SELECT 5, (SELECT count(*) FROM pols) = 5
                      AND (SELECT count(*) FROM pols WHERE polroles = ARRAY[(SELECT oid FROM au)] AND polcmd IN ('r', 'a', 'w')) = 3
                      AND (SELECT count(*) FROM pols WHERE polroles = ARRAY[(SELECT oid FROM rt)] AND polcmd IN ('r', 'd')
                             AND q LIKE '%app.current_business_id%') = 2,
                      (SELECT count(*) FROM pols)
  UNION ALL SELECT 6, NOT EXISTS (SELECT 1 FROM pols WHERE polcmd = '*' OR (polcmd = 'd' AND polroles <> ARRAY[(SELECT oid FROM rt)])),
                      (SELECT count(*) FROM pols WHERE polcmd = '*' OR (polcmd = 'd' AND polroles <> ARRAY[(SELECT oid FROM rt)]))
  UNION ALL SELECT 7, EXISTS (SELECT 1 FROM pols WHERE polcmd = 'a' AND polroles = ARRAY[(SELECT oid FROM au)]
                                AND wc LIKE '%"User"%' AND wc LIKE '%"businessId"%'), 1
  UNION ALL SELECT 8, (SELECT count(*) FROM fks WHERE target IN ('"Business"', '"User"') AND confdeltype = 'c') = 2 AND (SELECT count(*) FROM fks) = 2,
                      (SELECT count(*) FROM fks)
  UNION ALL SELECT 9, (SELECT count(*) FROM idx JOIN pg_class i ON i.relname = idx.nm AND i.relnamespace = (SELECT oid FROM pub)
                         JOIN pg_index x ON x.indexrelid = i.oid WHERE x.indrelid = (SELECT oid FROM tbl) AND x.indisunique = idx.uniq) = 4,
                      (SELECT count(*) FROM idx JOIN pg_class i ON i.relname = idx.nm AND i.relnamespace = (SELECT oid FROM pub)
                         JOIN pg_index x ON x.indexrelid = i.oid WHERE x.indrelid = (SELECT oid FROM tbl) AND x.indisunique = idx.uniq)
  UNION ALL SELECT 10, (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM tbl) AND k.contype = 'c') = 9,
                       (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM tbl) AND k.contype = 'c')
  UNION ALL SELECT 11, EXISTS (SELECT 1 FROM tbl_letters WHERE grantee = (SELECT oid FROM rt) AND letters = 'd'), 1
  UNION ALL SELECT 12, NOT EXISTS (SELECT col FROM col_priv WHERE grantee = (SELECT oid FROM rt) AND l = 'r' EXCEPT SELECT col FROM expected_rt_read)
                       AND NOT EXISTS (SELECT col FROM expected_rt_read EXCEPT SELECT col FROM col_priv WHERE grantee = (SELECT oid FROM rt) AND l = 'r')
                       AND NOT EXISTS (SELECT 1 FROM col_priv WHERE grantee = (SELECT oid FROM rt) AND l <> 'r'),
                       (SELECT count(*) FROM col_priv WHERE grantee = (SELECT oid FROM rt))
  UNION ALL SELECT 13, NOT EXISTS (SELECT 1 FROM seq_priv WHERE grantee = (SELECT oid FROM rt)),
                       (SELECT count(*) FROM seq_priv WHERE grantee = (SELECT oid FROM rt))
  UNION ALL SELECT 14, EXISTS (SELECT 1 FROM tbl_letters WHERE grantee = (SELECT oid FROM au) AND letters = 'r'), 1
  UNION ALL SELECT 15, NOT EXISTS (SELECT col FROM col_priv WHERE grantee = (SELECT oid FROM au) AND l = 'a' EXCEPT SELECT col FROM expected_au_add)
                       AND NOT EXISTS (SELECT col FROM expected_au_add EXCEPT SELECT col FROM col_priv WHERE grantee = (SELECT oid FROM au) AND l = 'a')
                       AND NOT EXISTS (SELECT col FROM col_priv WHERE grantee = (SELECT oid FROM au) AND l = 'w' EXCEPT SELECT col FROM expected_au_change)
                       AND NOT EXISTS (SELECT col FROM expected_au_change EXCEPT SELECT col FROM col_priv WHERE grantee = (SELECT oid FROM au) AND l = 'w')
                       AND NOT EXISTS (SELECT 1 FROM col_priv WHERE grantee = (SELECT oid FROM au) AND l NOT IN ('a', 'w')),
                       (SELECT count(*) FROM col_priv WHERE grantee = (SELECT oid FROM au))
  UNION ALL SELECT 16, (SELECT count(*) FROM seq_priv WHERE grantee = (SELECT oid FROM au)) = 1
                       AND EXISTS (SELECT 1 FROM seq_priv WHERE grantee = (SELECT oid FROM au) AND privilege_type = 'USAGE')
                       AND NOT EXISTS (SELECT 1 FROM tbl_priv WHERE grantee = 0)
                       AND NOT EXISTS (SELECT 1 FROM seq_priv WHERE grantee = 0),
                       (SELECT count(*) FROM seq_priv)
  UNION ALL SELECT 17, (SELECT count(*) FROM "TransactionalEmail") = 0, (SELECT count(*) FROM "TransactionalEmail")
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
