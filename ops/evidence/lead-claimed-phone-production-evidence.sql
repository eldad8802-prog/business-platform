-- ============================================================================
-- lead-claimed-phone-production-evidence.sql
--
-- Read-only PROOF, after migration
--   20261108090000_lead_claimed_phone
-- was applied: the reviewed file (sha256 pinned below) is the one recorded and its objects exist exactly as reviewed.
--
--   * recorded and finished, with the reviewed checksum; the ledger is clean;
--   * "Lead"."claimedPhone": text, nullable, no default;
--   * the digits-only CHECK exists and is validated;
--   * a NON-unique index on ("businessId", "claimedPhone");
--   * Lead_open_phone_key unchanged: the partial UNIQUE index on ("businessId", phone), claimedPhone not in it;
--   * "Lead" still under RLS ENABLED + FORCED; runtime logins still NOSUPERUSER NOBYPASSRLS;
--   * no claimed phone written yet (the code that writes it ships after this proof).
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== Lead claimedPhone proof: legend (n -> check) =='
\echo ' 1 the migration is recorded, finished, not rolled back, with checksum 3693bf02…7e5d'
\echo ' 2 ledger: no unfinished and no rolled-back row'
\echo ' 3 Lead.claimedPhone is text, nullable, without a default'
\echo ' 4 the digits-only CHECK exists and is validated'
\echo ' 5 the index on (businessId, claimedPhone) exists and is NOT unique'
\echo ' 6 Lead_open_phone_key: partial UNIQUE on (businessId, phone), claimedPhone not in it'
\echo ' 7 Lead under ENABLE + FORCE RLS'
\echo ' 8 runtime logins NOSUPERUSER NOBYPASSRLS'
\echo ' 9 no lead carries a claimed phone yet (observed = such leads)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
lead AS (SELECT oid, relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relnamespace = (SELECT oid FROM pub) AND relname = 'Lead' AND relkind = 'r'),
col AS (SELECT a.attnotnull, a.atthasdef, format_type(a.atttypid, a.atttypmod) AS t FROM pg_attribute a
         WHERE a.attrelid = (SELECT oid FROM lead) AND a.attname = 'claimedPhone' AND NOT a.attisdropped),
chk AS (SELECT count(*) AS n FROM pg_constraint
         WHERE conrelid = (SELECT oid FROM lead) AND conname = 'Lead_claimedPhone_digits' AND contype = 'c' AND convalidated),
idx AS (SELECT count(*) AS n FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
         WHERE i.indrelid = (SELECT oid FROM lead) AND c.relname = 'Lead_businessId_claimedPhone_idx' AND NOT i.indisunique
           AND pg_get_indexdef(i.indexrelid) LIKE '%("businessId", "claimedPhone")%'),
open_phone AS (
  SELECT count(*) AS n FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE i.indrelid = (SELECT oid FROM lead) AND c.relname = 'Lead_open_phone_key' AND i.indisunique AND i.indpred IS NOT NULL
     AND pg_get_indexdef(i.indexrelid) LIKE '%("businessId", phone)%'
     AND pg_get_indexdef(i.indexrelid) LIKE '%phone IS NOT NULL%'
     AND pg_get_indexdef(i.indexrelid) NOT LIKE '%claimedPhone%'),
rt AS (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime'),
runtime_roles AS (SELECT r.oid, r.rolsuper, r.rolbypassrls FROM pg_roles r
                  WHERE r.oid = (SELECT oid FROM rt)
                     OR (r.rolcanlogin AND r.rolname <> current_user AND EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid AND m.roleid = (SELECT oid FROM rt)))),
claimed AS (SELECT count(*) AS n FROM "Lead" WHERE "claimedPhone" IS NOT NULL),
checks(n, ok, observed_count) AS (
  SELECT 1, EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261108090000_lead_claimed_phone'
                     AND finished_at IS NOT NULL AND rolled_back_at IS NULL
                     AND checksum = '3693bf02cf4300ad0a395fe02f8fb8e07ca81cc9a325dc0cfa9c7e8735a17e5d'),
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261108090000_lead_claimed_phone')
  UNION ALL SELECT 2, NOT EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL),
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, COALESCE((SELECT t = 'text' AND NOT attnotnull AND NOT atthasdef FROM col), false), (SELECT count(*) FROM col)
  UNION ALL SELECT 4, (SELECT n FROM chk) = 1, (SELECT n FROM chk)
  UNION ALL SELECT 5, (SELECT n FROM idx) = 1, (SELECT n FROM idx)
  UNION ALL SELECT 6, (SELECT n FROM open_phone) = 1, (SELECT n FROM open_phone)
  UNION ALL SELECT 7, COALESCE((SELECT relrowsecurity AND relforcerowsecurity FROM lead), false),
                      (SELECT count(*) FROM lead WHERE relrowsecurity AND relforcerowsecurity)
  UNION ALL SELECT 8, NOT EXISTS (SELECT 1 FROM runtime_roles WHERE rolsuper OR rolbypassrls) AND EXISTS (SELECT 1 FROM rt),
                      (SELECT count(*) FROM runtime_roles WHERE rolsuper OR rolbypassrls)
  UNION ALL SELECT 9, (SELECT n FROM claimed) = 0, (SELECT n FROM claimed)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count FROM checks ORDER BY n;

ROLLBACK;
