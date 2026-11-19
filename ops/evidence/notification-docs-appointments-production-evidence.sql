-- ============================================================================
-- notification-docs-appointments-production-evidence.sql
--
-- Read-only Production EVIDENCE after migration
--   20261213090000_notification_docs_stuck_appointment_lead
-- (which depends on 20261212090000_notification_engine_activation, check 12, itself after the follow-up and the
-- foundation).
--
-- Proves the migration's outcome, from the catalog and counts only:
--   * it is recorded and finished, its sha256 is the reviewed one, nothing is unfinished or rolled back;
--   * the two columns: "Document"."statusChangedAt" timestamp(3) and "NotificationSettings"."appointmentReminderMinutes"
--     smallint, both nullable with no default (no table rewrite, every older row reads NULL);
--   * the check on the lead time: validated, exactly 30 / 60 / 120 / 1440 or NULL;
--   * the trigger function: SECURITY INVOKER, plpgsql, search_path pinned, owned by the migration role, EXECUTE for
--     nobody but the owner;
--   * the trigger: BEFORE, row level, enabled, on "Document" for a new row and for a change naming "status" or
--     "statusChangedAt", calling that function;
--   * nothing else moved: "Document" keeps row level security enabled and forced with exactly its two policies
--     (p7w4d_tenant on the tenant setting, p7adm_read for app_admin); the new column carries no column-level
--     privilege of its own (so the admin's column grants never reach it) and app_runtime holds on it exactly what it
--     holds on "status" (table level); "NotificationSettings" keeps
--     its four tenant policies, enabled and forced;
--   * no document carries a stamp older than the release (history stays unstamped, never flagged).
--
-- Checks 21 and 22 run first: row counts are taken with row_security = off, so a query that row level security
-- would filter stops the run with an ERROR instead of reporting a smaller number.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== notification docs + appointments production evidence: legend (n -> check) =='
\echo '21 V1 the evidence role is a superuser or has BYPASSRLS, so it sees every row (runs first)'
\echo '22 V2 row level security is not active on "Document" for the evidence role (runs first)'
\echo ' 1 the migration is recorded and finished (observed = finished rows)'
\echo ' 2 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 3 the recorded checksum is the reviewed sha256 of migration.sql'
\echo ' 4 the two columns: types, nullable, no default (observed = of 2)'
\echo ' 5 the lead time check: validated, exactly 30 / 60 / 120 / 1440 or NULL (observed = of 1)'
\echo ' 6 the trigger function: invoker, plpgsql, search_path pinned, owned by the migration role (observed = of 1)'
\echo ' 7 EXECUTE on the trigger function for nobody but the owner, no PUBLIC (observed = other grants)'
\echo ' 8 the trigger: BEFORE, row level, enabled, new row + change of status / statusChangedAt, its function (observed = of 1)'
\echo ' 9 Document: row level security enabled and forced, exactly p7w4d_tenant (tenant setting) and p7adm_read (observed = policies)'
\echo '10 the new column: no column-level privilege, app_admin cannot read it, app_runtime reads it like status (observed = mismatches)'
\echo '11 NotificationSettings: row level security enabled and forced, its four tenant policies (observed = policies)'
\echo '12 the activation migration 20261212090000 is recorded and finished, the dependency (observed = such rows)'
\echo '13 no document carries a stamp older than the release (observed = such rows)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

\echo '== visibility checks (21, 22) =='
WITH
tbl AS (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'Document' AND c.relkind = 'r'),
checks(n, ok, observed_count) AS (
            SELECT 21, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) IS TRUE, 1
  UNION ALL SELECT 22, row_security_active((SELECT oid FROM tbl)) IS FALSE, 1
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

\echo '== evidence checks (1-13) =='
WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
rel(nm, oid, relowner, relrowsecurity, relforcerowsecurity) AS (
  SELECT c.relname, c.oid, c.relowner, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub)),
