-- ============================================================================
-- kind-transition-wiring-preflight.sql
--
-- Read-only PREFLIGHT for 20261225090000_kind_transition_issuer_declaration_wiring (the 4a T1 wiring of
-- business_kind_transition_to_authorized). The premises, checked in the target database BEFORE the apply. Every
-- required check must PASS. After the apply, exactly checks 2 and 5 turn FAIL (they describe "not wired yet").
-- Ordering: it needs 20261221090000, 20261223090000 and 20261223100000 (all applied in Production) and no other
-- pending migration; release-migrate applies every pending migration in order, so 20261224090000 (another track)
-- must be applied or released first.
-- OUTPUT: n | result (PASS/FAIL/INFO) | observed_count. Guard-clean: SELECT only. Counts only, no row values.
-- ============================================================================
\echo '== kind transition wiring preflight: legend (n -> check) =='
\echo ' 1 the ledger is clean: no unfinished or rolled-back migration row (observed = rows)'
\echo ' 2 20261225090000 is not in the ledger (observed = rows)'
\echo ' 3 its three prerequisites are finished: 20261221090000, 20261223090000, 20261223100000 (observed = of 3)'
\echo ' 4 the transition exists with the reviewed signature, SECURITY DEFINER, pinned search_path (observed = functions)'
\echo ' 5 the transition is the 20261221090000 body: refuses ISSUER_DECLARATION_ACTIVE, no writer reference (observed = functions)'
\echo ' 6 the 4a writer exists with the reviewed signature and is SECURITY DEFINER (observed = functions)'
\echo ' 7 one owner: the transition, the writer and BusinessIssuerDeclaration (observed = distinct owners)'
\echo ' 8 enum IssuerReauthMethod holds GOOGLE (observed = labels)'
\echo ' 9 app_runtime executes the transition and not the writer (observed = 1 when both hold)'
\echo '10 PUBLIC executes neither function (observed = PUBLIC entries)'
\echo '11 the STATUS_CHANGE origin trigger is on BusinessIssuerDeclaration and enabled (observed = triggers)'
\echo '12 server_version_num is 17 or later (observed = version)'
\echo '13 INFO: businesses whose latest declaration is live and exempt with an exempt profile (they take the new path)'
\echo '14 INFO: BusinessKindTransition rows'
\echo '15 INFO: STATUS_CHANGE declarations'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
decl AS (SELECT c.oid, c.relowner FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relkind = 'r'
           AND c.relname = 'BusinessIssuerDeclaration'),
tx AS (SELECT p.oid, p.proowner, p.prosecdef, p.prosrc, p.proacl, coalesce(array_to_string(p.proconfig, ','), '') AS cfg
         FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pub) AND p.proname = 'business_kind_transition_to_authorized'
          AND pg_get_function_identity_arguments(p.oid) =
              'p_user_id integer, p_vat_number text, p_status_effective_date date, p_reauth_method text, p_reauth_at timestamp with time zone, p_statement_sha256 text'
          AND pg_get_function_result(p.oid) = 'text'),
wr AS (SELECT p.oid, p.proowner, p.prosecdef, p.proacl FROM pg_proc p
         WHERE p.pronamespace = (SELECT oid FROM pub) AND p.proname = 'issuer_declaration_status_change'
          AND pg_get_function_identity_arguments(p.oid) =
              'p_user_id integer, p_vat_number text, p_reauth_method text, p_reauth_at timestamp with time zone, p_statement_version text, p_statement_sha256 text'
          AND pg_get_function_result(p.oid) = 'text'),
unclean AS (SELECT count(*) AS n FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL),
mine AS (SELECT count(*) AS n FROM "_prisma_migrations" WHERE migration_name = '20261225090000_kind_transition_issuer_declaration_wiring'),
prereq AS (SELECT count(*) AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
             AND migration_name IN ('20261221090000_business_kind_transition', '20261223090000_issuer_reauth_google',
                                    '20261223100000_issuer_declaration_status_change')),
txok AS (SELECT count(*) AS n FROM tx WHERE prosecdef AND cfg = 'search_path=pg_catalog, public, pg_temp'),
unwired AS (SELECT count(*) AS n FROM tx WHERE position('ISSUER_DECLARATION_ACTIVE' IN prosrc) > 0
              AND position('issuer_declaration_status_change' IN prosrc) = 0),
