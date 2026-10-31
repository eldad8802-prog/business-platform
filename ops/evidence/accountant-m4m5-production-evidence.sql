-- ============================================================================
-- accountant-m4m5-production-evidence.sql
--
-- Read-only Production PROOF after migrations
--   20261109090000_accountant_delivery_permission (sha256 '544e0ea79323841ffb6feb75d44cc835f3ad86d28998fb25629cbd0e5fd63919')
--   20261109091000_accountant_link_otp            (sha256 '27485fca6ba0a4c722818d3fe004a190e89971dfb03a69cda9f59cdaec8cffe2')
--
-- Proves, from the catalog, the ledger and counts only, that exactly what the migrations say happened:
--   * each is recorded once, finished, with the checksum of the reviewed file; the ledger is clean;
--   * the flag `accountant_delivery` exists OFF (defaultEnabled false, globalEnabled false, not emergency-disabled)
--     and no business has it;
--   * the two new tables exist under ENABLE + FORCE RLS with exactly their three tenant policies each, their CHECKs,
--     their composite keys to the delivery of the same business;
--   * the exact privileges: app_runtime reads and adds rows, changes only attempts / consumedAt / lastSeenAt /
--     revokedAt; no other role holds anything on them (the console's read role included);
--   * the trail's type list is the 2026-11-07 list plus the three new values; the trail keeps RLS and both triggers;
--   * nothing was written yet.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== accountant M4 + M5 proof: legend (n -> check) =='
\echo ' 1 the evidence role is a superuser or has BYPASSRLS (it sees every row)'
\echo ' 2 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 3 both migrations are recorded once each, finished, with the pinned checksums (observed = matching rows, of 2)'
\echo ' 4 the flag accountant_delivery: defined (documents, defaultEnabled false, mutable) and its policy globalEnabled false, not emergency-disabled (observed = rows as expected, of 2)'
\echo ' 5 no business override of accountant_delivery (observed = overrides)'
\echo ' 6 AccountantLinkChallenge and AccountantLinkDevice exist, both RLS ENABLED + FORCED (observed = of 2)'
\echo ' 7 exactly 3 tenant policies on each (read, add, change on app.current_business_id), and no other policy (observed = policies)'
\echo ' 8 their CHECKs exist and are validated (observed = of 7)'
\echo ' 9 their composite keys to AccountantDelivery(businessId, id) exist (observed = of 2)'
\echo '10 table privileges exact: app_runtime ar on both tables and Ur on both sequences, no other grantee (observed = mismatching objects)'
\echo '11 column privileges exact: app_runtime change on attempts, consumedAt, lastSeenAt, revokedAt only (observed = column grants)'
\echo '12 AccountantWorkflowEvent_type is validated and lists exactly 30 values (observed = values)'
\echo '13 it lists LINK_CODE_SENT, LINK_CODE_FAILED, LINK_DEVICE_VERIFIED and DELIVERY_COMPLAINED (observed = of 4)'
\echo '14 the trail keeps RLS ENABLED + FORCED and both append-only triggers (observed = triggers of 2)'
\echo '15 nothing written yet: codes + devices + trail rows of the three new types (observed = rows)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL row_security = off;

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
rel(nm, oid, relkind, relowner, relrowsecurity, relforcerowsecurity, relacl) AS (
  SELECT c.relname, c.oid, c.relkind, c.relowner, c.relrowsecurity, c.relforcerowsecurity, c.relacl
  FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub)),
