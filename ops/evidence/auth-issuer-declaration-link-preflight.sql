-- ============================================================================
-- auth-issuer-declaration-link-preflight.sql
--
-- Read-only PREFLIGHT for 20261126090000_auth_issuer_declaration_link: the premises it builds on, checked
-- in the target database BEFORE it is applied. Every check must PASS before the release applies it. After it
-- is applied, exactly checks 1, 3, 4, 5 and 6 turn FAIL (they describe "not there yet").
-- OUTPUT: n | result (PASS/FAIL) | observed_count. Guard-clean: SELECT only.
-- ============================================================================
\echo '== auth issuer-declaration link preflight: legend (n -> check) =='
\echo ' 1 AuthEmailToken purpose is exactly EMAIL_VERIFY / PASSWORD_RESET / LINK_GOOGLE (observed = matching checks)'
\echo ' 2 20261102090000_oauth_identity_link is finished (observed = finished rows)'
\echo ' 3 AuthEmailToken has no bindingSha256 column yet (observed = such columns)'
\echo ' 4 neither function exists yet (observed = of 2)'
\echo ' 5 no AuthEmailToken_declaration_binding check yet (observed = such checks)'
\echo ' 6 20261126090000 is not in the ledger (observed = rows)'
\echo ' 7 the roles exist: app_auth, app_runtime (observed = of 2)'
\echo ' 8 the columns it reads exist: User.email, User.businessId, Business.deletionRequestedAt, Business.deletedAt (observed = of 4)'
\echo ' 9 no token has a purpose outside the three, so the widened check holds for every row (observed = rows)'
\echo '10 auth_email_token_check exists and app_auth executes it (the status reader it reuses) (observed = of 1)'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
aet AS (SELECT c.oid FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'AuthEmailToken' AND c.relkind = 'r'),
usr AS (SELECT c.oid FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'User' AND c.relkind = 'r'),
biz AS (SELECT c.oid FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'Business' AND c.relkind = 'r'),
purpose AS (SELECT pg_get_constraintdef(k.oid) AS def FROM pg_constraint k
            WHERE k.conrelid = (SELECT oid FROM aet) AND k.conname = 'AuthEmailToken_purpose' AND k.contype = 'c'),
chk AS (SELECT p.oid FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pub) AND p.proname = 'auth_email_token_check'),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM purpose WHERE def LIKE '%''EMAIL_VERIFY''%' AND def LIKE '%''PASSWORD_RESET''%'
                                             AND def LIKE '%''LINK_GOOGLE''%' AND def NOT LIKE '%ISSUER_DECLARATION%') = 1,
            (SELECT count(*) FROM purpose WHERE def LIKE '%''LINK_GOOGLE''%' AND def NOT LIKE '%ISSUER_DECLARATION%')
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261102090000_oauth_identity_link'
                        AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261102090000_oauth_identity_link'
                        AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 3, (SELECT count(*) FROM pg_attribute a WHERE a.attrelid = (SELECT oid FROM aet) AND a.attname = 'bindingSha256' AND NOT a.attisdropped) = 0,
                      (SELECT count(*) FROM pg_attribute a WHERE a.attrelid = (SELECT oid FROM aet) AND a.attname = 'bindingSha256' AND NOT a.attisdropped)
  UNION ALL SELECT 4, (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pub)
                        AND p.proname IN ('auth_issuer_declaration_issue', 'auth_issuer_declaration_consume')) = 0,
                      (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pub)
                        AND p.proname IN ('auth_issuer_declaration_issue', 'auth_issuer_declaration_consume'))
  UNION ALL SELECT 5, (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM aet) AND k.conname = 'AuthEmailToken_declaration_binding') = 0,
                      (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM aet) AND k.conname = 'AuthEmailToken_declaration_binding')
  UNION ALL SELECT 6, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261126090000_auth_issuer_declaration_link') = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261126090000_auth_issuer_declaration_link')
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_roles WHERE rolname IN ('app_auth', 'app_runtime')) = 2,
                      (SELECT count(*) FROM pg_roles WHERE rolname IN ('app_auth', 'app_runtime'))
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_attribute a WHERE NOT a.attisdropped AND (
                          (a.attrelid = (SELECT oid FROM usr) AND a.attname IN ('email', 'businessId'))
                       OR (a.attrelid = (SELECT oid FROM biz) AND a.attname IN ('deletionRequestedAt', 'deletedAt')))) = 4,
                      (SELECT count(*) FROM pg_attribute a WHERE NOT a.attisdropped AND (
                          (a.attrelid = (SELECT oid FROM usr) AND a.attname IN ('email', 'businessId'))
                       OR (a.attrelid = (SELECT oid FROM biz) AND a.attname IN ('deletionRequestedAt', 'deletedAt'))))
  UNION ALL SELECT 9, (SELECT count(*) FROM "AuthEmailToken" WHERE "purpose" NOT IN ('EMAIL_VERIFY', 'PASSWORD_RESET', 'LINK_GOOGLE')) = 0,
                      (SELECT count(*) FROM "AuthEmailToken" WHERE "purpose" NOT IN ('EMAIL_VERIFY', 'PASSWORD_RESET', 'LINK_GOOGLE'))
  UNION ALL SELECT 10, (SELECT count(*) FROM chk WHERE has_function_privilege('app_auth', oid, 'EXECUTE')) = 1,
                       (SELECT count(*) FROM chk WHERE has_function_privilege('app_auth', oid, 'EXECUTE'))
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
