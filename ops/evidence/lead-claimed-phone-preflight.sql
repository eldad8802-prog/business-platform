-- ============================================================================
-- lead-claimed-phone-preflight.sql
--
-- Read-only PRE-APPLY proof for migration
--   20261108090000_lead_claimed_phone
-- Everything it builds on is present and exactly as expected; nothing it adds exists yet.
--
-- NO DATA ROW is read except counts. Catalog and ledger rows only.
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- Guard-clean: no write keyword anywhere, prose included (privilege names are spelled in parts).
-- ============================================================================

\echo '== Lead claimedPhone preflight — legend (n → check) =='
\echo ' 1 Q0 the public booking foundation (the newest migration this one follows) is recorded and finished'
\echo ' 2 Q1 ledger: no unfinished and no rolled-back row'
\echo ' 3 Q2 this migration is not recorded and no newer one is (observed = such rows)'
\echo ' 4 T0 nothing it adds exists: the column, the CHECK, the index (observed = objects)'
\echo ' 5 I0 Lead_open_phone_key is the one-open-lead-per-phone partial UNIQUE index on (businessId, phone)'
\echo ' 6 R0 runtime logins NOSUPERUSER NOBYPASSRLS'
\echo ' 7 R1 PRODUCTION PREMISE: Lead under ENABLE + FORCE RLS'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
lead AS (SELECT oid, relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relnamespace = (SELECT oid FROM pub) AND relname = 'Lead' AND relkind = 'r'),
rt AS (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime'),
runtime_roles AS (SELECT r.oid, r.rolsuper, r.rolbypassrls FROM pg_roles r
                  WHERE r.oid = (SELECT oid FROM rt)
                     OR (r.rolcanlogin AND r.rolname <> current_user AND EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid AND m.roleid = (SELECT oid FROM rt)))),
added AS (
  SELECT (SELECT count(*) FROM pg_attribute WHERE attrelid = (SELECT oid FROM lead) AND attname = 'claimedPhone' AND NOT attisdropped)
       + (SELECT count(*) FROM pg_constraint WHERE conrelid = (SELECT oid FROM lead) AND conname = 'Lead_claimedPhone_digits')
       + (SELECT count(*) FROM pg_class WHERE relnamespace = (SELECT oid FROM pub) AND relname = 'Lead_businessId_claimedPhone_idx') AS n),
open_phone AS (
  SELECT count(*) AS n FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE i.indrelid = (SELECT oid FROM lead) AND c.relname = 'Lead_open_phone_key' AND i.indisunique AND i.indpred IS NOT NULL
     AND pg_get_indexdef(i.indexrelid) LIKE '%("businessId", phone)%'
     AND pg_get_indexdef(i.indexrelid) LIKE '%phone IS NOT NULL%'),
checks(n, ok, observed_count) AS (
  SELECT 1, EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261106090000_public_booking_foundation'
                     AND finished_at IS NOT NULL AND rolled_back_at IS NULL),
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261106090000_public_booking_foundation')
  UNION ALL SELECT 2, NOT EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL),
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, NOT EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name >= '20261108090000_lead_claimed_phone'),
                      (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name >= '20261108090000_lead_claimed_phone')
  UNION ALL SELECT 4, (SELECT n FROM added) = 0, (SELECT n FROM added)
  UNION ALL SELECT 5, (SELECT n FROM open_phone) = 1, (SELECT n FROM open_phone)
  UNION ALL SELECT 6, NOT EXISTS (SELECT 1 FROM runtime_roles WHERE rolsuper OR rolbypassrls) AND EXISTS (SELECT 1 FROM rt),
                      (SELECT count(*) FROM runtime_roles WHERE rolsuper OR rolbypassrls)
  UNION ALL SELECT 7, COALESCE((SELECT relrowsecurity AND relforcerowsecurity FROM lead), false),
                      (SELECT count(*) FROM lead WHERE relrowsecurity AND relforcerowsecurity)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count FROM checks ORDER BY n;

ROLLBACK;
