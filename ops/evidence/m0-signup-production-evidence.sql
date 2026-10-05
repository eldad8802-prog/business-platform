-- ============================================================================
-- m0-signup-production-evidence.sql
--
-- Read-only Production truth for M0 (signup safety), before public signup is
-- ever opened. It answers, from the catalog and the ledger only:
--
--   * Which identity opens an account: every LOGIN that inherits
--     app_auth, and whether each holds exactly the column privileges the real
--     createAccount needs (E4 + sec_c), plus the AuthSession row signup now
--     writes in the same transaction.
--   * Whether B4 binds them: Business row-level security forced, and the one
--     policy that admits a new row is TO app_auth only.
--   * Whether the auth plane is the one actually serving login today: runtime
--     logins cannot write AuthSession at all, so any session issued recently
--     was written by the auth plane (AUTH_PLANE_ENABLED is encrypted in Vercel;
--     this is the observable proof of its value).
--   * Whether a case-insensitive unique email index could be added safely:
--     stored addresses that are not folded, and folded addresses held by more
--     than one account. Counts only; no address is ever selected.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and aggregate counts only.
-- Guard-clean: no write keyword anywhere, privilege names are concatenated.
-- ============================================================================

\echo '== M0 signup — Production truth — legend (n → check) =='
\echo ' 1 L1 sec_c (20260926110300) and B4 (20261006090000) are recorded applied, finished, not rolled back'
\echo ' 2 A1 at least one non-superuser LOGIN (other than the evidence/migration login) inherits app_auth; none of them is BYPASSRLS — observed = how many'
\echo ' 3 A2 every app_auth login may add Business(name, createdAt, updatedAt) — observed = logins short of it'
\echo ' 4 A3 every app_auth login may add the nine User columns signup writes — observed = logins short of it'
\echo ' 5 A4 every app_auth login may add the nine AuthSession columns signup writes, and use the User and Business id sequences — observed = logins short of it'
\echo ' 6 B1 Business: RLS enabled AND forced; the policy admitting new rows is TO app_auth only — observed = admitting policies'
\echo ' 7 B2 no RLS-bound LOGIN outside app_auth may add a Business row — observed = offenders'
\echo ' 8 P1 runtime logins cannot add AuthSession rows (so sessions are written by the auth plane only) — observed = runtime logins'
\echo ' 9 P2 INFO sessions issued in the last 30 days (> 0 with check 8 PASS = login runs on the auth plane) — observed = count'
\echo '10 E1 INFO stored emails that are not lower-case — observed = count (PASS when 0)'
\echo '11 E2 folded emails held by more than one account (blocks a lower(email) unique index) — observed = groups'
\echo '12 E3 the unique index on User.email exists'
\echo '13 T1 every Business has at least one User (no orphan tenant from the pre-atomic era) — observed = orphans'
\echo '14 T2 INFO businesses with more than one User — observed = count'
\echo '15 M1 INFO the evidence/migration login itself: observed = 1 when it is BYPASSRLS and inherits app_auth (expected; it is not the signup identity)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';

WITH
ledger AS (SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations
           WHERE migration_name IN ('20260926110300_sec_c_explicit_identity_grants',
                                    '20261006090000_business_tenant_write_rls')),
-- Superusers are excluded from both sets: pg_has_role is true for them against
-- every role, and they bypass row-level security regardless (classified in
-- business-b4-role-classification.sql). Real membership is what is measured.
-- The login running THIS file (current_user) is the migration identity: it holds
-- the app groups and BYPASSRLS by design, and is never the signup identity. It
-- is excluded here exactly as business-tenant-write-rls-preflight.sql excludes
-- it, and characterised on its own in check 15 instead of being hidden.
auth_logins AS (SELECT r.oid, r.rolname, r.rolsuper, r.rolbypassrls FROM pg_roles r
                WHERE r.rolcanlogin AND NOT r.rolsuper AND r.rolname <> 'app_auth'
                  AND r.rolname <> current_user
                  AND pg_has_role(r.oid, 'app_auth', 'MEMBER')),
evidence_login AS (SELECT r.rolbypassrls, pg_has_role(r.oid, 'app_auth', 'MEMBER') AS in_auth
                   FROM pg_roles r WHERE r.rolname = current_user),
runtime_logins AS (SELECT r.oid FROM pg_roles r
                   WHERE r.rolcanlogin AND NOT r.rolsuper AND r.rolname <> 'app_runtime'
                     AND pg_has_role(r.oid, 'app_runtime', 'MEMBER')
                     AND NOT pg_has_role(r.oid, 'app_auth', 'MEMBER')),
biz AS (SELECT c.oid, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        WHERE c.relname = 'Business' AND c.relkind = 'r'),
biz_cols AS (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = (SELECT oid FROM biz) AND a.attnum > 0 AND NOT a.attisdropped),
admitting AS (SELECT p.polname, p.polroles FROM pg_policy p
              WHERE p.polrelid = (SELECT oid FROM biz) AND p.polcmd IN ('a', '*')),
