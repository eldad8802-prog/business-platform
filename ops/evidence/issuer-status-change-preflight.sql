-- ============================================================================
-- issuer-status-change-preflight.sql
--
-- Read-only PREFLIGHT for the 4a T1/T1a release set, applied together in one release-migrate run, in this order:
--   20261223090000_issuer_reauth_google            (enum value GOOGLE; not authority-changing)
--   20261223100000_issuer_declaration_status_change (SECURITY DEFINER writer + origin trigger; authority-changing)
-- Run BEFORE the apply: every check must PASS. The post-apply proof, where every check must PASS after the apply, is
-- issuer-status-change-production-evidence.sql. (This file run after the apply turns exactly checks 2, 4, 5 and 6
-- to FAIL: they describe "not there yet".)
-- OUTPUT: n | result (PASS/FAIL/INFO) | observed_count. Guard-clean: SELECT only. Counts only, no row values.
-- ============================================================================
\echo '== issuer status change (4a T1/T1a) preflight: legend (n -> check) =='
\echo ' 1 the ledger is clean: no unfinished or rolled-back migration row (observed = rows)'
\echo ' 2 neither 4a migration is in the ledger (observed = rows)'
\echo ' 3 its prerequisites are finished: 20261126100000, 20261128090000, 20261221090000, 20261222090000 (observed = of 4)'
\echo ' 4 enum IssuerReauthMethod exists and has no GOOGLE yet (observed = GOOGLE labels; PASS = type exists and 0)'
\echo ' 5 neither new function exists yet: issuer_declaration_status_change, issuer_status_change_origin_guard (observed = of 2)'
\echo ' 6 the trigger BusinessIssuerDeclaration_status_change_origin is absent (observed = triggers)'
\echo ' 7 no STATUS_CHANGE declaration exists (observed = rows)'
\echo ' 8 the functions it relies on exist: legal_identity_tax_id_ok, business_kind_transition_to_authorized, issuer_declaration_chain_guard (observed = of 3)'
\echo ' 9 the chain and designation-origin triggers on BusinessIssuerDeclaration exist (observed = of 2)'
\echo '10 the columns it reads/writes exist: BusinessIssuerDeclaration 29, BusinessProfile 5, User 2 (observed = of 36)'
\echo '11 the enum labels it writes exist: STATUS_CHANGE, AUTHORIZED_DEALER_INDIVIDUAL, INDIVIDUAL, AUTHORIZED, CURRENT_AUTHORIZED_USER, PASSWORD (observed = of 6)'
\echo '12 one owner: the release role owns BusinessIssuerDeclaration and business_kind_transition_to_authorized (observed = of 2)'
\echo '13 server is PostgreSQL >= 12 (a new enum value inside a migration transaction) (observed = server_version_num)'
\echo '14 the role app_runtime exists (observed = roles)'
\echo '15 INFO latest declarations that are live and exempt (would be eligible once wired) (observed = businesses)'
\echo '16 INFO BusinessKindTransition rows (observed = rows)'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
decl AS (SELECT c.oid, c.relowner FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub) AND c.relkind = 'r'
           AND c.relname = 'BusinessIssuerDeclaration'),
later AS (SELECT count(*) AS n FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL),
mine AS (SELECT count(*) AS n FROM "_prisma_migrations" WHERE migration_name IN
           ('20261223090000_issuer_reauth_google', '20261223100000_issuer_declaration_status_change')),
prereq AS (SELECT count(*) AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
             AND migration_name IN ('20261126100000_issuer_declaration', '20261128090000_signup_legal_identity',
                                    '20261221090000_business_kind_transition', '20261222090000_service_desk_case_records')),
reauth_type AS (SELECT count(*) AS n FROM pg_type t WHERE t.typnamespace = (SELECT oid FROM pub) AND t.typname = 'IssuerReauthMethod'),
google AS (SELECT count(*) AS n FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
             WHERE t.typnamespace = (SELECT oid FROM pub) AND t.typname = 'IssuerReauthMethod' AND e.enumlabel = 'GOOGLE'),
newfns AS (SELECT count(DISTINCT p.proname) AS n FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pub)
             AND p.proname IN ('issuer_declaration_status_change', 'issuer_status_change_origin_guard')),
newtrg AS (SELECT count(*) AS n FROM pg_trigger t WHERE t.tgrelid = (SELECT oid FROM decl)
             AND t.tgname = 'BusinessIssuerDeclaration_status_change_origin'),
sc AS (SELECT count(*) AS n FROM "BusinessIssuerDeclaration" WHERE "kind"::text = 'STATUS_CHANGE'),
deps AS (SELECT count(DISTINCT p.proname) AS n FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pub)
           AND p.proname IN ('legal_identity_tax_id_ok', 'business_kind_transition_to_authorized', 'issuer_declaration_chain_guard')),
