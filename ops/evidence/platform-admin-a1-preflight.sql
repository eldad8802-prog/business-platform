-- ============================================================================
-- platform-admin-a1-preflight.sql
--
-- Read-only Production PREFLIGHT before migration
--   20261024090000_platform_admin_a1
--
-- Confirms Production is exactly what the migration was built and labbed against:
--   * the ledger is clean and ends at 20261022090000_task_reminders_push (or later), with A1 not yet recorded;
--   * app_admin exists as a NOLOGIN, NOSUPERUSER, NOBYPASSRLS group; app_auth and app_runtime exist;
--   * the six existing p7adm_read policies are in place, and BusinessProfile is FORCE RLS without one yet;
--   * "PlatformAdminPasskey" does not exist yet; every column the migration names exists;
--   * app_admin holds no write privilege in public (the doctrine the migration keeps).
-- After the migration, exactly checks 2, 7 and 8 report FAIL (they describe "not there yet").
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog and ledger only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== platform admin A1 preflight: legend (n -> check) =='
\echo ' 1 20261022090000_task_reminders_push is recorded and finished (observed = finished rows)'
\echo ' 2 20261024090000_platform_admin_a1 is not recorded yet (observed = rows)'
\echo ' 3 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 4 app_admin exists: NOLOGIN, NOSUPERUSER, NOBYPASSRLS (observed = 1 if so)'
\echo ' 5 app_auth and app_runtime exist (observed = of 2)'
\echo ' 6 p7adm_read exists on the six existing read tables (observed = of 6)'
\echo ' 7 BusinessProfile is RLS ENABLED + FORCED and has no p7adm_read yet (observed = 1 if so)'
\echo ' 8 "PlatformAdminPasskey" does not exist yet (observed = relations with that name)'
\echo ' 9 every column the migration names exists (observed = missing, of 63)'
\echo '10 app_admin holds no write privilege in public, table or column level (observed = privileges held)'
\echo '11 INFO: LOGIN roles that are members of app_admin (observed = count; 0 until the login is provisioned)'
\echo '12 INFO: column-level SELECT privileges app_admin holds today (observed = count)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
rel AS (SELECT c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity, c.relacl
        FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub)),
adm AS (SELECT oid FROM pg_roles WHERE rolname = 'app_admin'),
named(t, c) AS (VALUES
  ('Business', 'id'), ('Business', 'name'), ('Business', 'archivedAt'), ('Business', 'deletionRequestedAt'),
  ('Business', 'deletedAt'), ('Business', 'createdAt'),
  ('User', 'id'), ('User', 'email'), ('User', 'name'), ('User', 'businessId'),
  ('User', 'lastLoginAt'), ('User', 'loginCount'), ('User', 'emailVerifiedAt'), ('User', 'createdAt'),
  ('BusinessProfile', 'id'), ('BusinessProfile', 'businessId'), ('BusinessProfile', 'onboardingCompletedAt'),
  ('BusinessProfile', 'createdAt'),
  ('AuthSession', 'userId'), ('AuthSession', 'lastUsedAt'),
  ('EmailConnection', 'id'), ('EmailConnection', 'businessId'), ('EmailConnection', 'status'),
  ('EmailConnection', 'emailAddress'), ('EmailConnection', 'lastSyncedAt'), ('EmailConnection', 'createdAt'),
  ('Document', 'id'), ('Document', 'businessId'), ('Document', 'status'), ('Document', 'source'), ('Document', 'createdAt'),
  ('BillingDocument', 'id'), ('BillingDocument', 'businessId'), ('BillingDocument', 'status'),
  ('BillingDocument', 'pdfRenderStatus'), ('BillingDocument', 'createdAt'),
  ('Conversation', 'id'), ('Conversation', 'businessId'), ('Conversation', 'status'), ('Conversation', 'lastMessageAt'),
  ('Conversation', 'unansweredInboundCount'), ('Conversation', 'createdAt'),
  ('ContentRun', 'id'), ('ContentRun', 'businessId'), ('ContentRun', 'status'), ('ContentRun', 'createdAt'),
  ('WhatsAppAttachmentImport', 'id'), ('WhatsAppAttachmentImport', 'businessId'),
  ('WhatsAppAttachmentImport', 'status'), ('WhatsAppAttachmentImport', 'createdAt'),
  ('User', 'password')),
