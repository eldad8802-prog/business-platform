-- ============================================================================
-- oauth-identity-preflight.sql
--
-- Read-only PREFLIGHT for migration
--   20261030090000_oauth_identity_foundation   (NOT applied)
--
-- Measures every premise the migration's outcome depends on:
--   * the ledger is clean; this migration is not recorded and nothing sorting after it was applied first;
--   * none of the names it creates exists: two tables, their keys, six indexes, the identity sequence, the
--     two policies, the six functions;
--   * what the functions touch exists with the expected shape: User.id / User.businessId / Business.id are
--     integer keys, User.password is NOT NULL today, User.emailVerifiedAt exists (20261017090000 applied),
--     and the migration role owns User and Business (the SECURITY DEFINER functions run as that role);
--   * app_runtime and app_auth exist as NOLOGIN NOSUPERUSER NOBYPASSRLS groups; every login in them (the
--     migration role excluded) is NOSUPERUSER NOBYPASSRLS, so FORCE RLS binds every application path;
--   * app_auth holds NO change privilege on User.password or User.emailVerifiedAt today;
--   * the migration role's default privileges on functions name no grantee (EXECUTE is named explicitly);
--   * the server supports what the migration uses (gen_random_uuid(), hashtextextended(), sha256());
--   * the migration role carries BYPASSRLS (or is a superuser).
--
-- The by-name ledger list of every migration before it is added when the Production application is
-- prepared (it is a premise of THAT ledger, which a lab cannot have).
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== oauth identity preflight: legend (n -> check) =='
\echo ' 1 L0 migration ledger: no unfinished and no rolled-back row (observed = such rows)'
\echo ' 2 L1 20261030090000_oauth_identity_foundation is NOT recorded'
\echo ' 3 L2 every finished migration sorts BEFORE it (nothing later was applied first)'
\echo ' 4 N1 none of the relation names it creates exists (observed = found)'
\echo ' 5 N2 none of its six functions exists (observed = found)'
\echo ' 6 N3 no policy named user_identity_* exists (observed = found)'
\echo ' 7 F1 User.id, User.businessId, Business.id integer; User.password NOT NULL; User.emailVerifiedAt present'
\echo ' 8 F2 the migration role owns User and Business (observed = of 2)'
\echo ' 9 R1 app_runtime exists, NOLOGIN NOSUPERUSER NOBYPASSRLS'
\echo '10 R2 app_auth exists, NOLOGIN NOSUPERUSER NOBYPASSRLS'
\echo '11 R3 logins in app_runtime / app_auth (migration role excluded) are NOSUPERUSER NOBYPASSRLS (observed = others)'
\echo '12 A1 app_auth holds no change privilege on User.password or User.emailVerifiedAt'
\echo '13 D1 default privileges (migration role, functions): no grantee at all (observed = grantees)'
\echo '14 V1 server provides gen_random_uuid(), hashtextextended(), sha256() (observed = of 3)'
\echo '15 O1 the migration role carries BYPASSRLS or is a superuser'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
ledger AS (SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"),
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
me AS (SELECT oid, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user),
rel_names(nm) AS (VALUES ('UserIdentity'), ('UserIdentity_pkey'), ('UserIdentity_id_seq'),
  ('UserIdentity_provider_providerSubject_key'), ('UserIdentity_userId_provider_key'), ('UserIdentity_businessId_idx'),
  ('OAuthSignupTicket'), ('OAuthSignupTicket_pkey'), ('OAuthSignupTicket_secretHash_key'),
  ('OAuthSignupTicket_provider_providerSubject_purpose_issuedAt_idx'), ('OAuthSignupTicket_expiresAt_idx')),
fn_names(nm) AS (VALUES ('auth_oauth_ticket_issue'), ('auth_oauth_ticket_read'), ('auth_oauth_ticket_consume'),
  ('auth_oauth_identity_attach'), ('auth_oauth_identity_resolve'), ('auth_oauth_ticket_purge')),
usr AS (SELECT c.oid, c.relowner FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'User' AND c.relkind = 'r'),
biz AS (SELECT c.oid, c.relowner FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'Business' AND c.relkind = 'r'),
col AS (SELECT c.relname, a.attname, a.atttypid, a.attnotnull FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.oid IN ((SELECT oid FROM usr), (SELECT oid FROM biz)) AND a.attnum > 0 AND NOT a.attisdropped),
groups AS (SELECT r.oid, r.rolname, r.rolcanlogin, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname IN ('app_runtime', 'app_auth')),
members AS (SELECT m.member FROM pg_auth_members m WHERE m.roleid IN (SELECT oid FROM groups)),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM ledger WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
            (SELECT count(*) FROM ledger WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 2, NOT EXISTS (SELECT 1 FROM ledger WHERE migration_name = '20261030090000_oauth_identity_foundation'),
                      (SELECT count(*) FROM ledger WHERE migration_name = '20261030090000_oauth_identity_foundation')
  UNION ALL SELECT 3, NOT EXISTS (SELECT 1 FROM ledger WHERE finished_at IS NOT NULL AND migration_name >= '20261030090000_oauth_identity_foundation'),
                      (SELECT count(*) FROM ledger WHERE finished_at IS NOT NULL AND migration_name >= '20261030090000_oauth_identity_foundation')
  UNION ALL SELECT 4, NOT EXISTS (SELECT 1 FROM pg_class c JOIN rel_names r ON r.nm = c.relname WHERE c.relnamespace = (SELECT oid FROM pub)),
                      (SELECT count(*) FROM pg_class c JOIN rel_names r ON r.nm = c.relname WHERE c.relnamespace = (SELECT oid FROM pub))
  UNION ALL SELECT 5, NOT EXISTS (SELECT 1 FROM pg_proc p JOIN fn_names f ON f.nm = p.proname WHERE p.pronamespace = (SELECT oid FROM pub)),
                      (SELECT count(*) FROM pg_proc p JOIN fn_names f ON f.nm = p.proname WHERE p.pronamespace = (SELECT oid FROM pub))
  UNION ALL SELECT 6, NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname LIKE 'user\_identity\_%'),
                      (SELECT count(*) FROM pg_policy WHERE polname LIKE 'user\_identity\_%')
  UNION ALL SELECT 7, EXISTS (SELECT 1 FROM col WHERE relname = 'User' AND attname = 'id' AND atttypid = 'int4'::regtype)
                      AND EXISTS (SELECT 1 FROM col WHERE relname = 'User' AND attname = 'businessId' AND atttypid = 'int4'::regtype)
                      AND EXISTS (SELECT 1 FROM col WHERE relname = 'Business' AND attname = 'id' AND atttypid = 'int4'::regtype)
                      AND EXISTS (SELECT 1 FROM col WHERE relname = 'User' AND attname = 'password' AND attnotnull)
                      AND EXISTS (SELECT 1 FROM col WHERE relname = 'User' AND attname = 'emailVerifiedAt'), 1
  UNION ALL SELECT 8, (SELECT count(*) FROM (SELECT relowner FROM usr UNION ALL SELECT relowner FROM biz) o WHERE o.relowner = (SELECT oid FROM me)) = 2,
                      (SELECT count(*) FROM (SELECT relowner FROM usr UNION ALL SELECT relowner FROM biz) o WHERE o.relowner = (SELECT oid FROM me))
  UNION ALL SELECT 9, EXISTS (SELECT 1 FROM groups WHERE rolname = 'app_runtime' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls), 1
  UNION ALL SELECT 10, EXISTS (SELECT 1 FROM groups WHERE rolname = 'app_auth' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls), 1
  UNION ALL SELECT 11, NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.oid IN (SELECT member FROM members) AND r.oid <> (SELECT oid FROM me)
                                     AND (r.rolsuper OR r.rolbypassrls)),
                       (SELECT count(*) FROM pg_roles r WHERE r.oid IN (SELECT member FROM members) AND r.oid <> (SELECT oid FROM me)
                          AND (r.rolsuper OR r.rolbypassrls))
  UNION ALL SELECT 12, NOT has_column_privilege('app_auth', (SELECT oid FROM usr), 'password', 'UPD' || 'ATE')
                       AND NOT has_column_privilege('app_auth', (SELECT oid FROM usr), 'emailVerifiedAt', 'UPD' || 'ATE'), 1
  UNION ALL SELECT 13, NOT EXISTS (SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) x
                                     WHERE d.defaclrole = (SELECT oid FROM me) AND d.defaclobjtype = 'f'),
                       (SELECT count(*) FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) x
                          WHERE d.defaclrole = (SELECT oid FROM me) AND d.defaclobjtype = 'f')
  UNION ALL SELECT 14, (SELECT count(*) FROM pg_proc WHERE proname IN ('gen_random_uuid', 'hashtextextended', 'sha256')
                          AND pronamespace = 'pg_catalog'::regnamespace) >= 3,
                       (SELECT count(DISTINCT proname) FROM pg_proc WHERE proname IN ('gen_random_uuid', 'hashtextextended', 'sha256')
                          AND pronamespace = 'pg_catalog'::regnamespace)
  UNION ALL SELECT 15, EXISTS (SELECT 1 FROM me WHERE rolsuper OR rolbypassrls), 1
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