oldtrg AS (SELECT count(*) AS n FROM pg_trigger t WHERE t.tgrelid = (SELECT oid FROM decl)
             AND t.tgname IN ('BusinessIssuerDeclaration_chain', 'BusinessIssuerDeclaration_designation_origin')),
cols AS (SELECT count(*) AS n FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
           WHERE c.relnamespace = (SELECT oid FROM pub) AND NOT a.attisdropped AND a.attnum > 0 AND (
             (c.relname = 'BusinessIssuerDeclaration' AND a.attname IN ('id', 'businessId', 'version', 'supersedesId', 'kind', 'track',
               'legalForm', 'vatStatus', 'legalName', 'tradeName', 'idType', 'idNumber', 'vatRegistrationNumber', 'address', 'phone',
               'email', 'effectiveFrom', 'reason', 'authorizedUserId', 'authorityBasis', 'authorityEvidenceRef', 'declaredByUserId',
               'declarantName', 'declarantCapacity', 'statementVersion', 'statementSha256', 'reauthMethod', 'reauthAt', 'anonymisedAt'))
          OR (c.relname = 'BusinessProfile' AND a.attname IN ('id', 'businessId', 'billingBusinessKind', 'billingLegalName', 'billingTaxId'))
          OR (c.relname = 'User' AND a.attname IN ('id', 'businessId')))),
need(col, label) AS (VALUES ('kind', 'STATUS_CHANGE'), ('track', 'AUTHORIZED_DEALER_INDIVIDUAL'), ('legalForm', 'INDIVIDUAL'),
                            ('vatStatus', 'AUTHORIZED'), ('authorityBasis', 'CURRENT_AUTHORIZED_USER'), ('reauthMethod', 'PASSWORD')),
labels AS (SELECT count(*) AS n FROM need nd WHERE EXISTS (
             SELECT 1 FROM pg_attribute a JOIN pg_enum e ON e.enumtypid = a.atttypid
              WHERE a.attrelid = (SELECT oid FROM decl) AND a.attname = nd.col AND e.enumlabel = nd.label)),
owners AS (SELECT (SELECT count(*) FROM decl WHERE pg_get_userbyid(relowner) = current_user)
                + (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pub)
                     AND p.proname = 'business_kind_transition_to_authorized'
                     AND p.proowner = (SELECT relowner FROM decl) AND pg_get_userbyid(p.proowner) = current_user) AS n),
eligible AS (SELECT count(*) AS n FROM (
               SELECT DISTINCT ON ("businessId") "track"::text AS track, "vatStatus"::text AS vat, "anonymisedAt"
                 FROM "BusinessIssuerDeclaration" ORDER BY "businessId", "version" DESC) x
             WHERE x."anonymisedAt" IS NULL AND x.track = 'EXEMPT_DEALER' AND x.vat = 'EXEMPT'),
bkt AS (SELECT count(*) AS n FROM "BusinessKindTransition"),
checks(n, result, observed_count) AS (
  SELECT 1, (SELECT n FROM later) = 0, (SELECT n FROM later)
  UNION ALL SELECT 2, (SELECT n FROM mine) = 0, (SELECT n FROM mine)
  UNION ALL SELECT 3, (SELECT n FROM prereq) = 4, (SELECT n FROM prereq)
  UNION ALL SELECT 4, (SELECT n FROM reauth_type) = 1 AND (SELECT n FROM google) = 0, (SELECT n FROM google)
  UNION ALL SELECT 5, (SELECT n FROM newfns) = 0, (SELECT n FROM newfns)
  UNION ALL SELECT 6, (SELECT n FROM newtrg) = 0, (SELECT n FROM newtrg)
  UNION ALL SELECT 7, (SELECT n FROM sc) = 0, (SELECT n FROM sc)
  UNION ALL SELECT 8, (SELECT n FROM deps) = 3, (SELECT n FROM deps)
  UNION ALL SELECT 9, (SELECT n FROM oldtrg) = 2, (SELECT n FROM oldtrg)
  UNION ALL SELECT 10, (SELECT n FROM cols) = 36, (SELECT n FROM cols)
  UNION ALL SELECT 11, (SELECT n FROM labels) = 6, (SELECT n FROM labels)
  UNION ALL SELECT 12, (SELECT n FROM owners) = 2, (SELECT n FROM owners)
  UNION ALL SELECT 13, current_setting('server_version_num')::int >= 120000, current_setting('server_version_num')::bigint
  UNION ALL SELECT 14, (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime') = 1, (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime')
  UNION ALL SELECT 15, NULL, (SELECT n FROM eligible)
  UNION ALL SELECT 16, NULL, (SELECT n FROM bkt)
)
SELECT n, CASE WHEN result IS NULL THEN 'INFO' WHEN result THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
