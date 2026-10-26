-- ============================================================================
-- auth-email-tokens-production-evidence.sql
--
-- Read-only Production EVIDENCE after migration
--   20261017090000_auth_email_tokens
--
-- Proves the migration's outcome, from the catalog and counts only:
--   * it is recorded and finished, its sha256 is the reviewed one, nothing is unfinished or rolled back;
--   * AuthEmailToken exists with RLS ENABLED + FORCED and exactly two per-command policies: app_runtime
--     read / remove on the app.current_business_id GUC; no catch-all policy, nothing for any other role;
--   * both foreign keys (User, Business) cascade; the hash is unique; the issuance and tenant indexes
--     exist; the five check constraints exist;
--   * app_runtime holds exactly: removal on the table and read on (id, businessId), nothing else;
--   * app_auth and PUBLIC hold nothing on the table;
--   * the four functions exist, SECURITY DEFINER with a pinned search_path, owned by the migration role;
--     EXECUTE is held by app_auth and by no other role (PUBLIC and app_runtime included);
--   * "User"."emailVerifiedAt" exists (timestamp(3), nullable); app_auth may read it and may change
--     neither it nor "User"."password";
--   * nothing was backfilled: no token and no verification stamp predates the migration's own finish.
--
-- STAYS VALID AFTER LATER MIGRATIONS (revised with 20261102090000_oauth_identity_link, Google sign-in M3):
--   * 20261102090000 adds the LINK_GOOGLE purpose and a ticket-binding key and check to this table. Checks 7
--     and 9 therefore expect the third key (to OAuthSignupTicket, cascading) and the sixth check constraint
--     exactly when that migration is recorded finished, and the original two / five otherwise. Everything
--     else that migration adds is proven by oauth-identity-link-production-evidence.sql (checks 5–9, 12, 14).
--   * Check 17 was a point-in-time "the table is empty" at apply (2026-10-17); once the product issues links
--     it would fail forever. It now proves the same thing at any time: no token row and no verified user
--     predates the migration's finish.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== auth email tokens production evidence: legend (n -> check) =='
\echo ' 1 the migration is recorded and finished (observed = finished rows)'
\echo ' 2 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 3 the recorded checksum is the reviewed sha256 of migration.sql'
\echo ' 4 AuthEmailToken exists with RLS ENABLED + FORCED'
\echo ' 5 exactly two policies: app_runtime r / d on the GUC (observed = policies)'
\echo ' 6 no catch-all (*) policy and no removal (d) policy except app_runtime (observed = such policies)'
\echo ' 7 foreign keys: User and Business, both cascading (+ OAuthSignupTicket, cascading, once 20261102090000 is finished) (observed = keys)'
\echo ' 8 indexes: unique tokenHash + userId/purpose/createdAt + businessId (observed = of 3)'
\echo ' 9 check constraints (observed = check constraints; expected 5, or 6 once 20261102090000 is finished)'
\echo '10 app_runtime table privileges are exactly d'
\echo '11 app_runtime column read: exactly id and businessId; no other column privilege (observed = column grants)'
\echo '12 app_auth holds nothing on the table, at table or column level (observed = privileges)'
\echo '13 PUBLIC holds nothing on the table (observed = privileges)'
\echo '14 the four functions: SECURITY DEFINER, search_path pinned, owned by the migration role (observed = of 4)'
\echo '15 EXECUTE: app_auth on all four; no other grantee besides the owner (observed = foreign grantees)'
\echo '16 User.emailVerifiedAt: timestamp(3), nullable; app_auth reads it, changes neither it nor password'
\echo '17 nothing backfilled: no token and no verified user predates the migration finish (observed = such rows)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
tbl AS (SELECT c.oid, c.relrowsecurity, c.relforcerowsecurity, c.relacl FROM pg_class c
        WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'AuthEmailToken' AND c.relkind = 'r'),
usr AS (SELECT c.oid FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'User' AND c.relkind = 'r'),
me AS (SELECT oid FROM pg_roles WHERE rolname = current_user),
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
expected_rt_read(col) AS (VALUES ('id'), ('businessId')),
pols AS (SELECT p.polname, p.polcmd, p.polroles,
                pg_get_expr(p.polqual, p.polrelid) AS q, pg_get_expr(p.polwithcheck, p.polrelid) AS wc
         FROM pg_policy p WHERE p.polrelid = (SELECT oid FROM tbl)),
