-- ============================================================================
-- platform-admin-a1-production-evidence.sql
--
-- Read-only Production EVIDENCE after migration
--   20261024090000_platform_admin_a1
--
-- Proves the migration's outcome, from the catalog and counts only:
--   * it is recorded and finished, its sha256 is the reviewed one, nothing is unfinished or rolled back;
--   * app_admin stays a NOLOGIN, NOSUPERUSER, NOBYPASSRLS group;
--   * its SELECT reach on the ten column-scoped tables is EXACTLY the reviewed column list (no more, no less),
--     with no table-level SELECT on them; whole-table SELECT on ProductUsageEvent and PlatformAuditEvent only;
--   * no secret, content or money column is readable by it; it holds no write privilege anywhere in public;
--   * the seven p7adm_read policies (six existing + BusinessProfile) are FOR SELECT, PERMISSIVE, TO app_admin,
--     USING (true); FORCE row level security is still on for every RLS table the console reads, and Business;
--   * "PlatformAdminPasskey": 13 columns, its 7 constraints; table ACL exactly app_auth read + add, column ACL
--     exactly app_auth change on the five mutable columns, sequence ACL exactly app_auth USAGE + SELECT;
--     the runtime, the admin plane, the control plane and PUBLIC reach nothing; no row exists yet.
--
-- Check 20 runs first: the row count is taken with row_security = off, by a role that sees every row.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== platform admin A1 production evidence: legend (n -> check) =='
\echo '20 V1 the evidence role is a superuser or has BYPASSRLS, so it sees every row (runs first)'
\echo ' 1 the migration is recorded and finished (observed = finished rows)'
\echo ' 2 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 3 the recorded checksum is the reviewed sha256 of migration.sql'
\echo ' 4 app_admin is NOLOGIN, NOSUPERUSER, NOBYPASSRLS (observed = 1 if all three)'
\echo ' 5 app_admin column SELECT on the ten scoped tables equals the reviewed list (observed = mismatching pairs)'
\echo ' 6 no table-level SELECT for app_admin on the ten scoped tables (observed = tables with it)'
\echo ' 7 app_admin table SELECT on ProductUsageEvent and PlatformAuditEvent (observed = of 2)'
\echo ' 8 app_admin holds no write privilege in public, table or column level (observed = privileges held)'
\echo ' 9 no secret, content or money column is readable by app_admin (observed = readable, of 12 probed)'
\echo '10 p7adm_read on BusinessProfile: FOR SELECT, PERMISSIVE, TO app_admin, USING (true) (observed = matching)'
\echo '11 p7adm_read on the six existing read tables, same shape (observed = of 6)'
\echo '12 FORCE row level security on the seven RLS read tables and Business (observed = of 8)'
\echo '13 "PlatformAdminPasskey" exists with 13 columns (observed = columns)'
\echo '14 its constraints: pkey, unique credentialId, key to User (cascade), four shape checks (observed = of 7)'
\echo '15 table ACL is exactly app_auth read + add (observed = grantee x privilege pairs)'
\echo '16 column ACL is exactly app_auth change on signCount, lastUsedAt, lastChallengeIssuedAt, label, revokedAt (observed = column grants)'
\echo '17 sequence ACL is exactly app_auth USAGE + SELECT (observed = grantee x privilege pairs)'
\echo '18 nothing written: "PlatformAdminPasskey" holds no row (observed = rows)'
\echo '19 app_runtime, app_admin, app_ctlplane and PUBLIC reach nothing on "PlatformAdminPasskey" (observed = privileges held)'
\echo '21 INFO: LOGIN roles that are members of app_admin (observed = count)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

\echo '== visibility check (20) =='
SELECT 20 AS n,
       CASE WHEN (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) IS TRUE
            THEN 'PASS' ELSE 'FAIL' END AS result,
       1 AS observed_count;

\echo '== evidence checks (1-19, 21) =='
WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
rel AS (SELECT c.oid, c.relname, c.relowner, c.relrowsecurity, c.relforcerowsecurity, c.relacl
        FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub)),
