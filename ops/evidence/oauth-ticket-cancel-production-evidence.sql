-- ============================================================================
-- oauth-ticket-cancel-production-evidence.sql
--
-- Read-only EVIDENCE after migration
--   20261101090000_oauth_ticket_cancel
--
-- Proves the migration's outcome, from the catalog and counts only:
--   * it is recorded and finished, its sha256 is the reviewed one, nothing is unfinished or rolled back;
--     20261030090000_oauth_identity_foundation is still recorded with its own reviewed sha256;
--   * "OAuthSignupTicket_end" admits exactly CONSUMED, SUPERSEDED and CANCELLED; the table still carries
--     its nine check constraints, RLS ENABLED + FORCED and no policy;
--   * auth_oauth_ticket_cancel(text, text) exists once, returns text, VOLATILE, SECURITY DEFINER with a
--     pinned search_path, owned by the migration role;
--   * EXECUTE on it: app_auth holds it; no other grantee besides the owner; app_runtime cannot execute it;
--   * app_auth, app_runtime and PUBLIC still hold nothing on the ticket table;
--   * the six functions of 20261030090000 are unchanged in kind and in who may execute them;
--   * the migration role carries BYPASSRLS (or is a superuser), so the definer function sees the rows;
--   * nothing was backfilled: no ticket is CANCELLED yet (the route that cancels ships after this).
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== oauth ticket cancel evidence: legend (n -> check) =='
\echo ' 1 the migration is recorded and finished (observed = finished rows)'
\echo ' 2 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 3 the recorded checksum is the reviewed sha256 of migration.sql'
\echo ' 4 20261030090000_oauth_identity_foundation is still recorded with its reviewed sha256'
\echo ' 5 OAuthSignupTicket_end admits CONSUMED, SUPERSEDED and CANCELLED, nothing else (observed = such constraints)'
\echo ' 6 OAuthSignupTicket: nine check constraints, RLS ENABLED + FORCED, no policy (observed = check constraints)'
\echo ' 7 auth_oauth_ticket_cancel: one function, (text, text) returns text, VOLATILE (observed = functions of that name)'
\echo ' 8 …SECURITY DEFINER, search_path pinned, owned by the migration role'
\echo ' 9 EXECUTE on it: app_auth holds it; no other grantee besides the owner (observed = foreign grantees)'
\echo '10 app_runtime cannot execute it; app_auth can (effective privileges)'
\echo '11 app_auth, app_runtime and PUBLIC hold nothing on OAuthSignupTicket (observed = privileges)'
\echo '12 the six functions of 20261030090000: DEFINER, pinned, EXECUTE app_auth only (observed = of 6)'
\echo '13 the migration role carries BYPASSRLS or is a superuser'
\echo '14 nothing backfilled: no ticket is CANCELLED (observed = rows)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
me AS (SELECT oid, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user),
au AS (SELECT oid FROM pg_roles WHERE rolname = 'app_auth'),
rt AS (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime'),
tkt AS (SELECT c.oid, c.relrowsecurity, c.relforcerowsecurity, c.relacl FROM pg_class c
        WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'OAuthSignupTicket' AND c.relkind = 'r'),
endc AS (SELECT pg_get_constraintdef(k.oid) AS def FROM pg_constraint k
         WHERE k.conrelid = (SELECT oid FROM tkt) AND k.conname = 'OAuthSignupTicket_end' AND k.contype = 'c'),
cancel AS (SELECT p.oid, p.prosecdef, p.proowner, p.proconfig, p.proacl, p.provolatile, p.prorettype,
                  pg_get_function_identity_arguments(p.oid) AS args
           FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pub) AND p.proname = 'auth_oauth_ticket_cancel'),
cancel_exec AS (SELECT x.grantee FROM cancel c CROSS JOIN LATERAL aclexplode(c.proacl) x WHERE x.privilege_type = 'EXECUTE'),
fns AS (SELECT p.oid, p.proname, p.prosecdef, p.proowner, p.proconfig, p.proacl FROM pg_proc p
        WHERE p.pronamespace = (SELECT oid FROM pub)
          AND p.proname IN ('auth_oauth_ticket_issue', 'auth_oauth_ticket_read', 'auth_oauth_ticket_consume',
                            'auth_oauth_identity_attach', 'auth_oauth_identity_resolve', 'auth_oauth_ticket_purge')),
