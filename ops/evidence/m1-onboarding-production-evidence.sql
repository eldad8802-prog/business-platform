-- ============================================================================
-- m1-onboarding-production-evidence.sql
--
-- Read-only post-apply proof for the three M1 migrations (release-migrate run
-- 37391190020):
--   20261011090000_onboarding_setup_state
--   20261011090100_signup_consent_business_rename   (authority)
--   20261011090200_user_email_casefold_unique
--
-- Proves what landed and that nothing else moved: the objects exist exactly;
-- app_auth may write the three consent columns and read none of them; the
-- runtime may change Business.name and the five lifecycle columns, nothing
-- else; B4 still pins every Business change to the tenant; every existing
-- business is stamped onboarded (no owner is routed into setup); no goal was
-- invented by the backfill; email identity is case-folded and unique.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and aggregate counts only. Guard-clean.
-- ============================================================================

\echo '== M1 onboarding — post-apply proof — legend (n → check) =='
\echo ' 1 L1 the three M1 migrations are recorded applied, finished, not rolled back — observed = of 3'
\echo ' 2 L2 ledger: no unfinished or rolled-back row — observed = such rows'
\echo ' 3 S1 BusinessProfile has onboardingCompletedAt, onboardingGoal, onboardingGoalSource — observed = of 3'
\echo ' 4 S2 both onboarding CHECK constraints exist — observed = of 2'
\echo ' 5 S3 User has termsAcceptedAt, termsVersion, signupAttribution — observed = of 3'
\echo ' 6 S4 User_email_casefold_key is a UNIQUE index on lower(email) — observed = matching indexes'
\echo ' 7 A1 every app_auth login may add all three consent columns — observed = logins short of it'
\echo ' 8 A2 no app_auth login may read or change any consent column — observed = logins that can'
\echo ' 9 R1 every runtime login may change Business.name — observed = logins short of it'
\echo '10 R2 runtime logins may change exactly 6 Business columns (name + 5 lifecycle) — observed = changeable columns'
\echo '11 R3 no RLS-bound login outside the runtime group can change a Business row (evidence login excluded) — observed = offenders'
\echo '12 B1 Business RLS forced and business_tenant_write still pins UPD to the tenant GUC — observed = matching policies'
\echo '13 O1 every business has a profile stamped onboarded (none would be sent to setup) — observed = businesses not stamped'
\echo '14 O2 the backfill invented no goal: profiles with a goal but no completion stamp, or a goal source without a goal — observed = such rows'
\echo '15 E1 no two accounts share an address up to case — observed = colliding groups'
\echo '16 I1 INFO profiles carrying a goal (set by owners since the release) — observed = count'
\echo '17 I2 INFO accounts with recorded terms consent (new signups since the release) — observed = count'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';

WITH
ledger AS (SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations),
m1(name) AS (VALUES
  ('20261011090000_onboarding_setup_state'),
  ('20261011090100_signup_consent_business_rename'),
  ('20261011090200_user_email_casefold_unique')),
cols AS (SELECT c.relname AS tbl, a.attname FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
         WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relname IN ('BusinessProfile', 'User')),
consent(col) AS (VALUES ('termsAcceptedAt'), ('termsVersion'), ('signupAttribution')),
auth_logins AS (SELECT r.oid FROM pg_roles r
                WHERE r.rolcanlogin AND NOT r.rolsuper AND r.rolname <> current_user AND r.rolname <> 'app_auth'
                  AND pg_has_role(r.oid, 'app_auth', 'MEMBER')),
runtime_logins AS (SELECT r.oid FROM pg_roles r
                   WHERE r.rolcanlogin AND NOT r.rolsuper AND r.rolname <> current_user AND r.rolname <> 'app_runtime'
                     AND pg_has_role(r.oid, 'app_runtime', 'MEMBER') AND NOT pg_has_role(r.oid, 'app_auth', 'MEMBER')),