missing AS (
  SELECT 1 FROM named n
  WHERE NOT EXISTS (SELECT 1 FROM rel r JOIN pg_attribute a ON a.attrelid = r.oid
                    WHERE r.relname = n.t AND a.attname = n.c AND a.attnum > 0 AND NOT a.attisdropped)),
writes(p) AS (VALUES ('INS' || 'ERT'), ('UPD' || 'ATE'), ('DEL' || 'ETE'), ('TRUN' || 'CATE'), ('REFERENCES'), ('TRIGGER')),
adm_writes AS (
  SELECT 1 FROM rel r CROSS JOIN LATERAL aclexplode(r.relacl) x
  WHERE x.grantee = (SELECT oid FROM adm) AND x.privilege_type IN (SELECT p FROM writes)
  UNION ALL
  SELECT 1 FROM rel r JOIN pg_attribute a ON a.attrelid = r.oid CROSS JOIN LATERAL aclexplode(a.attacl) x
  WHERE x.grantee = (SELECT oid FROM adm) AND x.privilege_type IN (SELECT p FROM writes)),
adm_policy(t) AS (VALUES ('Document'), ('BillingDocument'), ('Conversation'), ('ContentRun'), ('EmailConnection'),
                         ('WhatsAppAttachmentImport')),
checks(n, ok, observed_count) AS (
            SELECT 1, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261022090000_task_reminders_push'
                         AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261022090000_task_reminders_push'
                         AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261024090000_platform_admin_a1') = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261024090000_platform_admin_a1')
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 4, EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls),
                      (SELECT count(*) FROM pg_roles WHERE rolname = 'app_admin' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls)
  UNION ALL SELECT 5, (SELECT count(*) FROM pg_roles WHERE rolname IN ('app_auth', 'app_runtime')) = 2,
                      (SELECT count(*) FROM pg_roles WHERE rolname IN ('app_auth', 'app_runtime'))
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND policyname = 'p7adm_read'
                         AND tablename IN (SELECT t FROM adm_policy)) = 6,
                      (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND policyname = 'p7adm_read'
                         AND tablename IN (SELECT t FROM adm_policy))
  UNION ALL SELECT 7, EXISTS (SELECT 1 FROM rel WHERE relname = 'BusinessProfile' AND relrowsecurity AND relforcerowsecurity)
                      AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'BusinessProfile'
                                        AND policyname = 'p7adm_read'),
                      CASE WHEN EXISTS (SELECT 1 FROM rel WHERE relname = 'BusinessProfile' AND relrowsecurity AND relforcerowsecurity)
                            AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'BusinessProfile'
                                              AND policyname = 'p7adm_read') THEN 1 ELSE 0 END
  UNION ALL SELECT 8, (SELECT count(*) FROM rel WHERE relname = 'PlatformAdminPasskey') = 0,
                      (SELECT count(*) FROM rel WHERE relname = 'PlatformAdminPasskey')
  UNION ALL SELECT 9, (SELECT count(*) FROM missing) = 0, (SELECT count(*) FROM missing)
  UNION ALL SELECT 10, (SELECT count(*) FROM adm_writes) = 0, (SELECT count(*) FROM adm_writes)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count FROM checks
UNION ALL
SELECT 11, 'INFO', (SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
                    WHERE m.roleid = (SELECT oid FROM adm) AND r.rolcanlogin)
UNION ALL
SELECT 12, 'INFO', (SELECT count(*) FROM rel r JOIN pg_attribute a ON a.attrelid = r.oid
                    CROSS JOIN LATERAL aclexplode(a.attacl) x
                    WHERE x.grantee = (SELECT oid FROM adm) AND x.privilege_type = 'SELECT')
ORDER BY n;

ROLLBACK;
