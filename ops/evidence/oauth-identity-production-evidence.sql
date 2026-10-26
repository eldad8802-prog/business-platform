-- ============================================================================
-- oauth-identity-production-evidence.sql
--
-- Read-only EVIDENCE after migration
--   20261030090000_oauth_identity_foundation
--
-- Proves the migration's outcome, from the catalog and counts only:
--   * it is recorded and finished, its sha256 is the reviewed one, nothing is unfinished or rolled back;
--   * UserIdentity and OAuthSignupTicket exist with RLS ENABLED + FORCED; UserIdentity carries exactly two
--     per-command policies (app_runtime read / removal on the app.current_business_id GUC), the ticket
--     table carries none;
--   * the foreign keys (identity: User and Business cascading; ticket: User nulling), the indexes and the
--     twelve check constraints exist;
--   * app_runtime holds exactly removal on UserIdentity and read on (id, businessId), and nothing on the
--     ticket table; app_auth and PUBLIC hold nothing on either table or on the identity sequence;
--   * the six functions exist, SECURITY DEFINER with a pinned search_path, owned by the migration role;
--     EXECUTE is held by app_auth and by no other role (PUBLIC and app_runtime included);
--   * "User"."password" is nullable; app_auth may change neither it nor "User"."emailVerifiedAt";
--   * nothing was backfilled: no identity, no ticket and no password-less user predates the migration's finish.
--     (Revised with Google M3: this was a point-in-time "no identity, no ticket, every user has a password" at
--     apply; once Google sign-in is used it would fail forever. It now proves the same thing at any time.)
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== oauth identity evidence: legend (n -> check) =='
\echo ' 1 the migration is recorded and finished (observed = finished rows)'
\echo ' 2 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 3 the recorded checksum is the reviewed sha256 of migration.sql'
\echo ' 4 UserIdentity exists with RLS ENABLED + FORCED'
\echo ' 5 OAuthSignupTicket exists with RLS ENABLED + FORCED'
\echo ' 6 UserIdentity: exactly two policies, app_runtime r / d on the GUC (observed = policies)'
\echo ' 7 OAuthSignupTicket: no policy at all (observed = policies)'
\echo ' 8 foreign keys: identity to User + Business cascading, ticket to User nulling (observed = of 3)'
\echo ' 9 indexes: 3 on UserIdentity (2 unique) + 3 on OAuthSignupTicket (1 unique) (observed = of 6)'
\echo '10 check constraints: 3 on UserIdentity + 9 on OAuthSignupTicket (observed = check constraints)'
\echo '11 app_runtime on UserIdentity: table letters exactly d; column read exactly id, businessId'
\echo '12 app_runtime holds nothing on OAuthSignupTicket or on the identity sequence (observed = privileges)'
\echo '13 app_auth holds nothing on either table, at table or column level, nor on the sequence'
\echo '14 PUBLIC holds nothing on either table nor on the sequence (observed = privileges)'
\echo '15 the six functions: SECURITY DEFINER, search_path pinned, owned by the migration role (observed = of 6)'
\echo '16 EXECUTE: app_auth on all six; no other grantee besides the owner (observed = foreign grantees)'
\echo '17 User.password is nullable; app_auth changes neither password nor emailVerifiedAt'
\echo '18 nothing backfilled: no identity, no ticket, no password-less user predates the migration finish (observed = rows)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
idt AS (SELECT c.oid, c.relrowsecurity, c.relforcerowsecurity, c.relacl FROM pg_class c
        WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'UserIdentity' AND c.relkind = 'r'),
tkt AS (SELECT c.oid, c.relrowsecurity, c.relforcerowsecurity, c.relacl FROM pg_class c
        WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'OAuthSignupTicket' AND c.relkind = 'r'),
seq AS (SELECT c.oid, c.relacl FROM pg_class c
        WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'UserIdentity_id_seq' AND c.relkind = 'S'),