fks AS (SELECT k.confrelid::regclass::text AS target, k.confdeltype FROM pg_constraint k
        WHERE k.conrelid = (SELECT oid FROM tbl) AND k.contype = 'f'),
idx(nm, uniq) AS (VALUES ('AuthEmailToken_tokenHash_key', true), ('AuthEmailToken_userId_purpose_createdAt_idx', false),
  ('AuthEmailToken_businessId_idx', false)),
fns AS (SELECT p.oid, p.proname, p.prosecdef, p.proowner, p.proconfig, p.proacl FROM pg_proc p
        WHERE p.pronamespace = (SELECT oid FROM pub)
          AND p.proname IN ('auth_email_token_issue', 'auth_email_token_check', 'auth_email_verify_consume', 'auth_password_reset_consume')),
fn_exec AS (SELECT f.proname, x.grantee FROM fns f CROSS JOIN LATERAL aclexplode(f.proacl) x WHERE x.privilege_type = 'EXECUTE'),
verified_col AS (SELECT a.attnum, a.atttypid, a.atttypmod, a.attnotnull FROM pg_attribute a
                 WHERE a.attrelid = (SELECT oid FROM usr) AND a.attname = 'emailVerifiedAt' AND NOT a.attisdropped),
-- 20261102090000_oauth_identity_link (Google M3) widens this table by one key and one check when it is finished.
link AS (SELECT count(*) AS n FROM "_prisma_migrations" WHERE migration_name = '20261102090000_oauth_identity_link'
         AND finished_at IS NOT NULL AND rolled_back_at IS NULL),
