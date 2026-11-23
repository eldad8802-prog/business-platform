-- ============================================================================
-- issuer-status-change-production-evidence.sql
--
-- Read-only PROOF that the 4a T1/T1a release set is applied exactly as reviewed and is still inert:
--   20261223090000_issuer_reauth_google
--   20261223100000_issuer_declaration_status_change
-- Run AFTER the apply: every check must PASS. Before the apply it reports FAIL rows (its objects are missing).
-- The pre-apply counterpart is issuer-status-change-preflight.sql.
-- OUTPUT: n | result (PASS/FAIL) | observed_count. Guard-clean: SELECT only. Counts only, no row values.
-- ============================================================================
\echo '== issuer status change (4a T1/T1a) proof: legend (n -> check) =='
\echo ' 1 both ledger rows are finished, not rolled back, with the reviewed checksums (observed = of 2)'
\echo ' 2 the ledger is clean: no unfinished or rolled-back migration row (observed = rows)'
\echo ' 3 nothing was applied after the release set (observed = rows)'
\echo ' 4 enum IssuerReauthMethod holds GOOGLE (observed = labels)'
\echo ' 5 the writer is SECURITY DEFINER, the origin guard is not; both pin search_path (observed = of 2)'
\echo ' 6 both new functions are owned by the owner of BusinessIssuerDeclaration (observed = of 2)'
\echo ' 7 the writer has the reviewed signature: six arguments, returns text (observed = functions)'
\echo ' 8 trigger BusinessIssuerDeclaration_status_change_origin: enabled, fires before each new row (tgtype 7), runs the guard (observed = triggers)'
\echo ' 9 nobody but the owner may execute either new function: PUBLIC default revoked, no other grantee (observed = grants or defaults)'
\echo '10 app_runtime and app_auth execute neither new function (observed = privileges)'
\echo '11 still inert: the transition still refuses ISSUER_DECLARATION_ACTIVE and does not reference the writer (observed = 1)'
\echo '12 no STATUS_CHANGE declaration exists (observed = rows)'
\echo '13 no declaration records GOOGLE (observed = rows)'
\echo '14 the chain and designation-origin triggers are still in place and enabled (observed = of 2)'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
decl AS (SELECT c.oid, c.relowner FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relkind = 'r'
           AND c.relname = 'BusinessIssuerDeclaration'),
ledger AS (SELECT count(*) AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL AND (
             (migration_name = '20261223090000_issuer_reauth_google'
               AND checksum = '96e0fd82e25619cf03c6e3e356b70fff40e108417275d6254764693f2cab5b61')
          OR (migration_name = '20261223100000_issuer_declaration_status_change'
               AND checksum = '81e764971feaf84ad06461491eda876697822b40b4194d9e4754b32621e33ab4'))),
unclean AS (SELECT count(*) AS n FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL),
after AS (SELECT count(*) AS n FROM "_prisma_migrations" WHERE migration_name > '20261223100000_issuer_declaration_status_change'),
google AS (SELECT count(*) AS n FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
             WHERE t.typnamespace = (SELECT oid FROM pub) AND t.typname = 'IssuerReauthMethod' AND e.enumlabel = 'GOOGLE'),
fn AS (SELECT p.oid, p.proname, p.prosecdef, p.proowner, p.proacl, coalesce(array_to_string(p.proconfig, ','), '') AS cfg
         FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pub)
          AND p.proname IN ('issuer_declaration_status_change', 'issuer_status_change_origin_guard')),
modes AS (SELECT count(*) AS n FROM fn WHERE cfg = 'search_path=pg_catalog, public, pg_temp' AND (
            (proname = 'issuer_declaration_status_change' AND prosecdef)
         OR (proname = 'issuer_status_change_origin_guard' AND NOT prosecdef))),
owned AS (SELECT count(*) AS n FROM fn WHERE proowner = (SELECT relowner FROM decl)),
sig AS (SELECT count(*) AS n FROM fn WHERE proname = 'issuer_declaration_status_change'
          AND pg_get_function_identity_arguments(oid) =
              'p_user_id integer, p_vat_number text, p_reauth_method text, p_reauth_at timestamp with time zone, p_statement_version text, p_statement_sha256 text'
          AND pg_get_function_result(oid) = 'text'),
trg AS (SELECT count(*) AS n FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE t.tgrelid = (SELECT oid FROM decl) AND t.tgname = 'BusinessIssuerDeclaration_status_change_origin'
            AND t.tgenabled = 'O' AND t.tgtype = 7 AND p.proname = 'issuer_status_change_origin_guard'),
grants AS (SELECT (SELECT count(*) FROM fn WHERE proacl IS NULL)
                + (SELECT count(*) FROM fn CROSS JOIN LATERAL aclexplode(fn.proacl) x WHERE x.grantee <> fn.proowner) AS n),
rolepriv AS (SELECT count(*) AS n FROM fn CROSS JOIN pg_roles r
               WHERE r.rolname IN ('app_runtime', 'app_auth') AND has_function_privilege(r.oid, fn.oid, 'EXECUTE')),
inert AS (SELECT count(*) AS n FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pub)
            AND p.proname = 'business_kind_transition_to_authorized'
            AND position('ISSUER_DECLARATION_ACTIVE' IN p.prosrc) > 0
            AND position('issuer_declaration_status_change' IN p.prosrc) = 0),
sc AS (SELECT count(*) AS n FROM "BusinessIssuerDeclaration" WHERE "kind"::text = 'STATUS_CHANGE'),
gdecl AS (SELECT count(*) AS n FROM "BusinessIssuerDeclaration" WHERE "reauthMethod"::text = 'GOOGLE'),
oldtrg AS (SELECT count(*) AS n FROM pg_trigger t WHERE t.tgrelid = (SELECT oid FROM decl) AND t.tgenabled = 'O'
             AND t.tgname IN ('BusinessIssuerDeclaration_chain', 'BusinessIssuerDeclaration_designation_origin')),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT n FROM ledger) = 2, (SELECT n FROM ledger)
  UNION ALL SELECT 2, (SELECT n FROM unclean) = 0, (SELECT n FROM unclean)
  UNION ALL SELECT 3, (SELECT n FROM after) = 0, (SELECT n FROM after)
  UNION ALL SELECT 4, (SELECT n FROM google) = 1, (SELECT n FROM google)
  UNION ALL SELECT 5, (SELECT n FROM modes) = 2, (SELECT n FROM modes)
  UNION ALL SELECT 6, (SELECT n FROM owned) = 2, (SELECT n FROM owned)
  UNION ALL SELECT 7, (SELECT n FROM sig) = 1, (SELECT n FROM sig)
  UNION ALL SELECT 8, (SELECT n FROM trg) = 1, (SELECT n FROM trg)
  UNION ALL SELECT 9, (SELECT count(*) FROM fn) = 2 AND (SELECT n FROM grants) = 0, (SELECT n FROM grants)
  UNION ALL SELECT 10, (SELECT count(*) FROM fn) = 2 AND (SELECT n FROM rolepriv) = 0, (SELECT n FROM rolepriv)
  UNION ALL SELECT 11, (SELECT n FROM inert) = 1, (SELECT n FROM inert)
  UNION ALL SELECT 12, (SELECT n FROM sc) = 0, (SELECT n FROM sc)
  UNION ALL SELECT 13, (SELECT n FROM gdecl) = 0, (SELECT n FROM gdecl)
  UNION ALL SELECT 14, (SELECT n FROM oldtrg) = 2, (SELECT n FROM oldtrg)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
