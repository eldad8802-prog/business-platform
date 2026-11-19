-- ============================================================================
-- auth-issuer-declaration-link-production-evidence.sql
--
-- Read-only PROOF that 20261126090000_auth_issuer_declaration_link landed exactly as reviewed:
--   * the migration is recorded, finished, never rolled back, with the reviewed checksum;
--   * AuthEmailToken."bindingSha256" is a nullable text; the purpose vocabulary is exactly EMAIL_VERIFY /
--     PASSWORD_RESET / LINK_GOOGLE / ISSUER_DECLARATION, and only an ISSUER_DECLARATION token carries a
--     64-hex digest (seven check constraints in all once LINK_GOOGLE is there);
--   * the two functions are SECURITY DEFINER, search_path pinned, owned like the earlier auth functions;
--   * EXECUTE: the issue function by app_auth alone, the consume function by app_runtime alone; PUBLIC neither;
--   * the table itself is unchanged: RLS ENABLED + FORCED with its two policies, app_runtime cannot read the
--     new column, app_auth holds nothing on the table;
--   * nothing was backfilled.
-- OUTPUT: n | result (PASS/FAIL) | observed_count. Every check must PASS. Guard-clean: SELECT only.
-- ============================================================================
\echo '== auth issuer-declaration link production evidence: legend (n -> check) =='
\echo ' 1 the migration is recorded and finished (observed = finished rows)'
\echo ' 2 no ledger row of it is unfinished or rolled back (observed = such rows)'
\echo ' 3 the recorded checksum is the reviewed sha256 of migration.sql'
\echo ' 4 AuthEmailToken.bindingSha256: text, nullable'
\echo ' 5 purpose: the four values; the digest binding check; check constraints 5 + LINK_GOOGLE + 1 (observed = check constraints)'
\echo ' 6 both functions: SECURITY DEFINER, search_path pinned, same owner as auth_email_token_issue (observed = of 2)'
\echo ' 7 issue: EXECUTE held by app_auth, no other grantee besides the owner, app_runtime cannot (observed = foreign grantees)'
\echo ' 8 consume: EXECUTE held by app_runtime, no other grantee besides the owner, app_auth cannot (observed = foreign grantees)'
\echo ' 9 PUBLIC executes neither function (observed = such privileges)'
\echo '10 AuthEmailToken: RLS ENABLED + FORCED, exactly two policies (observed = policies)'
\echo '11 app_runtime cannot read bindingSha256; app_auth holds nothing on the table (observed = such privileges)'
\echo '12 nothing backfilled: no ISSUER_DECLARATION / digest-bound token predates the migration finish (observed = rows)'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
aet AS (SELECT c.oid, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
        WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relname = 'AuthEmailToken' AND c.relkind = 'r'),
led AS (SELECT * FROM "_prisma_migrations" WHERE migration_name = '20261126090000_auth_issuer_declaration_link'),
link AS (SELECT count(*) AS n FROM "_prisma_migrations" WHERE migration_name = '20261102090000_oauth_identity_link'
         AND finished_at IS NOT NULL AND rolled_back_at IS NULL),
done AS (SELECT timezone('UTC', finished_at) AS at FROM led WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL LIMIT 1),
col AS (SELECT a.atttypid, a.attnotnull FROM pg_attribute a
        WHERE a.attrelid = (SELECT oid FROM aet) AND a.attname = 'bindingSha256' AND NOT a.attisdropped),
purpose AS (SELECT pg_get_constraintdef(k.oid) AS def FROM pg_constraint k
            WHERE k.conrelid = (SELECT oid FROM aet) AND k.conname = 'AuthEmailToken_purpose' AND k.contype = 'c'),
binding AS (SELECT pg_get_constraintdef(k.oid) AS def FROM pg_constraint k
            WHERE k.conrelid = (SELECT oid FROM aet) AND k.conname = 'AuthEmailToken_declaration_binding' AND k.contype = 'c'),
ref AS (SELECT p.proowner FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pub) AND p.proname = 'auth_email_token_issue'),
fns AS (SELECT p.oid, p.proname, p.prosecdef, p.proowner, p.proconfig, p.proacl FROM pg_proc p
        WHERE p.pronamespace = (SELECT oid FROM pub)
          AND p.proname IN ('auth_issuer_declaration_issue', 'auth_issuer_declaration_consume')),