doc AS (SELECT * FROM rel WHERE nm = 'Document'),
ns AS (SELECT * FROM rel WHERE nm = 'NotificationSettings'),
me AS (SELECT oid FROM pg_roles WHERE rolname = current_user),
col AS (SELECT a.attrelid, a.attname, format_type(a.atttypid, a.atttypmod) AS typ, a.attnotnull, a.atthasdef
        FROM pg_attribute a
        WHERE NOT a.attisdropped
          AND ((a.attrelid = (SELECT oid FROM doc) AND a.attname = 'statusChangedAt')
            OR (a.attrelid = (SELECT oid FROM ns) AND a.attname = 'appointmentReminderMinutes'))),
col_ok AS (SELECT 1 FROM col WHERE NOT attnotnull AND NOT atthasdef
             AND ((attname = 'statusChangedAt' AND typ = 'timestamp(3) without time zone')
               OR (attname = 'appointmentReminderMinutes' AND typ = 'smallint'))),
chk AS (SELECT k.conname, k.convalidated, pg_get_constraintdef(k.oid) AS def FROM pg_constraint k
        WHERE k.conrelid = (SELECT oid FROM ns) AND k.contype = 'c' AND k.conname = 'NotificationSettings_appointment_reminder'),
chk_ok AS (SELECT 1 FROM chk WHERE convalidated
             AND def LIKE '%"appointmentReminderMinutes" IS NULL%'
             AND def LIKE '%ARRAY[30, 60, 120, 1440]%'),
fn AS (SELECT p.oid, p.proname, p.prosecdef, p.proowner, p.proconfig, p.proacl, l.lanname FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
       WHERE p.pronamespace = (SELECT oid FROM pub) AND p.proname = 'document_status_changed_at'),