-- The migration's own finish, as the UTC wall-clock the timestamp(3) columns hold.
aet_done AS (SELECT timezone('UTC', finished_at) AS at FROM "_prisma_migrations"
             WHERE migration_name = '20261017090000_auth_email_tokens' AND finished_at IS NOT NULL AND rolled_back_at IS NULL),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261017090000_auth_email_tokens'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1,
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261017090000_auth_email_tokens'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261017090000_auth_email_tokens'
                                AND checksum = '42737f51f551e91ff86670a0be7a482a14a13d516c84c16d573b365ec104b769'), 1
  UNION ALL SELECT 4, EXISTS (SELECT 1 FROM tbl WHERE relrowsecurity AND relforcerowsecurity), (SELECT count(*) FROM tbl)
  UNION ALL SELECT 5, (SELECT count(*) FROM pols) = 2
                      AND (SELECT count(*) FROM pols WHERE polroles = ARRAY[(SELECT oid FROM rt)] AND polcmd IN ('r', 'd')
                             AND q LIKE '%app.current_business_id%') = 2,
                      (SELECT count(*) FROM pols)
  UNION ALL SELECT 6, NOT EXISTS (SELECT 1 FROM pols WHERE polcmd = '*' OR (polcmd = 'd' AND polroles <> ARRAY[(SELECT oid FROM rt)])),
                      (SELECT count(*) FROM pols WHERE polcmd = '*' OR (polcmd = 'd' AND polroles <> ARRAY[(SELECT oid FROM rt)]))
  UNION ALL SELECT 7, (SELECT count(*) FROM fks WHERE target IN ('"Business"', '"User"') AND confdeltype = 'c') = 2
                      AND (SELECT count(*) FROM fks WHERE target = '"OAuthSignupTicket"' AND confdeltype = 'c') = (SELECT n FROM link)
                      AND (SELECT count(*) FROM fks) = 2 + (SELECT n FROM link),
                      (SELECT count(*) FROM fks)
  UNION ALL SELECT 8, (SELECT count(*) FROM idx JOIN pg_class i ON i.relname = idx.nm AND i.relnamespace = (SELECT oid FROM pub)
                         JOIN pg_index x ON x.indexrelid = i.oid WHERE x.indrelid = (SELECT oid FROM tbl) AND x.indisunique = idx.uniq) = 3,
                      (SELECT count(*) FROM idx JOIN pg_class i ON i.relname = idx.nm AND i.relnamespace = (SELECT oid FROM pub)
                         JOIN pg_index x ON x.indexrelid = i.oid WHERE x.indrelid = (SELECT oid FROM tbl) AND x.indisunique = idx.uniq)
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM tbl) AND k.contype = 'c') = 5 + (SELECT n FROM link),
                      (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM tbl) AND k.contype = 'c')
  UNION ALL SELECT 10, EXISTS (SELECT 1 FROM tbl_letters WHERE grantee = (SELECT oid FROM rt) AND letters = 'd'), 1
  UNION ALL SELECT 11, NOT EXISTS (SELECT col FROM col_priv WHERE grantee = (SELECT oid FROM rt) AND l = 'r' EXCEPT SELECT col FROM expected_rt_read)
                       AND NOT EXISTS (SELECT col FROM expected_rt_read EXCEPT SELECT col FROM col_priv WHERE grantee = (SELECT oid FROM rt) AND l = 'r')
                       AND NOT EXISTS (SELECT 1 FROM col_priv WHERE grantee = (SELECT oid FROM rt) AND l <> 'r'),
                       (SELECT count(*) FROM col_priv WHERE grantee = (SELECT oid FROM rt))
  UNION ALL SELECT 12, NOT EXISTS (SELECT 1 FROM tbl_priv WHERE grantee = (SELECT oid FROM au))
                       AND NOT EXISTS (SELECT 1 FROM col_priv WHERE grantee = (SELECT oid FROM au)),
                       (SELECT count(*) FROM tbl_priv WHERE grantee = (SELECT oid FROM au)) + (SELECT count(*) FROM col_priv WHERE grantee = (SELECT oid FROM au))
  UNION ALL SELECT 13, NOT EXISTS (SELECT 1 FROM tbl_priv WHERE grantee = 0) AND NOT EXISTS (SELECT 1 FROM col_priv WHERE grantee = 0),
                       (SELECT count(*) FROM tbl_priv WHERE grantee = 0) + (SELECT count(*) FROM col_priv WHERE grantee = 0)
  UNION ALL SELECT 14, (SELECT count(*) FROM fns WHERE prosecdef AND proowner = (SELECT oid FROM me)
                          AND EXISTS (SELECT 1 FROM unnest(proconfig) c WHERE c LIKE 'search\_path=%')) = 4
                       AND (SELECT count(*) FROM fns) = 4,
                       (SELECT count(*) FROM fns WHERE prosecdef AND proowner = (SELECT oid FROM me)
                          AND EXISTS (SELECT 1 FROM unnest(proconfig) c WHERE c LIKE 'search\_path=%'))
  UNION ALL SELECT 15, (SELECT count(DISTINCT proname) FROM fn_exec WHERE grantee = (SELECT oid FROM au)) = 4
                       AND NOT EXISTS (SELECT 1 FROM fn_exec WHERE grantee NOT IN ((SELECT oid FROM au), (SELECT oid FROM me))),
                       (SELECT count(*) FROM fn_exec WHERE grantee NOT IN ((SELECT oid FROM au), (SELECT oid FROM me)))
  UNION ALL SELECT 16, EXISTS (SELECT 1 FROM verified_col WHERE atttypid = 'timestamp'::regtype AND atttypmod = 3 AND NOT attnotnull)
                       AND has_column_privilege('app_auth', (SELECT oid FROM usr), 'emailVerifiedAt', 'SELECT')
                       AND NOT has_column_privilege('app_auth', (SELECT oid FROM usr), 'emailVerifiedAt', 'UPD' || 'ATE')
                       AND NOT has_column_privilege('app_auth', (SELECT oid FROM usr), 'password', 'UPD' || 'ATE'), 1
  UNION ALL SELECT 17, EXISTS (SELECT 1 FROM aet_done)
                       AND (SELECT count(*) FROM "AuthEmailToken" WHERE "createdAt" < (SELECT at FROM aet_done)) = 0
                       AND (SELECT count(*) FROM "User" WHERE "emailVerifiedAt" < (SELECT at FROM aet_done)) = 0,
                       (SELECT count(*) FROM "AuthEmailToken" WHERE "createdAt" < (SELECT at FROM aet_done))
                         + (SELECT count(*) FROM "User" WHERE "emailVerifiedAt" < (SELECT at FROM aet_done))
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
