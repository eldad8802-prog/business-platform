-- ============================================================================
-- kind-transition-wiring-production-evidence.sql
--
-- Read-only PROOF that 20261225090000_kind_transition_issuer_declaration_wiring is applied exactly as reviewed:
-- the ledger row carries the reviewed checksum, the transition's deployed body is the reviewed body (md5 pinned),
-- its owner / mode / search_path / privileges are as before, and nothing was filed by it yet.
-- Run AFTER the apply: every required check must PASS. Before the apply it reports FAIL rows (1, 3, 4).
-- The pre-apply counterpart is kind-transition-wiring-preflight.sql.
-- Expected side effect on another track's proof: issuer-status-change-production-evidence.sql check 11 ("still inert")
-- turns FAIL once this is applied — by design: this migration is what makes the transition use the writer.
-- OUTPUT: n | result (PASS/FAIL/INFO) | observed_count. Guard-clean: SELECT only. Counts only, no row values.
-- ============================================================================
\echo '== kind transition wiring proof: legend (n -> check) =='
\echo ' 1 the ledger row is finished, not rolled back, with the reviewed checksum (observed = rows)'
\echo ' 2 the ledger is clean: no unfinished or rolled-back migration row (observed = rows)'
\echo ' 3 the deployed transition body is the reviewed body: md5 pinned (observed = functions)'
\echo ' 4 the transition references the writer and no longer refuses ISSUER_DECLARATION_ACTIVE (observed = functions)'
\echo ' 5 the transition keeps its signature, SECURITY DEFINER and pinned search_path (observed = functions)'
\echo ' 6 one owner: the transition, the writer and BusinessIssuerDeclaration (observed = distinct owners)'
\echo ' 7 app_runtime executes the transition; app_runtime and app_auth never the writer; app_auth not the transition (observed = 1 when all hold)'
\echo ' 8 PUBLIC executes neither function (observed = PUBLIC entries)'
\echo ' 9 the STATUS_CHANGE origin trigger is still on BusinessIssuerDeclaration and enabled (observed = triggers)'
\echo '10 INFO: STATUS_CHANGE declarations (0 right after the apply while BUSINESS_KIND_TRANSITION_ENABLED is off)'
\echo '11 INFO: BusinessKindTransition rows'
\echo '12 INFO: migrations recorded after 20261225090000'
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
wr AS (SELECT p.oid, p.proowner, p.proacl FROM pg_proc p
         WHERE p.pronamespace = (SELECT oid FROM pub) AND p.proname = 'issuer_declaration_status_change'
          AND pg_get_function_identity_arguments(p.oid) =
              'p_user_id integer, p_vat_number text, p_reauth_method text, p_reauth_at timestamp with time zone, p_statement_version text, p_statement_sha256 text'),
ledger AS (SELECT count(*) AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
             AND migration_name = '20261225090000_kind_transition_issuer_declaration_wiring'
             AND checksum = '0acb8c80438132e24f54b121ae25b6cb1da63a02bea0d126434701ec57b1edaa'),
unclean AS (SELECT count(*) AS n FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL),
body AS (SELECT count(*) AS n FROM tx WHERE md5(prosrc) = 'e691e58efaec46a2f4ba05dbb0c35da8'),
wired AS (SELECT count(*) AS n FROM tx WHERE position('issuer_declaration_status_change' IN prosrc) > 0
            AND position('ISSUER_DECLARATION_ACTIVE' IN prosrc) = 0),
txok AS (SELECT count(*) AS n FROM tx WHERE prosecdef AND cfg = 'search_path=pg_catalog, public, pg_temp'),
owners AS (SELECT count(DISTINCT o) AS n FROM (SELECT proowner AS o FROM tx UNION ALL SELECT proowner FROM wr
                                               UNION ALL SELECT relowner FROM decl) x),
parts AS (SELECT (SELECT count(*) FROM tx) AS t, (SELECT count(*) FROM wr) AS w, (SELECT count(*) FROM decl) AS d),
priv AS (SELECT CASE WHEN (SELECT count(*) FROM tx) = 1 AND (SELECT count(*) FROM wr) = 1
                      AND (SELECT count(*) FROM pg_roles WHERE rolname IN ('app_runtime', 'app_auth')) = 2
                      AND has_function_privilege('app_runtime', (SELECT oid FROM tx), 'EXECUTE')
                      AND NOT has_function_privilege('app_runtime', (SELECT oid FROM wr), 'EXECUTE')
                      AND NOT has_function_privilege('app_auth', (SELECT oid FROM wr), 'EXECUTE')
                      AND NOT has_function_privilege('app_auth', (SELECT oid FROM tx), 'EXECUTE') THEN 1 ELSE 0 END AS n),
pubx AS (SELECT count(*) AS n FROM (SELECT proacl FROM tx UNION ALL SELECT proacl FROM wr) f
           CROSS JOIN LATERAL aclexplode(f.proacl) x WHERE x.grantee = 0),
pubdefault AS (SELECT count(*) AS n FROM (SELECT proacl FROM tx UNION ALL SELECT proacl FROM wr) f WHERE f.proacl IS NULL),
trg AS (SELECT count(*) AS n FROM pg_trigger t WHERE t.tgrelid = (SELECT oid FROM decl)
          AND t.tgname = 'BusinessIssuerDeclaration_status_change_origin' AND t.tgenabled = 'O'),
sc AS (SELECT count(*) AS n FROM "BusinessIssuerDeclaration" WHERE "kind"::text = 'STATUS_CHANGE'),
hist AS (SELECT count(*) AS n FROM "BusinessKindTransition"),
after AS (SELECT count(*) AS n FROM "_prisma_migrations" WHERE migration_name > '20261225090000_kind_transition_issuer_declaration_wiring'),
checks(n, result, observed_count) AS (
  SELECT 1, (SELECT n FROM ledger) = 1, (SELECT n FROM ledger)
  UNION ALL SELECT 2, (SELECT n FROM unclean) = 0, (SELECT n FROM unclean)
  UNION ALL SELECT 3, (SELECT n FROM body) = 1, (SELECT n FROM body)
  UNION ALL SELECT 4, (SELECT n FROM wired) = 1, (SELECT n FROM wired)
  UNION ALL SELECT 5, (SELECT n FROM txok) = 1, (SELECT n FROM txok)
  UNION ALL SELECT 6, (SELECT t FROM parts) = 1 AND (SELECT w FROM parts) = 1 AND (SELECT d FROM parts) = 1 AND (SELECT n FROM owners) = 1, (SELECT n FROM owners)
  UNION ALL SELECT 7, (SELECT n FROM priv) = 1, (SELECT n FROM priv)
  UNION ALL SELECT 8, (SELECT n FROM pubx) = 0 AND (SELECT n FROM pubdefault) = 0, (SELECT n FROM pubx) + (SELECT n FROM pubdefault)
  UNION ALL SELECT 9, (SELECT n FROM trg) = 1, (SELECT n FROM trg)
  UNION ALL SELECT 10, NULL, (SELECT n FROM sc)
  UNION ALL SELECT 11, NULL, (SELECT n FROM hist)
  UNION ALL SELECT 12, NULL, (SELECT n FROM after)
)
SELECT n, CASE WHEN result IS NULL THEN 'INFO' WHEN result THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