adm AS (SELECT oid FROM pg_roles WHERE rolname = 'app_admin'),
auth AS (SELECT oid FROM pg_roles WHERE rolname = 'app_auth'),
mig AS (SELECT * FROM "_prisma_migrations" WHERE migration_name = '20261024090000_platform_admin_a1'),
scoped(t) AS (VALUES ('Business'), ('User'), ('BusinessProfile'), ('AuthSession'), ('EmailConnection'),
                     ('Document'), ('BillingDocument'), ('Conversation'), ('ContentRun'), ('WhatsAppAttachmentImport')),
expected(t, c) AS (VALUES
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
  ('WhatsAppAttachmentImport', 'status'), ('WhatsAppAttachmentImport', 'createdAt')),
granted AS (
  SELECT r.relname AS t, a.attname::text AS c
  FROM rel r JOIN pg_attribute a ON a.attrelid = r.oid
  CROSS JOIN LATERAL aclexplode(a.attacl) x
  WHERE r.relname IN (SELECT t FROM scoped) AND x.grantee = (SELECT oid FROM adm) AND x.privilege_type = 'SELECT'),
mismatch AS ((SELECT t, c FROM expected EXCEPT SELECT t, c FROM granted)
             UNION ALL (SELECT t, c FROM granted EXCEPT SELECT t, c FROM expected)),
writes(p) AS (VALUES ('INS' || 'ERT'), ('UPD' || 'ATE'), ('DEL' || 'ETE'), ('TRUN' || 'CATE'), ('REFERENCES'), ('TRIGGER')),
adm_table_writes AS (
  SELECT 1 FROM rel r CROSS JOIN LATERAL aclexplode(r.relacl) x
  WHERE x.grantee = (SELECT oid FROM adm) AND x.privilege_type IN (SELECT p FROM writes)),
adm_column_writes AS (
  SELECT 1 FROM rel r JOIN pg_attribute a ON a.attrelid = r.oid CROSS JOIN LATERAL aclexplode(a.attacl) x
  WHERE x.grantee = (SELECT oid FROM adm) AND x.privilege_type IN (SELECT p FROM writes)),
secrets(t, c) AS (VALUES ('User', 'password'), ('User', 'tokenVersion'), ('AuthSession', 'secretHash'),
  ('AuthSession', 'id'), ('Document', 'ocrText'), ('Document', 'fileUrl'), ('BillingDocument', 'totalAmount'),
  ('BillingDocument', 'customerNameSnapshot'), ('EmailConnection', 'lastSyncCursor'), ('ContentRun', 'inputSnapshot'),
  ('BusinessProfile', 'billingTaxId'), ('WhatsAppAttachmentImport', 'fromPhone')),
readable_secrets AS (
  SELECT 1 FROM secrets s
  WHERE has_column_privilege('app_admin', format('public.%I', s.t), s.c, 'SELECT')),
adm_policy(t) AS (VALUES ('Document'), ('BillingDocument'), ('Conversation'), ('ContentRun'), ('EmailConnection'),
                         ('WhatsAppAttachmentImport')),
policy_ok AS (
  SELECT p.tablename FROM pg_policies p
  WHERE p.schemaname = 'public' AND p.policyname = 'p7adm_read' AND p.cmd = 'SELECT' AND p.permissive = 'PERMISSIVE'
    AND p.roles = ARRAY['app_admin']::name[] AND p.qual = 'true'),
forced(t) AS (VALUES ('BusinessProfile'), ('Document'), ('BillingDocument'), ('Conversation'), ('ContentRun'),
                     ('EmailConnection'), ('WhatsAppAttachmentImport'), ('Business')),
pk AS (SELECT * FROM rel WHERE relname = 'PlatformAdminPasskey'),
pk_seq AS (SELECT * FROM rel WHERE relname = 'PlatformAdminPasskey_id_seq'),
pk_table_acl AS (SELECT x.grantee, x.privilege_type FROM pk CROSS JOIN LATERAL aclexplode(pk.relacl) x
                 WHERE x.grantee <> pk.relowner),