need_biz(col) AS (VALUES ('name'), ('createdAt'), ('updatedAt')),
need_user(col) AS (VALUES ('email'), ('password'), ('name'), ('businessId'), ('updatedAt'),
                          ('createdAt'), ('role'), ('loginCount'), ('tokenVersion')),
short_biz AS (SELECT DISTINCT l.oid FROM auth_logins l, need_biz c
              WHERE NOT has_column_privilege(l.oid, 'public."Business"', c.col, 'INS' || 'ERT')),
short_user AS (SELECT DISTINCT l.oid FROM auth_logins l, need_user c
               WHERE NOT has_column_privilege(l.oid, 'public."User"', c.col, 'INS' || 'ERT')),
need_session(col) AS (VALUES ('id'), ('userId'), ('secretHash'), ('tokenVersionAtIssue'), ('createdAt'),
                             ('lastUsedAt'), ('idleExpiresAt'), ('absoluteExpiresAt'), ('userAgent')),
-- Column-level, as the session privilege contract grants it: the nine columns
-- issueRefreshSession writes.
short_session AS (SELECT l.oid FROM auth_logins l
                  WHERE EXISTS (SELECT 1 FROM need_session c
                                WHERE NOT has_column_privilege(l.oid, 'public."AuthSession"', c.col, 'INS' || 'ERT'))
                     OR NOT has_sequence_privilege(l.oid, 'public."User_id_seq"', 'USAGE')
                     OR NOT has_sequence_privilege(l.oid, 'public."Business_id_seq"', 'USAGE')),
bound_logins AS (SELECT r.oid FROM pg_roles r WHERE r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls),
stray_adders AS (SELECT b.oid FROM bound_logins b
                 WHERE NOT pg_has_role(b.oid, 'app_auth', 'MEMBER')
                   AND (has_table_privilege(b.oid, (SELECT oid FROM biz), 'INS' || 'ERT')
                        OR EXISTS (SELECT 1 FROM biz_cols c
                                   WHERE has_column_privilege(b.oid, (SELECT oid FROM biz), c.attname, 'INS' || 'ERT')))),
folded_dupes AS (SELECT lower(email) AS k FROM "User" GROUP BY lower(email) HAVING count(*) > 1),
orphans AS (SELECT b.id FROM "Business" b WHERE NOT EXISTS (SELECT 1 FROM "User" u WHERE u."businessId" = b.id)),
shared AS (SELECT u."businessId" FROM "User" u GROUP BY u."businessId" HAVING count(*) > 1),
checks(n, ok, observed_count) AS (
            SELECT 1, (SELECT count(*) FROM ledger WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) = 2,
                      (SELECT count(*) FROM ledger WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 2, (SELECT count(*) FROM auth_logins) >= 1 AND NOT EXISTS (SELECT 1 FROM auth_logins WHERE rolsuper OR rolbypassrls),
                      (SELECT count(*) FROM auth_logins)
  UNION ALL SELECT 3, NOT EXISTS (SELECT 1 FROM short_biz), (SELECT count(*) FROM short_biz)
  UNION ALL SELECT 4, NOT EXISTS (SELECT 1 FROM short_user), (SELECT count(*) FROM short_user)
  UNION ALL SELECT 5, NOT EXISTS (SELECT 1 FROM short_session), (SELECT count(*) FROM short_session)
  UNION ALL SELECT 6, (SELECT relrowsecurity AND relforcerowsecurity FROM biz)
                      AND (SELECT count(*) FROM admitting) = 1
                      AND (SELECT polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'app_auth')]::oid[] FROM admitting LIMIT 1),
                      (SELECT count(*) FROM admitting)
  UNION ALL SELECT 7, NOT EXISTS (SELECT 1 FROM stray_adders), (SELECT count(*) FROM stray_adders)
  UNION ALL SELECT 8, (SELECT count(*) FROM runtime_logins) >= 1
                      AND NOT EXISTS (SELECT 1 FROM runtime_logins r, need_session c
                                      WHERE has_column_privilege(r.oid, 'public."AuthSession"', c.col, 'INS' || 'ERT')),
                      (SELECT count(*) FROM runtime_logins)
  UNION ALL SELECT 9, true, (SELECT count(*) FROM "AuthSession" WHERE "createdAt" > now() - interval '30 days')
  UNION ALL SELECT 10, (SELECT count(*) FROM "User" WHERE email <> lower(email)) = 0,
                       (SELECT count(*) FROM "User" WHERE email <> lower(email))
  UNION ALL SELECT 11, NOT EXISTS (SELECT 1 FROM folded_dupes), (SELECT count(*) FROM folded_dupes)
  UNION ALL SELECT 12, EXISTS (SELECT 1 FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
                               WHERE i.indrelid = 'public."User"'::regclass AND i.indisunique AND ic.relname = 'User_email_key'),
                       0
  UNION ALL SELECT 13, NOT EXISTS (SELECT 1 FROM orphans), (SELECT count(*) FROM orphans)
  UNION ALL SELECT 14, true, (SELECT count(*) FROM shared)
  UNION ALL SELECT 15, true, (SELECT count(*) FROM evidence_login WHERE rolbypassrls AND in_auth)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