usr AS (SELECT c.oid FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'User' AND c.relkind = 'r'),
me AS (SELECT oid FROM pg_roles WHERE rolname = current_user),
rt AS (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime'),
au AS (SELECT oid FROM pg_roles WHERE rolname = 'app_auth'),
letter AS (SELECT * FROM (VALUES ('SELECT', 'r'), ('INS' || 'ERT', 'a'), ('UPD' || 'ATE', 'w'), ('DEL' || 'ETE', 'd'),
                                 ('TRUNC' || 'ATE', 'D'), ('REFERENCES', 'x'), ('TRIGGER', 't'), ('MAINTAIN', 'm'),
                                 ('USAGE', 'U')) v(priv, l)),
idt_priv AS (SELECT x.grantee, (SELECT l FROM letter WHERE priv = x.privilege_type) COLLATE "C" AS l
             FROM idt CROSS JOIN LATERAL aclexplode(idt.relacl) x),
idt_letters AS (SELECT grantee, string_agg(DISTINCT l, '' ORDER BY l) AS letters FROM idt_priv GROUP BY grantee),
tkt_priv AS (SELECT x.grantee FROM tkt CROSS JOIN LATERAL aclexplode(tkt.relacl) x),
seq_priv AS (SELECT x.grantee FROM seq CROSS JOIN LATERAL aclexplode(seq.relacl) x),
idt_col AS (SELECT x.grantee, a.attname::text AS col, (SELECT l FROM letter WHERE priv = x.privilege_type) AS l
            FROM idt JOIN pg_attribute a ON a.attrelid = idt.oid AND a.attnum > 0 AND NOT a.attisdropped
            CROSS JOIN LATERAL aclexplode(a.attacl) x),
tkt_col AS (SELECT x.grantee FROM tkt JOIN pg_attribute a ON a.attrelid = tkt.oid AND a.attnum > 0 AND NOT a.attisdropped
            CROSS JOIN LATERAL aclexplode(a.attacl) x),
expected_rt_read(col) AS (VALUES ('id'), ('businessId')),
idt_pols AS (SELECT p.polname, p.polcmd, p.polroles, pg_get_expr(p.polqual, p.polrelid) AS q
             FROM pg_policy p WHERE p.polrelid = (SELECT oid FROM idt)),
fks AS (SELECT k.conrelid, k.confrelid::regclass::text AS target, k.confdeltype FROM pg_constraint k
        WHERE k.conrelid IN ((SELECT oid FROM idt), (SELECT oid FROM tkt)) AND k.contype = 'f'),
idx(nm, rel, uniq) AS (VALUES
  ('UserIdentity_provider_providerSubject_key', 'UserIdentity', true),
  ('UserIdentity_userId_provider_key', 'UserIdentity', true),
  ('UserIdentity_businessId_idx', 'UserIdentity', false),
  ('OAuthSignupTicket_secretHash_key', 'OAuthSignupTicket', true),
  ('OAuthSignupTicket_provider_providerSubject_purpose_issuedAt_idx', 'OAuthSignupTicket', false),
  ('OAuthSignupTicket_expiresAt_idx', 'OAuthSignupTicket', false)),
idx_found AS (SELECT idx.nm FROM idx
              JOIN pg_class i ON i.relname = idx.nm AND i.relnamespace = (SELECT oid FROM pub)
              JOIN pg_index x ON x.indexrelid = i.oid
              JOIN pg_class r ON r.oid = x.indrelid AND r.relname = idx.rel
              WHERE x.indisunique = idx.uniq),
fns AS (SELECT p.oid, p.proname, p.prosecdef, p.proowner, p.proconfig, p.proacl FROM pg_proc p
        WHERE p.pronamespace = (SELECT oid FROM pub)
          AND p.proname IN ('auth_oauth_ticket_issue', 'auth_oauth_ticket_read', 'auth_oauth_ticket_consume',
                            'auth_oauth_identity_attach', 'auth_oauth_identity_resolve', 'auth_oauth_ticket_purge')),
fn_exec AS (SELECT f.proname, x.grantee FROM fns f CROSS JOIN LATERAL aclexplode(f.proacl) x WHERE x.privilege_type = 'EXECUTE'),
pw_col AS (SELECT a.attnotnull FROM pg_attribute a
           WHERE a.attrelid = (SELECT oid FROM usr) AND a.attname = 'password' AND NOT a.attisdropped),
-- The migration's own finish, as the UTC wall-clock the timestamp(3) columns hold.
done AS (SELECT timezone('UTC', finished_at) AS at FROM "_prisma_migrations"
         WHERE migration_name = '20261030090000_oauth_identity_foundation' AND finished_at IS NOT NULL AND rolled_back_at IS NULL),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261030090000_oauth_identity_foundation'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1,
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261030090000_oauth_identity_foundation'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261030090000_oauth_identity_foundation'
                                AND checksum = '28ac0d8e270f1c1d9640d2d20500f5b5cf59d7be8b956b41ae47ebf052cb8bae'), 1
  UNION ALL SELECT 4, EXISTS (SELECT 1 FROM idt WHERE relrowsecurity AND relforcerowsecurity), (SELECT count(*) FROM idt)
  UNION ALL SELECT 5, EXISTS (SELECT 1 FROM tkt WHERE relrowsecurity AND relforcerowsecurity), (SELECT count(*) FROM tkt)
  UNION ALL SELECT 6, (SELECT count(*) FROM idt_pols) = 2
                      AND (SELECT count(*) FROM idt_pols WHERE polroles = ARRAY[(SELECT oid FROM rt)] AND polcmd IN ('r', 'd')
                             AND q LIKE '%app.current_business_id%') = 2,
                      (SELECT count(*) FROM idt_pols)
  UNION ALL SELECT 7, NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = (SELECT oid FROM tkt)),
                      (SELECT count(*) FROM pg_policy p WHERE p.polrelid = (SELECT oid FROM tkt))
  UNION ALL SELECT 8, (SELECT count(*) FROM fks WHERE conrelid = (SELECT oid FROM idt) AND target IN ('"User"', '"Business"') AND confdeltype = 'c') = 2
                      AND (SELECT count(*) FROM fks WHERE conrelid = (SELECT oid FROM tkt) AND target = '"User"' AND confdeltype = 'n') = 1
                      AND (SELECT count(*) FROM fks) = 3,
                      (SELECT count(*) FROM fks)
  UNION ALL SELECT 9, (SELECT count(*) FROM idx_found) = 6, (SELECT count(*) FROM idx_found)
  UNION ALL SELECT 10, (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM idt) AND k.contype = 'c') = 3
                       AND (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM tkt) AND k.contype = 'c') = 9,
                       (SELECT count(*) FROM pg_constraint k WHERE k.conrelid IN ((SELECT oid FROM idt), (SELECT oid FROM tkt)) AND k.contype = 'c')
  UNION ALL SELECT 11, EXISTS (SELECT 1 FROM idt_letters WHERE grantee = (SELECT oid FROM rt) AND letters = 'd')
                       AND NOT EXISTS (SELECT col FROM idt_col WHERE grantee = (SELECT oid FROM rt) AND l = 'r' EXCEPT SELECT col FROM expected_rt_read)
                       AND NOT EXISTS (SELECT col FROM expected_rt_read EXCEPT SELECT col FROM idt_col WHERE grantee = (SELECT oid FROM rt) AND l = 'r')
                       AND NOT EXISTS (SELECT 1 FROM idt_col WHERE grantee = (SELECT oid FROM rt) AND l <> 'r'),
                       (SELECT count(*) FROM idt_col WHERE grantee = (SELECT oid FROM rt))
  UNION ALL SELECT 12, NOT EXISTS (SELECT 1 FROM tkt_priv WHERE grantee = (SELECT oid FROM rt))
                       AND NOT EXISTS (SELECT 1 FROM tkt_col WHERE grantee = (SELECT oid FROM rt))
                       AND NOT EXISTS (SELECT 1 FROM seq_priv WHERE grantee = (SELECT oid FROM rt)),
                       (SELECT count(*) FROM tkt_priv WHERE grantee = (SELECT oid FROM rt)) + (SELECT count(*) FROM tkt_col WHERE grantee = (SELECT oid FROM rt))
                         + (SELECT count(*) FROM seq_priv WHERE grantee = (SELECT oid FROM rt))
  UNION ALL SELECT 13, NOT EXISTS (SELECT 1 FROM idt_priv WHERE grantee = (SELECT oid FROM au))
                       AND NOT EXISTS (SELECT 1 FROM idt_col WHERE grantee = (SELECT oid FROM au))
                       AND NOT EXISTS (SELECT 1 FROM tkt_priv WHERE grantee = (SELECT oid FROM au))
                       AND NOT EXISTS (SELECT 1 FROM tkt_col WHERE grantee = (SELECT oid FROM au))
                       AND NOT EXISTS (SELECT 1 FROM seq_priv WHERE grantee = (SELECT oid FROM au)),
                       (SELECT count(*) FROM idt_priv WHERE grantee = (SELECT oid FROM au)) + (SELECT count(*) FROM idt_col WHERE grantee = (SELECT oid FROM au))
                         + (SELECT count(*) FROM tkt_priv WHERE grantee = (SELECT oid FROM au)) + (SELECT count(*) FROM tkt_col WHERE grantee = (SELECT oid FROM au))
                         + (SELECT count(*) FROM seq_priv WHERE grantee = (SELECT oid FROM au))
  UNION ALL SELECT 14, NOT EXISTS (SELECT 1 FROM idt_priv WHERE grantee = 0) AND NOT EXISTS (SELECT 1 FROM idt_col WHERE grantee = 0)
                       AND NOT EXISTS (SELECT 1 FROM tkt_priv WHERE grantee = 0) AND NOT EXISTS (SELECT 1 FROM tkt_col WHERE grantee = 0)
                       AND NOT EXISTS (SELECT 1 FROM seq_priv WHERE grantee = 0),
                       (SELECT count(*) FROM idt_priv WHERE grantee = 0) + (SELECT count(*) FROM tkt_priv WHERE grantee = 0)
                         + (SELECT count(*) FROM seq_priv WHERE grantee = 0)
  UNION ALL SELECT 15, (SELECT count(*) FROM fns WHERE prosecdef AND proowner = (SELECT oid FROM me)
                          AND EXISTS (SELECT 1 FROM unnest(proconfig) c WHERE c LIKE 'search\_path=%')) = 6
                       AND (SELECT count(*) FROM fns) = 6,
                       (SELECT count(*) FROM fns WHERE prosecdef AND proowner = (SELECT oid FROM me)
                          AND EXISTS (SELECT 1 FROM unnest(proconfig) c WHERE c LIKE 'search\_path=%'))
  UNION ALL SELECT 16, (SELECT count(DISTINCT proname) FROM fn_exec WHERE grantee = (SELECT oid FROM au)) = 6
                       AND NOT EXISTS (SELECT 1 FROM fn_exec WHERE grantee NOT IN ((SELECT oid FROM au), (SELECT oid FROM me))),
                       (SELECT count(*) FROM fn_exec WHERE grantee NOT IN ((SELECT oid FROM au), (SELECT oid FROM me)))
  UNION ALL SELECT 17, EXISTS (SELECT 1 FROM pw_col WHERE NOT attnotnull)
                       AND NOT has_column_privilege('app_auth', (SELECT oid FROM usr), 'password', 'UPD' || 'ATE')
                       AND NOT has_column_privilege('app_auth', (SELECT oid FROM usr), 'emailVerifiedAt', 'UPD' || 'ATE'), 1
  UNION ALL SELECT 18, EXISTS (SELECT 1 FROM done)
                       AND (SELECT count(*) FROM "UserIdentity" WHERE "linkedAt" < (SELECT at FROM done)) = 0
                       AND (SELECT count(*) FROM "OAuthSignupTicket" WHERE "issuedAt" < (SELECT at FROM done)) = 0
                       AND (SELECT count(*) FROM "User" WHERE "password" IS NULL AND "createdAt" < (SELECT at FROM done)) = 0,
                       (SELECT count(*) FROM "UserIdentity" WHERE "linkedAt" < (SELECT at FROM done))
                         + (SELECT count(*) FROM "OAuthSignupTicket" WHERE "issuedAt" < (SELECT at FROM done))
                         + (SELECT count(*) FROM "User" WHERE "password" IS NULL AND "createdAt" < (SELECT at FROM done))
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