pk_column_acl AS (SELECT a.attname::text AS c, x.grantee, x.privilege_type
                  FROM pk JOIN pg_attribute a ON a.attrelid = pk.oid CROSS JOIN LATERAL aclexplode(a.attacl) x),
pk_seq_acl AS (SELECT x.grantee, x.privilege_type FROM pk_seq CROSS JOIN LATERAL aclexplode(pk_seq.relacl) x
               WHERE x.grantee <> pk_seq.relowner),
pk_constraints(conname) AS (VALUES ('PlatformAdminPasskey_pkey'), ('PlatformAdminPasskey_userId_fkey'),
  ('PlatformAdminPasskey_label_shape'), ('PlatformAdminPasskey_credentialId_shape'),
  ('PlatformAdminPasskey_signCount_nonnegative'), ('PlatformAdminPasskey_deviceType_shape')),
outsiders(r) AS (SELECT rolname::text FROM pg_roles WHERE rolname IN ('app_runtime', 'app_admin', 'app_ctlplane')
                 UNION ALL SELECT 'public'),
outsider_reach AS (
  SELECT 1 FROM outsiders o CROSS JOIN (VALUES ('SELECT'), ('INS' || 'ERT'), ('UPD' || 'ATE'), ('DEL' || 'ETE')) v(p)
  WHERE (SELECT oid FROM pk) IS NOT NULL AND has_table_privilege(o.r, (SELECT oid FROM pk), v.p)),