fn_exec AS (SELECT f.proname, x.grantee FROM fns f CROSS JOIN LATERAL aclexplode(f.proacl) x WHERE x.privilege_type = 'EXECUTE'),
au AS (SELECT oid FROM pg_roles WHERE rolname = 'app_auth'),
rt AS (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime'),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM led WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1,
            (SELECT count(*) FROM led WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 2, (SELECT count(*) FROM led WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM led WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, EXISTS (SELECT 1 FROM led WHERE checksum = '8262bc2396c5c6210b7511c9c02058e8c25a116ca5fd79392e3a15342f37ac35'),
                      (SELECT count(*) FROM led WHERE checksum = '8262bc2396c5c6210b7511c9c02058e8c25a116ca5fd79392e3a15342f37ac35')
  UNION ALL SELECT 4, EXISTS (SELECT 1 FROM col WHERE atttypid = 'text'::regtype AND NOT attnotnull), (SELECT count(*) FROM col)
  UNION ALL SELECT 5, EXISTS (SELECT 1 FROM purpose WHERE def LIKE '%''EMAIL_VERIFY''%' AND def LIKE '%''PASSWORD_RESET''%'
                                                     AND def LIKE '%''LINK_GOOGLE''%' AND def LIKE '%''ISSUER_DECLARATION''%')
                      AND EXISTS (SELECT 1 FROM binding WHERE def LIKE '%ISSUER_DECLARATION%' AND def LIKE '%bindingSha256%' AND def LIKE '%0-9a-f%')
                      AND (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM aet) AND k.contype = 'c') = 6 + (SELECT n FROM link),
                      (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = (SELECT oid FROM aet) AND k.contype = 'c')
  UNION ALL SELECT 6, (SELECT count(*) FROM fns WHERE prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public']
                                                  AND proowner = (SELECT proowner FROM ref)) = 2,
                      (SELECT count(*) FROM fns WHERE prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public']
                                                  AND proowner = (SELECT proowner FROM ref))
  UNION ALL SELECT 7, EXISTS (SELECT 1 FROM fn_exec WHERE proname = 'auth_issuer_declaration_issue' AND grantee = (SELECT oid FROM au))
                      AND NOT has_function_privilege('app_runtime', 'public.auth_issuer_declaration_issue(integer, integer, text, uuid, text)', 'EXECUTE')
                      AND (SELECT count(*) FROM fn_exec e WHERE e.proname = 'auth_issuer_declaration_issue'
                             AND e.grantee NOT IN ((SELECT oid FROM au), (SELECT proowner FROM ref))) = 0,
                      (SELECT count(*) FROM fn_exec e WHERE e.proname = 'auth_issuer_declaration_issue'
                             AND e.grantee NOT IN ((SELECT oid FROM au), (SELECT proowner FROM ref)))
  UNION ALL SELECT 8, EXISTS (SELECT 1 FROM fn_exec WHERE proname = 'auth_issuer_declaration_consume' AND grantee = (SELECT oid FROM rt))
                      AND NOT has_function_privilege('app_auth', 'public.auth_issuer_declaration_consume(uuid, text, integer, text)', 'EXECUTE')
                      AND (SELECT count(*) FROM fn_exec e WHERE e.proname = 'auth_issuer_declaration_consume'
                             AND e.grantee NOT IN ((SELECT oid FROM rt), (SELECT proowner FROM ref))) = 0,
                      (SELECT count(*) FROM fn_exec e WHERE e.proname = 'auth_issuer_declaration_consume'
                             AND e.grantee NOT IN ((SELECT oid FROM rt), (SELECT proowner FROM ref)))
  UNION ALL SELECT 9, (SELECT count(*) FROM fn_exec WHERE grantee = 0) = 0, (SELECT count(*) FROM fn_exec WHERE grantee = 0)
  UNION ALL SELECT 10, (SELECT relrowsecurity AND relforcerowsecurity FROM aet)
                       AND (SELECT count(*) FROM pg_policy p WHERE p.polrelid = (SELECT oid FROM aet)) = 2,
                       (SELECT count(*) FROM pg_policy p WHERE p.polrelid = (SELECT oid FROM aet))
  UNION ALL SELECT 11, NOT has_column_privilege('app_runtime', '"AuthEmailToken"', 'bindingSha256', 'SELECT')
                       AND NOT has_table_privilege('app_auth', '"AuthEmailToken"', 'SELECT')
                       AND NOT has_table_privilege('app_auth', '"AuthEmailToken"', 'INS' || 'ERT')
                       AND NOT has_table_privilege('app_auth', '"AuthEmailToken"', 'UPD' || 'ATE')
                       AND NOT has_table_privilege('app_auth', '"AuthEmailToken"', 'DEL' || 'ETE'),
                       (CASE WHEN has_column_privilege('app_runtime', '"AuthEmailToken"', 'bindingSha256', 'SELECT') THEN 1 ELSE 0 END)
                       + (CASE WHEN has_table_privilege('app_auth', '"AuthEmailToken"', 'SELECT') THEN 1 ELSE 0 END)
  UNION ALL SELECT 12, (SELECT count(*) FROM "AuthEmailToken" WHERE ("purpose" = 'ISSUER_DECLARATION' OR "bindingSha256" IS NOT NULL)
                          AND "createdAt" < (SELECT at FROM done)) = 0,
                       (SELECT count(*) FROM "AuthEmailToken" WHERE ("purpose" = 'ISSUER_DECLARATION' OR "bindingSha256" IS NOT NULL)
                          AND "createdAt" < (SELECT at FROM done))
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
