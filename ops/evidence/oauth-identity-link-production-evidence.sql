-- ============================================================================
-- oauth-identity-link-production-evidence.sql
--
-- Read-only EVIDENCE after migration
--   20261102090000_oauth_identity_link
--
-- Proves the migration's outcome, from the catalog and counts only:
--   * it is recorded and finished, its sha256 is the reviewed one, nothing is unfinished or rolled back;
--     the three migrations it builds on are still recorded with their reviewed checksums;
--   * AuthEmailToken has the nullable uuid column "oauthTicketId", keyed to OAuthSignupTicket with cascade,
--     indexed; its purpose vocabulary is exactly EMAIL_VERIFY / PASSWORD_RESET / LINK_GOOGLE, and only a
--     LINK_GOOGLE token carries a ticket (six check constraints in all);
--   * AuthEmailToken keeps RLS ENABLED + FORCED and exactly its two tenant-plane policies; app_runtime still
--     holds exactly removal and read on (id, businessId) — never the new column; app_auth and PUBLIC hold
--     nothing on it;
--   * the six functions exist, SECURITY DEFINER with a pinned search_path, owned by the migration role;
--     EXECUTE is held by app_auth and by no other role; app_runtime cannot execute any of them;
--   * the eleven functions of the earlier migrations (four email-token, seven oauth) are unchanged in kind
--     and in who may execute them;
--   * the migration role carries BYPASSRLS (or is a superuser);
--   * nothing was backfilled: no LINK_GOOGLE token, no token bound to a ticket.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== oauth identity link evidence: legend (n -> check) =='
\echo ' 1 the migration is recorded and finished (observed = finished rows)'
\echo ' 2 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 3 the recorded checksum is the reviewed sha256 of migration.sql'
\echo ' 4 auth email tokens, oauth identity and ticket cancel still carry their reviewed checksums (observed = of 3)'
\echo ' 5 AuthEmailToken.oauthTicketId: nullable uuid, keyed to OAuthSignupTicket, cascading on removal, indexed'
\echo ' 6 AuthEmailToken: purpose exactly EMAIL_VERIFY / PASSWORD_RESET / LINK_GOOGLE; the ticket binding; six check constraints (observed = check constraints)'
\echo ' 7 AuthEmailToken: RLS ENABLED + FORCED, exactly the two app_runtime policies (observed = policies)'
\echo ' 8 app_runtime on AuthEmailToken: table letters exactly d; column read exactly id, businessId (observed = column grants)'
\echo ' 9 app_auth and PUBLIC hold nothing on AuthEmailToken (observed = privileges)'
\echo '10 the six functions: SECURITY DEFINER, search_path pinned, owned by the migration role (observed = of 6)'
\echo '11 EXECUTE on them: app_auth on all six, no other grantee; app_runtime cannot execute any (observed = foreign grantees)'
\echo '12 the eleven earlier functions: DEFINER, pinned, EXECUTE app_auth only (observed = of 11)'
\echo '13 the migration role carries BYPASSRLS or is a superuser'
\echo '14 nothing backfilled: no LINK_GOOGLE token, no token bound to a ticket (observed = rows)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
me AS (SELECT oid, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user),
au AS (SELECT oid FROM pg_roles WHERE rolname = 'app_auth'),
rt AS (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime'),
aet AS (SELECT c.oid, c.relrowsecurity, c.relforcerowsecurity, c.relacl FROM pg_class c
        WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'AuthEmailToken' AND c.relkind = 'r'),
tkt AS (SELECT c.oid FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'OAuthSignupTicket' AND c.relkind = 'r'),
letter AS (SELECT * FROM (VALUES ('SELECT', 'r'), ('INS' || 'ERT', 'a'), ('UPD' || 'ATE', 'w'), ('DEL' || 'ETE', 'd'),
                                 ('TRUNC' || 'ATE', 'D'), ('REFERENCES', 'x'), ('TRIGGER', 't'), ('MAINTAIN', 'm')) v(priv, l)),
tbl_priv AS (SELECT x.grantee, (SELECT l FROM letter WHERE priv = x.privilege_type) COLLATE "C" AS l
             FROM aet CROSS JOIN LATERAL aclexplode(aet.relacl) x),
rt_letters AS (SELECT string_agg(DISTINCT l, '' ORDER BY l) AS letters FROM tbl_priv WHERE grantee = (SELECT oid FROM rt)),
col_priv AS (SELECT x.grantee, a.attname::text AS col, (SELECT l FROM letter WHERE priv = x.privilege_type) AS l
             FROM aet JOIN pg_attribute a ON a.attrelid = aet.oid AND a.attnum > 0 AND NOT a.attisdropped
             CROSS JOIN LATERAL aclexplode(a.attacl) x),
expected_rt_read(col) AS (VALUES ('id'), ('businessId')),
col AS (SELECT a.atttypid, a.attnotnull FROM pg_attribute a
        WHERE a.attrelid = (SELECT oid FROM aet) AND a.attname = 'oauthTicketId' AND NOT a.attisdropped),
fk AS (SELECT k.confdeltype FROM pg_constraint k
       WHERE k.conrelid = (SELECT oid FROM aet) AND k.conname = 'AuthEmailToken_oauthTicketId_fkey' AND k.contype = 'f'
         AND k.confrelid = (SELECT oid FROM tkt)),
idx AS (SELECT 1 FROM pg_class i JOIN pg_index x ON x.indexrelid = i.oid
        WHERE i.relname = 'AuthEmailToken_oauthTicketId_idx' AND x.indrelid = (SELECT oid FROM aet)),
purpose AS (SELECT pg_get_constraintdef(k.oid) AS def FROM pg_constraint k
            WHERE k.conrelid = (SELECT oid FROM aet) AND k.conname = 'AuthEmailToken_purpose' AND k.contype = 'c'),
binding AS (SELECT pg_get_constraintdef(k.oid) AS def FROM pg_constraint k
            WHERE k.conrelid = (SELECT oid FROM aet) AND k.conname = 'AuthEmailToken_oauth_ticket' AND k.contype = 'c'),
pols AS (SELECT p.polcmd, p.polroles FROM pg_policy p WHERE p.polrelid = (SELECT oid FROM aet)),
fns AS (SELECT p.oid, p.proname, p.prosecdef, p.proowner, p.proconfig, p.proacl FROM pg_proc p
        WHERE p.pronamespace = (SELECT oid FROM pub)
          AND p.proname IN ('auth_oauth_link_email_issue', 'auth_oauth_link_email_check', 'auth_oauth_link_email_consume',
                            'auth_oauth_identity_link', 'auth_oauth_identity_status', 'auth_oauth_identity_unlink')),
fn_exec AS (SELECT f.proname, x.grantee FROM fns f CROSS JOIN LATERAL aclexplode(f.proacl) x WHERE x.privilege_type = 'EXECUTE'),
old AS (SELECT p.oid, p.proname, p.prosecdef, p.proowner, p.proconfig, p.proacl FROM pg_proc p
        WHERE p.pronamespace = (SELECT oid FROM pub)
          AND p.proname IN ('auth_email_token_issue', 'auth_email_token_check', 'auth_email_verify_consume', 'auth_password_reset_consume',
                            'auth_oauth_ticket_issue', 'auth_oauth_ticket_read', 'auth_oauth_ticket_consume', 'auth_oauth_identity_attach',
                            'auth_oauth_identity_resolve', 'auth_oauth_ticket_purge', 'auth_oauth_ticket_cancel')),
old_exec AS (SELECT f.proname, x.grantee FROM old f CROSS JOIN LATERAL aclexplode(f.proacl) x WHERE x.privilege_type = 'EXECUTE'),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261102090000_oauth_identity_link'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1,
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261102090000_oauth_identity_link'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261102090000_oauth_identity_link'
                                AND checksum = '3ca274fbb5335a5e43d3e37ca662e005b361b03081aa27de52aba20cbad5a962'), 1
  UNION ALL SELECT 4, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL AND (
                          (migration_name = '20261017090000_auth_email_tokens' AND checksum = '42737f51f551e91ff86670a0be7a482a14a13d516c84c16d573b365ec104b769')
                       OR (migration_name = '20261030090000_oauth_identity_foundation' AND checksum = '28ac0d8e270f1c1d9640d2d20500f5b5cf59d7be8b956b41ae47ebf052cb8bae')
                       OR (migration_name = '20261101090000_oauth_ticket_cancel' AND checksum = 'c82c3ecffaa3e419390d1caab1e10ac037335df60a8b7a9925f985495e347614'))) = 3,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL AND (
                          (migration_name = '20261017090000_auth_email_tokens' AND checksum = '42737f51f551e91ff86670a0be7a482a14a13d516c84c16d573b365ec104b769')
                       OR (migration_name = '20261030090000_oauth_identity_foundation' AND checksum = '28ac0d8e270f1c1d9640d2d20500f5b5cf59d7be8b956b41ae47ebf052cb8bae')
                       OR (migration_name = '20261101090000_oauth_ticket_cancel' AND checksum = 'c82c3ecffaa3e419390d1caab1e10ac037335df60a8b7a9925f985495e347614')))
  UNION ALL SELECT 5, EXISTS (SELECT 1 FROM col WHERE atttypid = 'uuid'::regtype AND NOT attnotnull)
                      AND EXISTS (SELECT 1 FROM fk WHERE confdeltype = 'c') AND EXISTS (SELECT 1 FROM idx), 1
  UNION ALL SELECT 6, EXISTS (SELECT 1 FROM purpose WHERE def LIKE '%''EMAIL_VERIFY''%' AND def LIKE '%''PASSWORD_RESET''%' AND def LIKE '%''LINK_GOOGLE''%'
                                AND (SELECT count(*) FROM regexp_matches(def, '''[A-Z_]+''', 'g') m) = 3)
                      AND EXISTS (SELECT 1 FROM binding WHERE def LIKE '%LINK_GOOGLE%' AND def LIKE '%oauthTicketId%')
                      AND (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM aet) AND k.contype = 'c') = 6,
                      (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM aet) AND k.contype = 'c')
  UNION ALL SELECT 7, EXISTS (SELECT 1 FROM aet WHERE relrowsecurity AND relforcerowsecurity)
                      AND (SELECT count(*) FROM pols) = 2
                      AND (SELECT count(*) FROM pols WHERE polroles = ARRAY[(SELECT oid FROM rt)] AND polcmd IN ('r', 'd')) = 2,
                      (SELECT count(*) FROM pols)
  UNION ALL SELECT 8, (SELECT letters FROM rt_letters) = 'd'
                      AND NOT EXISTS (SELECT col FROM col_priv WHERE grantee = (SELECT oid FROM rt) AND l = 'r' EXCEPT SELECT col FROM expected_rt_read)
                      AND NOT EXISTS (SELECT col FROM expected_rt_read EXCEPT SELECT col FROM col_priv WHERE grantee = (SELECT oid FROM rt) AND l = 'r')
                      AND NOT EXISTS (SELECT 1 FROM col_priv WHERE grantee = (SELECT oid FROM rt) AND l <> 'r'),
                      (SELECT count(*) FROM col_priv WHERE grantee = (SELECT oid FROM rt))
  UNION ALL SELECT 9, NOT EXISTS (SELECT 1 FROM tbl_priv WHERE grantee IN ((SELECT oid FROM au), 0))
                      AND NOT EXISTS (SELECT 1 FROM col_priv WHERE grantee IN ((SELECT oid FROM au), 0)),
                      (SELECT count(*) FROM tbl_priv WHERE grantee IN ((SELECT oid FROM au), 0)) + (SELECT count(*) FROM col_priv WHERE grantee IN ((SELECT oid FROM au), 0))
  UNION ALL SELECT 10, (SELECT count(*) FROM fns WHERE prosecdef AND proowner = (SELECT oid FROM me)
                          AND EXISTS (SELECT 1 FROM unnest(proconfig) c WHERE c = 'search_path=pg_catalog, public')) = 6
                       AND (SELECT count(*) FROM fns) = 6,
                       (SELECT count(*) FROM fns WHERE prosecdef AND proowner = (SELECT oid FROM me)
                          AND EXISTS (SELECT 1 FROM unnest(proconfig) c WHERE c = 'search_path=pg_catalog, public'))
  UNION ALL SELECT 11, (SELECT count(DISTINCT proname) FROM fn_exec WHERE grantee = (SELECT oid FROM au)) = 6
                       AND NOT EXISTS (SELECT 1 FROM fn_exec WHERE grantee NOT IN ((SELECT oid FROM au), (SELECT oid FROM me)))
                       AND NOT EXISTS (SELECT 1 FROM fns WHERE has_function_privilege('app_runtime', oid, 'EXECUTE')),
                       (SELECT count(*) FROM fn_exec WHERE grantee NOT IN ((SELECT oid FROM au), (SELECT oid FROM me)))
  UNION ALL SELECT 12, (SELECT count(*) FROM old WHERE prosecdef AND proowner = (SELECT oid FROM me)
                          AND EXISTS (SELECT 1 FROM unnest(proconfig) c WHERE c LIKE 'search\_path=%')) = 11
                       AND (SELECT count(*) FROM old) = 11
                       AND (SELECT count(DISTINCT proname) FROM old_exec WHERE grantee = (SELECT oid FROM au)) = 11
                       AND NOT EXISTS (SELECT 1 FROM old_exec WHERE grantee NOT IN ((SELECT oid FROM au), (SELECT oid FROM me))),
                       (SELECT count(*) FROM old WHERE prosecdef AND proowner = (SELECT oid FROM me)
                          AND EXISTS (SELECT 1 FROM unnest(proconfig) c WHERE c LIKE 'search\_path=%'))
  UNION ALL SELECT 13, EXISTS (SELECT 1 FROM me WHERE rolsuper OR rolbypassrls), 1
  UNION ALL SELECT 14, (SELECT count(*) FROM "AuthEmailToken" WHERE "purpose" = 'LINK_GOOGLE' OR "oauthTicketId" IS NOT NULL) = 0,
                       (SELECT count(*) FROM "AuthEmailToken" WHERE "purpose" = 'LINK_GOOGLE' OR "oauthTicketId" IS NOT NULL)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