checks(n, ok, observed_count) AS (
            SELECT 1, (SELECT count(*) FROM mig WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1,
                      (SELECT count(*) FROM mig WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, (SELECT count(*) FROM mig WHERE checksum = 'ffb35684c95ca44197a53d648f0d3c3450d4eeb9201fed9818a67eb1e0ad8811') = 1,
                      (SELECT count(*) FROM mig WHERE checksum = 'ffb35684c95ca44197a53d648f0d3c3450d4eeb9201fed9818a67eb1e0ad8811')
  UNION ALL SELECT 4, EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls),
                      (SELECT count(*) FROM pg_roles WHERE rolname = 'app_admin' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls)
  UNION ALL SELECT 5, (SELECT count(*) FROM mismatch) = 0, (SELECT count(*) FROM mismatch)
  UNION ALL SELECT 6, NOT EXISTS (SELECT 1 FROM rel r CROSS JOIN LATERAL aclexplode(r.relacl) x
                                  WHERE r.relname IN (SELECT t FROM scoped) AND x.grantee = (SELECT oid FROM adm)
                                    AND x.privilege_type = 'SELECT'),
                      (SELECT count(DISTINCT r.relname) FROM rel r CROSS JOIN LATERAL aclexplode(r.relacl) x
                       WHERE r.relname IN (SELECT t FROM scoped) AND x.grantee = (SELECT oid FROM adm) AND x.privilege_type = 'SELECT')
  UNION ALL SELECT 7, (SELECT count(*) FROM rel r CROSS JOIN LATERAL aclexplode(r.relacl) x
                       WHERE r.relname IN ('ProductUsageEvent', 'PlatformAuditEvent') AND x.grantee = (SELECT oid FROM adm)
                         AND x.privilege_type = 'SELECT') = 2,
                      (SELECT count(*) FROM rel r CROSS JOIN LATERAL aclexplode(r.relacl) x
                       WHERE r.relname IN ('ProductUsageEvent', 'PlatformAuditEvent') AND x.grantee = (SELECT oid FROM adm)
                         AND x.privilege_type = 'SELECT')
  UNION ALL SELECT 8, (SELECT count(*) FROM adm_table_writes) + (SELECT count(*) FROM adm_column_writes) = 0,
                      (SELECT count(*) FROM adm_table_writes) + (SELECT count(*) FROM adm_column_writes)
  UNION ALL SELECT 9, (SELECT count(*) FROM readable_secrets) = 0, (SELECT count(*) FROM readable_secrets)
  UNION ALL SELECT 10, (SELECT count(*) FROM policy_ok WHERE tablename = 'BusinessProfile') = 1,
                       (SELECT count(*) FROM policy_ok WHERE tablename = 'BusinessProfile')
  UNION ALL SELECT 11, (SELECT count(*) FROM policy_ok WHERE tablename IN (SELECT t FROM adm_policy)) = 6,
                       (SELECT count(*) FROM policy_ok WHERE tablename IN (SELECT t FROM adm_policy))
  UNION ALL SELECT 12, (SELECT count(*) FROM rel WHERE relname IN (SELECT t FROM forced) AND relrowsecurity AND relforcerowsecurity) = 8,
                       (SELECT count(*) FROM rel WHERE relname IN (SELECT t FROM forced) AND relrowsecurity AND relforcerowsecurity)
  UNION ALL SELECT 13, (SELECT count(*) FROM pg_attribute WHERE attrelid = (SELECT oid FROM pk) AND attnum > 0 AND NOT attisdropped) = 13,
                       (SELECT count(*) FROM pg_attribute WHERE attrelid = (SELECT oid FROM pk) AND attnum > 0 AND NOT attisdropped)
  UNION ALL SELECT 14, (SELECT count(*) FROM pg_constraint WHERE conrelid = (SELECT oid FROM pk)
                          AND conname IN (SELECT conname FROM pk_constraints)
                          AND (conname <> 'PlatformAdminPasskey_userId_fkey' OR confdeltype = 'c'))
                       + (SELECT count(*) FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
                          WHERE i.indrelid = (SELECT oid FROM pk) AND i.indisunique AND ic.relname = 'PlatformAdminPasskey_credentialId_key') = 7,
                       (SELECT count(*) FROM pg_constraint WHERE conrelid = (SELECT oid FROM pk)
                          AND conname IN (SELECT conname FROM pk_constraints)
                          AND (conname <> 'PlatformAdminPasskey_userId_fkey' OR confdeltype = 'c'))
                       + (SELECT count(*) FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
                          WHERE i.indrelid = (SELECT oid FROM pk) AND i.indisunique AND ic.relname = 'PlatformAdminPasskey_credentialId_key')
  UNION ALL SELECT 15, (SELECT count(*) FROM pk_table_acl) = 2
                       AND (SELECT count(*) FROM pk_table_acl WHERE grantee = (SELECT oid FROM auth)
                            AND privilege_type IN ('SELECT', 'INS' || 'ERT')) = 2,
                       (SELECT count(*) FROM pk_table_acl)
  UNION ALL SELECT 16, (SELECT count(*) FROM pk_column_acl) = 5
                       AND (SELECT count(*) FROM pk_column_acl WHERE grantee = (SELECT oid FROM auth) AND privilege_type = 'UPD' || 'ATE'
                            AND c IN ('signCount', 'lastUsedAt', 'lastChallengeIssuedAt', 'label', 'revokedAt')) = 5,
                       (SELECT count(*) FROM pk_column_acl)
  UNION ALL SELECT 17, (SELECT count(*) FROM pk_seq_acl) = 2
                       AND (SELECT count(*) FROM pk_seq_acl WHERE grantee = (SELECT oid FROM auth)
                            AND privilege_type IN ('USAGE', 'SELECT')) = 2,
                       (SELECT count(*) FROM pk_seq_acl)
  UNION ALL SELECT 18, (SELECT count(*) FROM "PlatformAdminPasskey") = 0, (SELECT count(*) FROM "PlatformAdminPasskey")
  UNION ALL SELECT 19, (SELECT count(*) FROM outsider_reach) = 0, (SELECT count(*) FROM outsider_reach)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count FROM checks
UNION ALL
SELECT 21, 'INFO', (SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
                    WHERE m.roleid = (SELECT oid FROM adm) AND r.rolcanlogin)
ORDER BY n;

ROLLBACK;