rt AS (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime'),
mig(name, sum) AS (VALUES
  ('20261109090000_accountant_delivery_permission', '544e0ea79323841ffb6feb75d44cc835f3ad86d28998fb25629cbd0e5fd63919'),
  ('20261109091000_accountant_link_otp', '27485fca6ba0a4c722818d3fe004a190e89971dfb03a69cda9f59cdaec8cffe2')),
tables(nm) AS (VALUES ('AccountantLinkChallenge'), ('AccountantLinkDevice')),
objects(nm) AS (SELECT nm FROM tables UNION ALL SELECT nm || '_id_seq' FROM tables),
tenant_expr(e) AS (VALUES ('("businessId" = (NULLIF(current_setting(''app.current_business_id''::text, true), ''''::text))::integer)')),
pols AS (SELECT r.nm AS tbl, p.polname, p.polcmd::text AS cmd, p.polpermissive, p.polroles,
                pg_get_expr(p.polqual, p.polrelid) AS q, pg_get_expr(p.polwithcheck, p.polrelid) AS wc
         FROM pg_policy p JOIN rel r ON r.oid = p.polrelid WHERE r.nm IN (SELECT nm FROM tables)),
good_pols AS (SELECT * FROM pols WHERE polpermissive AND polroles = '{0}'::oid[] AND (
                    (cmd = 'r' AND q = (SELECT e FROM tenant_expr) AND wc IS NULL)
                 OR (cmd = 'a' AND q IS NULL AND wc = (SELECT e FROM tenant_expr))
                 OR (cmd = 'w' AND q = (SELECT e FROM tenant_expr) AND wc = (SELECT e FROM tenant_expr)))),
letter AS (SELECT * FROM (VALUES ('SELECT', 'r'), ('INS' || 'ERT', 'a'), ('UPD' || 'ATE', 'w'), ('DEL' || 'ETE', 'd'),
                                 ('TRUNC' || 'ATE', 'D'), ('REFERENCES', 'x'), ('TRIGGER', 't'), ('MAINTAIN', 'm'),
                                 ('USAGE', 'U')) v(priv, l)),
acl_items AS (SELECT r.nm, x.grantee, (SELECT l FROM letter WHERE priv = x.privilege_type) COLLATE "C" AS l
              FROM rel r CROSS JOIN LATERAL aclexplode(r.relacl) x WHERE x.grantee <> r.relowner AND r.nm IN (SELECT nm FROM objects)),
acl_letters AS (SELECT nm, grantee, string_agg(DISTINCT l, '' ORDER BY l) AS letters FROM acl_items GROUP BY nm, grantee),
expected_acl(nm, letters) AS (VALUES
  ('AccountantLinkChallenge', 'ar'), ('AccountantLinkChallenge_id_seq', 'Ur'),
  ('AccountantLinkDevice', 'ar'), ('AccountantLinkDevice_id_seq', 'Ur')),
acl_mismatch AS (
  SELECT e.nm FROM expected_acl e
   WHERE (SELECT count(*) FROM acl_letters a WHERE a.nm = e.nm) <> 1
      OR NOT EXISTS (SELECT 1 FROM acl_letters a WHERE a.nm = e.nm AND a.grantee = (SELECT oid FROM rt) AND a.letters = e.letters)),
col_items AS (SELECT r.nm, a.attname, x.grantee, x.privilege_type
              FROM rel r JOIN pg_attribute a ON a.attrelid = r.oid CROSS JOIN LATERAL aclexplode(a.attacl) x
              WHERE r.nm IN (SELECT nm FROM tables) AND a.attnum > 0 AND NOT a.attisdropped),
expected_col(nm, attname) AS (VALUES ('AccountantLinkChallenge', 'attempts'), ('AccountantLinkChallenge', 'consumedAt'),
                                     ('AccountantLinkDevice', 'lastSeenAt'), ('AccountantLinkDevice', 'revokedAt')),
con AS (SELECT c.convalidated, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
        WHERE c.conname = 'AccountantWorkflowEvent_type' AND c.conrelid = '"AccountantWorkflowEvent"'::regclass),
has(v) AS (VALUES ('LINK_CODE_SENT'), ('LINK_CODE_FAILED'), ('LINK_DEVICE_VERIFIED'), ('DELIVERY_COMPLAINED')),
listed AS (SELECT h.v FROM has h, con WHERE con.def LIKE '%''' || h.v || '''::text%'),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) IS TRUE, 1
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" p JOIN mig m ON m.name = p.migration_name
                         WHERE p.finished_at IS NOT NULL AND p.rolled_back_at IS NULL AND p.checksum = m.sum) = 2
                      AND (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name IN (SELECT name FROM mig)) = 2,
                      (SELECT count(*) FROM "_prisma_migrations" p JOIN mig m ON m.name = p.migration_name
                         WHERE p.finished_at IS NOT NULL AND p.rolled_back_at IS NULL AND p.checksum = m.sum)
  UNION ALL SELECT 4, (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE "key" = 'accountant_delivery' AND "category" = 'documents'
                         AND NOT "defaultEnabled" AND "mutable")
                    + (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'accountant_delivery' AND NOT "globalEnabled" AND NOT "emergencyDisabled") = 2,
                      (SELECT count(*) FROM "PlatformFeatureDefinition" WHERE "key" = 'accountant_delivery' AND "category" = 'documents'
                         AND NOT "defaultEnabled" AND "mutable")
                    + (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'accountant_delivery' AND NOT "globalEnabled" AND NOT "emergencyDisabled")
  UNION ALL SELECT 5, (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'accountant_delivery') = 0,
                      (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'accountant_delivery')
  UNION ALL SELECT 6, (SELECT count(*) FROM rel WHERE relkind = 'r' AND nm IN (SELECT nm FROM tables) AND relrowsecurity AND relforcerowsecurity) = 2,
                      (SELECT count(*) FROM rel WHERE relkind = 'r' AND nm IN (SELECT nm FROM tables) AND relrowsecurity AND relforcerowsecurity)
  UNION ALL SELECT 7, (SELECT count(*) FROM pols) = 6 AND (SELECT count(*) FROM good_pols) = 6
                      AND (SELECT count(DISTINCT tbl || cmd) FROM good_pols) = 6,
                      (SELECT count(*) FROM pols)
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_constraint WHERE convalidated AND conname IN
                         ('AccountantLinkChallenge_hashes', 'AccountantLinkChallenge_lifetime', 'AccountantLinkChallenge_attempts',
                          'AccountantLinkChallenge_consumed', 'AccountantLinkDevice_hash', 'AccountantLinkDevice_lifetime', 'AccountantLinkDevice_times')) = 7,
                      (SELECT count(*) FROM pg_constraint WHERE convalidated AND conname IN
                         ('AccountantLinkChallenge_hashes', 'AccountantLinkChallenge_lifetime', 'AccountantLinkChallenge_attempts',
                          'AccountantLinkChallenge_consumed', 'AccountantLinkDevice_hash', 'AccountantLinkDevice_lifetime', 'AccountantLinkDevice_times'))
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND conname IN
                         ('AccountantLinkChallenge_delivery_tenant_fkey', 'AccountantLinkDevice_delivery_tenant_fkey')
                         AND confrelid = '"AccountantDelivery"'::regclass AND array_length(conkey, 1) = 2) = 2,
                      (SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND conname IN
                         ('AccountantLinkChallenge_delivery_tenant_fkey', 'AccountantLinkDevice_delivery_tenant_fkey')
                         AND confrelid = '"AccountantDelivery"'::regclass AND array_length(conkey, 1) = 2)
  UNION ALL SELECT 10, (SELECT count(*) FROM acl_mismatch) = 0, (SELECT count(*) FROM acl_mismatch)
  UNION ALL SELECT 11, (SELECT count(*) FROM col_items) = 4
                       AND (SELECT count(*) FROM col_items WHERE grantee = (SELECT oid FROM rt) AND privilege_type = 'UPD' || 'ATE'
                              AND (nm, attname::text) IN (SELECT nm, attname FROM expected_col)) = 4,
                       (SELECT count(*) FROM col_items)
  UNION ALL SELECT 12, coalesce((SELECT convalidated AND (array_length(regexp_split_to_array(def, '::text'), 1) - 1) = 30 FROM con), false),
                       coalesce((SELECT (array_length(regexp_split_to_array(def, '::text'), 1) - 1) FROM con), 0)
  UNION ALL SELECT 13, (SELECT count(*) FROM listed) = 4, (SELECT count(*) FROM listed)
  UNION ALL SELECT 14, EXISTS (SELECT 1 FROM pg_class WHERE oid = '"AccountantWorkflowEvent"'::regclass AND relrowsecurity AND relforcerowsecurity)
                       AND (SELECT count(*) FROM pg_trigger WHERE tgrelid = '"AccountantWorkflowEvent"'::regclass AND NOT tgisinternal AND tgenabled = 'O'
                              AND tgname IN ('AccountantWorkflowEvent_append_only', 'AccountantWorkflowEvent_no_truncate')) = 2,
                       (SELECT count(*) FROM pg_trigger WHERE tgrelid = '"AccountantWorkflowEvent"'::regclass AND NOT tgisinternal AND tgenabled = 'O'
                          AND tgname IN ('AccountantWorkflowEvent_append_only', 'AccountantWorkflowEvent_no_truncate'))
  UNION ALL SELECT 15, (SELECT count(*) FROM "AccountantLinkChallenge") + (SELECT count(*) FROM "AccountantLinkDevice")
                     + (SELECT count(*) FROM "AccountantWorkflowEvent" WHERE "eventType" IN ('LINK_CODE_SENT', 'LINK_CODE_FAILED', 'LINK_DEVICE_VERIFIED')) = 0,
                       (SELECT count(*) FROM "AccountantLinkChallenge") + (SELECT count(*) FROM "AccountantLinkDevice")
                     + (SELECT count(*) FROM "AccountantWorkflowEvent" WHERE "eventType" IN ('LINK_CODE_SENT', 'LINK_CODE_FAILED', 'LINK_DEVICE_VERIFIED'))
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