wrok AS (SELECT count(*) AS n FROM wr WHERE prosecdef),
owners AS (SELECT count(DISTINCT o) AS n FROM (SELECT proowner AS o FROM tx UNION ALL SELECT proowner FROM wr
                                               UNION ALL SELECT relowner FROM decl) x),
parts AS (SELECT (SELECT count(*) FROM tx) AS t, (SELECT count(*) FROM wr) AS w, (SELECT count(*) FROM decl) AS d),
google AS (SELECT count(*) AS n FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
             WHERE t.typnamespace = (SELECT oid FROM pub) AND t.typname = 'IssuerReauthMethod' AND e.enumlabel = 'GOOGLE'),
rt AS (SELECT CASE WHEN (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime') = 1
                    AND (SELECT count(*) FROM tx) = 1 AND (SELECT count(*) FROM wr) = 1
                    AND has_function_privilege('app_runtime', (SELECT oid FROM tx), 'EXECUTE')
                    AND NOT has_function_privilege('app_runtime', (SELECT oid FROM wr), 'EXECUTE') THEN 1 ELSE 0 END AS n),
pubx AS (SELECT count(*) AS n FROM (SELECT proacl FROM tx UNION ALL SELECT proacl FROM wr) f
           CROSS JOIN LATERAL aclexplode(f.proacl) x WHERE x.grantee = 0),
pubdefault AS (SELECT count(*) AS n FROM (SELECT proacl FROM tx UNION ALL SELECT proacl FROM wr) f WHERE f.proacl IS NULL),
trg AS (SELECT count(*) AS n FROM pg_trigger t WHERE t.tgrelid = (SELECT oid FROM decl)
          AND t.tgname = 'BusinessIssuerDeclaration_status_change_origin' AND t.tgenabled = 'O'),
ver AS (SELECT current_setting('server_version_num')::int AS n),
live AS (SELECT count(*) AS n FROM (
           SELECT DISTINCT ON (d."businessId") d."businessId", d."anonymisedAt", d."vatStatus"::text AS vs
             FROM "BusinessIssuerDeclaration" d ORDER BY d."businessId", d."version" DESC) l
           JOIN "BusinessProfile" bp ON bp."businessId" = l."businessId"
          WHERE l."anonymisedAt" IS NULL AND l.vs = 'EXEMPT' AND bp."billingBusinessKind"::text = 'EXEMPT_DEALER'),
hist AS (SELECT count(*) AS n FROM "BusinessKindTransition"),
sc AS (SELECT count(*) AS n FROM "BusinessIssuerDeclaration" WHERE "kind"::text = 'STATUS_CHANGE'),
checks(n, result, observed_count) AS (
  SELECT 1, (SELECT n FROM unclean) = 0, (SELECT n FROM unclean)
  UNION ALL SELECT 2, (SELECT n FROM mine) = 0, (SELECT n FROM mine)
  UNION ALL SELECT 3, (SELECT n FROM prereq) = 3, (SELECT n FROM prereq)
  UNION ALL SELECT 4, (SELECT n FROM txok) = 1, (SELECT n FROM txok)
  UNION ALL SELECT 5, (SELECT n FROM unwired) = 1, (SELECT n FROM unwired)
  UNION ALL SELECT 6, (SELECT n FROM wrok) = 1, (SELECT n FROM wrok)
  UNION ALL SELECT 7, (SELECT t FROM parts) = 1 AND (SELECT w FROM parts) = 1 AND (SELECT d FROM parts) = 1 AND (SELECT n FROM owners) = 1, (SELECT n FROM owners)
  UNION ALL SELECT 8, (SELECT n FROM google) = 1, (SELECT n FROM google)
  UNION ALL SELECT 9, (SELECT n FROM rt) = 1, (SELECT n FROM rt)
  UNION ALL SELECT 10, (SELECT n FROM pubx) = 0 AND (SELECT n FROM pubdefault) = 0, (SELECT n FROM pubx) + (SELECT n FROM pubdefault)
  UNION ALL SELECT 11, (SELECT n FROM trg) = 1, (SELECT n FROM trg)
  UNION ALL SELECT 12, (SELECT n FROM ver) >= 170000, (SELECT n FROM ver)
  UNION ALL SELECT 13, NULL, (SELECT n FROM live)
  UNION ALL SELECT 14, NULL, (SELECT n FROM hist)
  UNION ALL SELECT 15, NULL, (SELECT n FROM sc)
)
SELECT n, CASE WHEN result IS NULL THEN 'INFO' WHEN result THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