fn_exec AS (SELECT f.proname, x.grantee FROM fns f CROSS JOIN LATERAL aclexplode(f.proacl) x WHERE x.privilege_type = 'EXECUTE'),
plane AS (SELECT oid FROM au UNION ALL SELECT oid FROM rt UNION ALL SELECT 0::oid),
tkt_priv AS (SELECT x.grantee FROM tkt CROSS JOIN LATERAL aclexplode(tkt.relacl) x),
tkt_col AS (SELECT x.grantee FROM tkt JOIN pg_attribute a ON a.attrelid = tkt.oid AND a.attnum > 0 AND NOT a.attisdropped
            CROSS JOIN LATERAL aclexplode(a.attacl) x),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261101090000_oauth_ticket_cancel'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1,
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261101090000_oauth_ticket_cancel'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261101090000_oauth_ticket_cancel'
                                AND checksum = 'c82c3ecffaa3e419390d1caab1e10ac037335df60a8b7a9925f985495e347614'), 1
  UNION ALL SELECT 4, EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261030090000_oauth_identity_foundation'
                                AND finished_at IS NOT NULL AND rolled_back_at IS NULL
                                AND checksum = '28ac0d8e270f1c1d9640d2d20500f5b5cf59d7be8b956b41ae47ebf052cb8bae'), 1
  UNION ALL SELECT 5, EXISTS (SELECT 1 FROM endc WHERE def LIKE '%''CONSUMED''%' AND def LIKE '%''SUPERSEDED''%' AND def LIKE '%''CANCELLED''%'
                                AND (SELECT count(*) FROM regexp_matches(def, '''[A-Z_]+''', 'g') m) = 3),
                      (SELECT count(*) FROM endc)
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM tkt) AND k.contype = 'c') = 9
                      AND EXISTS (SELECT 1 FROM tkt WHERE relrowsecurity AND relforcerowsecurity)
                      AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = (SELECT oid FROM tkt)),
                      (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM tkt) AND k.contype = 'c')
  UNION ALL SELECT 7, (SELECT count(*) FROM cancel) = 1
                      AND EXISTS (SELECT 1 FROM cancel WHERE args = 'p_secret text, p_purpose text' AND prorettype = 'text'::regtype AND provolatile = 'v'),
                      (SELECT count(*) FROM cancel)
  UNION ALL SELECT 8, EXISTS (SELECT 1 FROM cancel WHERE prosecdef AND proowner = (SELECT oid FROM me)
                                AND EXISTS (SELECT 1 FROM unnest(proconfig) c WHERE c = 'search_path=pg_catalog, public')), 1
  UNION ALL SELECT 9, EXISTS (SELECT 1 FROM cancel_exec WHERE grantee = (SELECT oid FROM au))
                      AND NOT EXISTS (SELECT 1 FROM cancel_exec WHERE grantee NOT IN ((SELECT oid FROM au), (SELECT oid FROM me))),
                      (SELECT count(*) FROM cancel_exec WHERE grantee NOT IN ((SELECT oid FROM au), (SELECT oid FROM me)))
  UNION ALL SELECT 10, EXISTS (SELECT 1 FROM cancel)
                       AND has_function_privilege('app_auth', (SELECT oid FROM cancel), 'EXECUTE')
                       AND NOT has_function_privilege('app_runtime', (SELECT oid FROM cancel), 'EXECUTE'), 1
  UNION ALL SELECT 11, NOT EXISTS (SELECT 1 FROM tkt_priv WHERE grantee IN (SELECT oid FROM plane))
                       AND NOT EXISTS (SELECT 1 FROM tkt_col WHERE grantee IN (SELECT oid FROM plane)),
                       (SELECT count(*) FROM tkt_priv WHERE grantee IN (SELECT oid FROM plane)) + (SELECT count(*) FROM tkt_col WHERE grantee IN (SELECT oid FROM plane))
  UNION ALL SELECT 12, (SELECT count(*) FROM fns WHERE prosecdef AND proowner = (SELECT oid FROM me)
                          AND EXISTS (SELECT 1 FROM unnest(proconfig) c WHERE c LIKE 'search\_path=%')) = 6
                       AND (SELECT count(*) FROM fns) = 6
                       AND (SELECT count(DISTINCT proname) FROM fn_exec WHERE grantee = (SELECT oid FROM au)) = 6
                       AND NOT EXISTS (SELECT 1 FROM fn_exec WHERE grantee NOT IN ((SELECT oid FROM au), (SELECT oid FROM me))),
                       (SELECT count(*) FROM fns WHERE prosecdef AND proowner = (SELECT oid FROM me)
                          AND EXISTS (SELECT 1 FROM unnest(proconfig) c WHERE c LIKE 'search\_path=%'))
  UNION ALL SELECT 13, EXISTS (SELECT 1 FROM me WHERE rolsuper OR rolbypassrls), 1
  UNION ALL SELECT 14, (SELECT count(*) FROM "OAuthSignupTicket" WHERE "endedReason" = 'CANCELLED') = 0,
                       (SELECT count(*) FROM "OAuthSignupTicket" WHERE "endedReason" = 'CANCELLED')
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