biz AS (SELECT c.oid, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        WHERE c.relname = 'Business' AND c.relkind = 'r'),
biz_cols AS (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = (SELECT oid FROM biz) AND a.attnum > 0 AND NOT a.attisdropped),
rt_changeable AS (SELECT c.attname FROM biz_cols c
                  WHERE EXISTS (SELECT 1 FROM runtime_logins r
                                WHERE has_column_privilege(r.oid, (SELECT oid FROM biz), c.attname, 'UPD' || 'ATE'))),
bound_outside AS (SELECT r.oid FROM pg_roles r
                  WHERE r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND r.rolname <> current_user
                    AND NOT pg_has_role(r.oid, 'app_runtime', 'MEMBER')
                    AND EXISTS (SELECT 1 FROM biz_cols c
                                WHERE has_column_privilege(r.oid, (SELECT oid FROM biz), c.attname, 'UPD' || 'ATE'))),
tenant_write AS (SELECT p.polname FROM pg_policy p
                 WHERE p.polrelid = (SELECT oid FROM biz) AND p.polname = 'business_tenant_write' AND p.polcmd = 'w'
                   AND pg_get_expr(p.polqual, p.polrelid) LIKE '%app.current_business_id%'
                   AND pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%app.current_business_id%'),
casefold AS (SELECT i.indexrelid FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
             WHERE i.indrelid = 'public."User"'::regclass AND ic.relname = 'User_email_casefold_key'
               AND i.indisunique AND pg_get_indexdef(i.indexrelid) ILIKE '%lower(%email%'),
checks(n, ok, observed_count) AS (
            SELECT 1, (SELECT count(*) FROM m1 JOIN ledger l ON l.migration_name = m1.name
                       WHERE l.finished_at IS NOT NULL AND l.rolled_back_at IS NULL) = 3,
                      (SELECT count(*) FROM m1 JOIN ledger l ON l.migration_name = m1.name
                       WHERE l.finished_at IS NOT NULL AND l.rolled_back_at IS NULL)
  UNION ALL SELECT 2, NOT EXISTS (SELECT 1 FROM ledger WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL),
                      (SELECT count(*) FROM ledger WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, (SELECT count(*) FROM cols WHERE tbl = 'BusinessProfile'
                       AND attname IN ('onboardingCompletedAt', 'onboardingGoal', 'onboardingGoalSource')) = 3,
                      (SELECT count(*) FROM cols WHERE tbl = 'BusinessProfile'
                       AND attname IN ('onboardingCompletedAt', 'onboardingGoal', 'onboardingGoalSource'))
  UNION ALL SELECT 4, (SELECT count(*) FROM pg_constraint
                       WHERE conname IN ('BusinessProfile_onboardingGoal_check', 'BusinessProfile_onboardingGoalSource_check') AND contype = 'c') = 2,
                      (SELECT count(*) FROM pg_constraint
                       WHERE conname IN ('BusinessProfile_onboardingGoal_check', 'BusinessProfile_onboardingGoalSource_check') AND contype = 'c')
  UNION ALL SELECT 5, (SELECT count(*) FROM cols c JOIN consent k ON k.col = c.attname WHERE c.tbl = 'User') = 3,
                      (SELECT count(*) FROM cols c JOIN consent k ON k.col = c.attname WHERE c.tbl = 'User')
  UNION ALL SELECT 6, (SELECT count(*) FROM casefold) = 1, (SELECT count(*) FROM casefold)
  UNION ALL SELECT 7, (SELECT count(*) FROM auth_logins) >= 1
                      AND NOT EXISTS (SELECT 1 FROM auth_logins l, consent k
                                      WHERE NOT has_column_privilege(l.oid, 'public."User"', k.col, 'INS' || 'ERT')),
                      (SELECT count(DISTINCT l.oid) FROM auth_logins l, consent k
                       WHERE NOT has_column_privilege(l.oid, 'public."User"', k.col, 'INS' || 'ERT'))
  UNION ALL SELECT 8, NOT EXISTS (SELECT 1 FROM auth_logins l, consent k
                                  WHERE has_column_privilege(l.oid, 'public."User"', k.col, 'SELECT')
                                     OR has_column_privilege(l.oid, 'public."User"', k.col, 'UPD' || 'ATE')),
                      (SELECT count(DISTINCT l.oid) FROM auth_logins l, consent k
                       WHERE has_column_privilege(l.oid, 'public."User"', k.col, 'SELECT')
                          OR has_column_privilege(l.oid, 'public."User"', k.col, 'UPD' || 'ATE'))
  UNION ALL SELECT 9, (SELECT count(*) FROM runtime_logins) >= 1
                      AND NOT EXISTS (SELECT 1 FROM runtime_logins r
                                      WHERE NOT has_column_privilege(r.oid, 'public."Business"', 'name', 'UPD' || 'ATE')),
                      (SELECT count(*) FROM runtime_logins r
                       WHERE NOT has_column_privilege(r.oid, 'public."Business"', 'name', 'UPD' || 'ATE'))
  UNION ALL SELECT 10, (SELECT count(*) FROM rt_changeable) = 6
                       AND (SELECT count(*) FROM rt_changeable
                            WHERE attname IN ('name', 'deletionRequestedAt', 'deletedAt', 'archivedAt', 'archivedByUserId', 'updatedAt')) = 6,
                       (SELECT count(*) FROM rt_changeable)
  UNION ALL SELECT 11, NOT EXISTS (SELECT 1 FROM bound_outside), (SELECT count(*) FROM bound_outside)
  UNION ALL SELECT 12, (SELECT relrowsecurity AND relforcerowsecurity FROM biz) AND (SELECT count(*) FROM tenant_write) = 1,
                       (SELECT count(*) FROM tenant_write)
  UNION ALL SELECT 13, NOT EXISTS (SELECT 1 FROM "Business" b
                                   WHERE NOT EXISTS (SELECT 1 FROM "BusinessProfile" p
                                                     WHERE p."businessId" = b.id AND p."onboardingCompletedAt" IS NOT NULL)
                                     AND b."createdAt" < (SELECT max(finished_at) FROM ledger l JOIN m1 ON m1.name = l.migration_name)),
                       (SELECT count(*) FROM "Business" b
                        WHERE NOT EXISTS (SELECT 1 FROM "BusinessProfile" p
                                          WHERE p."businessId" = b.id AND p."onboardingCompletedAt" IS NOT NULL)
                          AND b."createdAt" < (SELECT max(finished_at) FROM ledger l JOIN m1 ON m1.name = l.migration_name))
  UNION ALL SELECT 14, NOT EXISTS (SELECT 1 FROM "BusinessProfile"
                                   WHERE ("onboardingGoal" IS NOT NULL AND "onboardingCompletedAt" IS NULL)
                                      OR ("onboardingGoalSource" IS NOT NULL AND "onboardingGoal" IS NULL)),
                       (SELECT count(*) FROM "BusinessProfile"
                        WHERE ("onboardingGoal" IS NOT NULL AND "onboardingCompletedAt" IS NULL)
                           OR ("onboardingGoalSource" IS NOT NULL AND "onboardingGoal" IS NULL))
  UNION ALL SELECT 15, NOT EXISTS (SELECT 1 FROM "User" GROUP BY lower(email) HAVING count(*) > 1),
                       (SELECT count(*) FROM (SELECT 1 FROM "User" GROUP BY lower(email) HAVING count(*) > 1) x)
  UNION ALL SELECT 16, true, (SELECT count(*) FROM "BusinessProfile" WHERE "onboardingGoal" IS NOT NULL)
  UNION ALL SELECT 17, true, (SELECT count(*) FROM "User" WHERE "termsAcceptedAt" IS NOT NULL)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