fn_ok AS (SELECT 1 FROM fn WHERE proowner = (SELECT oid FROM me) AND NOT prosecdef AND lanname = 'plpgsql'
            AND proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']::text[]),
fn_exec AS (SELECT x.grantee FROM fn CROSS JOIN LATERAL aclexplode(coalesce(fn.proacl, acldefault('f', fn.proowner))) x
            WHERE x.privilege_type = 'EXECUTE' AND x.grantee <> fn.proowner),
tg AS (SELECT tg.tgname, tg.tgrelid, tg.tgtype, tg.tgenabled, tg.tgattr, p.proname FROM pg_trigger tg JOIN pg_proc p ON p.oid = tg.tgfoid
       WHERE NOT tg.tgisinternal AND tg.tgname = 'Document_status_changed_at'),
-- tgtype bits: 1 row level, 2 before, 4 on a new row, 8 on removal, 16 on a change, 64 instead (here 1 | 2 | 4 | 16 = 23)
tg_ok AS (SELECT 1 FROM tg WHERE tgrelid = (SELECT oid FROM doc) AND tgtype = (1 | 2 | 4 | 16) AND tgenabled = 'O'
            AND proname = 'document_status_changed_at'
            AND array_length(tgattr::int2[], 1) = 2
            AND (SELECT array_agg(attname::text ORDER BY attname::text) FROM pg_attribute
                  WHERE attrelid = tg.tgrelid AND attnum = ANY (tg.tgattr::int2[])) = ARRAY['status', 'statusChangedAt']::text[]),
docpol AS (SELECT p.polname, p.polcmd, p.polroles, pg_get_expr(p.polqual, p.polrelid) AS q FROM pg_policy p WHERE p.polrelid = (SELECT oid FROM doc)),
nspol AS (SELECT p.polname, pg_get_expr(p.polqual, p.polrelid) AS q, pg_get_expr(p.polwithcheck, p.polrelid) AS w
          FROM pg_policy p WHERE p.polrelid = (SELECT oid FROM ns)),
roles AS (SELECT rolname FROM pg_roles WHERE rolname IN ('app_runtime', 'app_admin')),
priv(mismatch) AS (
            SELECT 'admin' WHERE EXISTS (SELECT 1 FROM roles WHERE rolname = 'app_admin')
                             AND has_column_privilege('app_admin', '"Document"', 'statusChangedAt', 'SELECT')
  UNION ALL SELECT 'column_acl' WHERE EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = (SELECT oid FROM doc)
                                                AND a.attname = 'statusChangedAt' AND a.attacl IS NOT NULL)
  UNION ALL SELECT 'runtime_read' WHERE EXISTS (SELECT 1 FROM roles WHERE rolname = 'app_runtime')
               AND has_column_privilege('app_runtime', '"Document"', 'statusChangedAt', 'SELECT')
                   IS DISTINCT FROM has_column_privilege('app_runtime', '"Document"', 'status', 'SELECT')
  UNION ALL SELECT 'no_runtime' WHERE NOT EXISTS (SELECT 1 FROM roles WHERE rolname = 'app_runtime')
),
mig AS (SELECT started_at FROM "_prisma_migrations" WHERE migration_name = '20261213090000_notification_docs_stuck_appointment_lead'
          AND finished_at IS NOT NULL AND rolled_back_at IS NULL),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM mig) = 1, (SELECT count(*) FROM mig)
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261213090000_notification_docs_stuck_appointment_lead'
                        AND checksum = '2e2b8c46d15dbb8b40483b3495a64acb829ba9cc9b4c7f3402c0574981b934ba'), 1
  UNION ALL SELECT 4, (SELECT count(*) FROM col) = 2 AND (SELECT count(*) FROM col_ok) = 2, (SELECT count(*) FROM col_ok)
  UNION ALL SELECT 5, (SELECT count(*) FROM chk_ok) = 1, (SELECT count(*) FROM chk_ok)
  UNION ALL SELECT 6, (SELECT count(*) FROM fn) = 1 AND (SELECT count(*) FROM fn_ok) = 1, (SELECT count(*) FROM fn_ok)
  UNION ALL SELECT 7, NOT EXISTS (SELECT 1 FROM fn_exec), (SELECT count(*) FROM fn_exec)
  UNION ALL SELECT 8, (SELECT count(*) FROM tg) = 1 AND (SELECT count(*) FROM tg_ok) = 1, (SELECT count(*) FROM tg_ok)
  UNION ALL SELECT 9, (SELECT count(*) FROM doc WHERE relrowsecurity AND relforcerowsecurity) = 1
                      AND (SELECT count(*) FROM docpol) = 2
                      AND (SELECT count(*) FROM docpol WHERE polname = 'p7w4d_tenant' AND polcmd = '*' AND q LIKE '%app.current_business_id%') = 1
                      AND (SELECT count(*) FROM docpol WHERE polname = 'p7adm_read' AND polcmd = 'r') = 1,
                      (SELECT count(*) FROM docpol)
  UNION ALL SELECT 10, NOT EXISTS (SELECT 1 FROM priv), (SELECT count(*) FROM priv)
  UNION ALL SELECT 11, (SELECT count(*) FROM ns WHERE relrowsecurity AND relforcerowsecurity) = 1
                       AND (SELECT count(*) FROM nspol) = 4
                       AND (SELECT count(*) FROM nspol WHERE polname LIKE 'notification\_settings\_tenant\_%'
                              AND coalesce(q, w) LIKE '%app.current_business_id%') = 4,
                       (SELECT count(*) FROM nspol)
  UNION ALL SELECT 12, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261212090000_notification_engine_activation'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1,
                       (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261212090000_notification_engine_activation'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 13, (SELECT count(*) FROM "Document" d
                          WHERE d."statusChangedAt" < ((SELECT started_at FROM mig) AT TIME ZONE 'UTC') - interval '1 minute') = 0,
                       (SELECT count(*) FROM "Document" d
                          WHERE d."statusChangedAt" < ((SELECT started_at FROM mig) AT TIME ZONE 'UTC') - interval '1 minute')
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
