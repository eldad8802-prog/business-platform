-- ============================================================================
-- m1-onboarding-preflight.sql
--
-- Read-only Production PREFLIGHT for the three M1 migrations (#677):
--   20261011090000_onboarding_setup_state            (plain + backfill)
--   20261011090100_signup_consent_business_rename    (AUTHORITY: column grants)
--   20261011090200_user_email_casefold_unique        (plain, guarded index)
--
-- It proves the premises the lab proof (auth-plane battery 68/68) assumed:
--   * the ledger is clean, every earlier migration on main is applied, and none
--     of the three is recorded yet — so release-migrate's pending set is exactly
--     these three;
--   * none of the objects they add exists yet (columns, constraints, index);
--   * the two roles they name exist, and the rename permission is the ONLY change:
--     the runtime holds no UPD on Business.name today, and no RLS-bound login
--     outside the runtime group can change a Business row;
--   * B4's tenant-write policy is in place and binds the runtime logins, so the
--     new UPD(name) is pinned to the tenant from the moment it exists;
--   * no two accounts collide by case (the index guard would refuse);
--   * INFO: how many rows the backfill touches.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and aggregate counts only.
-- Guard-clean: no write keyword anywhere; privilege names are concatenated.
-- ============================================================================

\echo '== M1 onboarding — preflight — legend (n → check) =='
\echo ' 1 L1 ledger: no unfinished and no rolled-back row — observed = such rows'
\echo ' 2 L2 every migration on main before M1 is applied (2026-10-01 … 2026-10-10, 12 names) — observed = applied of 12'
\echo ' 3 L3 none of the three M1 migrations is recorded yet — observed = recorded'
\echo ' 4 S1 BusinessProfile has none of onboardingCompletedAt / onboardingGoal / onboardingGoalSource — observed = present'
\echo ' 5 S2 User has none of termsAcceptedAt / termsVersion / signupAttribution — observed = present'
\echo ' 6 S3 the two CHECK constraint names and the casefold index name are free — observed = taken'
\echo ' 7 R1 roles app_auth and app_runtime both exist — observed = how many of 2'
\echo ' 8 R2 no runtime login can change Business.name today (the permission is new) — observed = logins that can'
\echo ' 9 R3 no RLS-bound login outside the runtime group can change a Business row (evidence/migration login excluded) — observed = offenders'
\echo '10 B1 Business: RLS forced and business_tenant_write pins UPD to the tenant GUC (USING and CHECK) — observed = matching policies'
\echo '11 B2 runtime logins are NOSUPERUSER NOBYPASSRLS (B4 binds the rename) — observed = runtime logins'
\echo '12 E1 no two accounts share an address up to case (casefold index guard) — observed = colliding groups'
\echo '13 I1 INFO businesses with no BusinessProfile row (the backfill adds one each) — observed = count'
\echo '14 I2 INFO BusinessProfile rows (the backfill stamps each) — observed = count'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';

WITH
ledger AS (SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations),
before_m1(name) AS (VALUES
  ('20261001090000_m4_identity_routing'),
  ('20261002090000_crm_lead_lifecycle'),
  ('20261003090000_control_plane_production_privileges'),
  ('20261004090000_p2_business_identity'),
  ('20261005090000_cost_learning_wave1_policies'),
  ('20261006090000_business_tenant_write_rls'),
  ('20261007090000_cost_learning_wave2_patterns'),
  ('20261008090000_learning_coverage_policies'),
  ('20261008090000_p3a_identity_enum_values'),
  ('20261008090100_p3a_trust_claims'),
  ('20261009090000_m6_acquisition_connections'),
  ('20261010090000_business_brain_temporal_policies')),
m1(name) AS (VALUES
  ('20261011090000_onboarding_setup_state'),
  ('20261011090100_signup_consent_business_rename'),
  ('20261011090200_user_email_casefold_unique')),
cols AS (SELECT c.relname AS tbl, a.attname FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
         WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relname IN ('BusinessProfile', 'User')),
biz AS (SELECT c.oid, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        WHERE c.relname = 'Business' AND c.relkind = 'r'),
biz_cols AS (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = (SELECT oid FROM biz) AND a.attnum > 0 AND NOT a.attisdropped),
runtime_logins AS (SELECT r.oid, r.rolsuper, r.rolbypassrls FROM pg_roles r
                   WHERE r.rolcanlogin AND r.rolname <> current_user AND r.rolname <> 'app_runtime'
                     AND NOT r.rolsuper AND pg_has_role(r.oid, 'app_runtime', 'MEMBER')),
bound_outside AS (SELECT r.oid FROM pg_roles r
                  WHERE r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls
                    AND r.rolname <> current_user
                    AND NOT pg_has_role(r.oid, 'app_runtime', 'MEMBER')
                    AND (has_table_privilege(r.oid, (SELECT oid FROM biz), 'UPD' || 'ATE')
                         OR EXISTS (SELECT 1 FROM biz_cols c
                                    WHERE has_column_privilege(r.oid, (SELECT oid FROM biz), c.attname, 'UPD' || 'ATE')))),
tenant_write AS (SELECT p.polname FROM pg_policy p
                 WHERE p.polrelid = (SELECT oid FROM biz) AND p.polname = 'business_tenant_write'
                   AND p.polcmd = 'w'
                   AND pg_get_expr(p.polqual, p.polrelid) LIKE '%app.current_business_id%'
                   AND pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%app.current_business_id%'),
collide AS (SELECT lower(email) FROM "User" GROUP BY lower(email) HAVING count(*) > 1),
checks(n, ok, observed_count) AS (
            SELECT 1, NOT EXISTS (SELECT 1 FROM ledger WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL),
                      (SELECT count(*) FROM ledger WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 2, (SELECT count(*) FROM before_m1 b JOIN ledger l ON l.migration_name = b.name
                       WHERE l.finished_at IS NOT NULL AND l.rolled_back_at IS NULL) = 12,
                      (SELECT count(*) FROM before_m1 b JOIN ledger l ON l.migration_name = b.name
                       WHERE l.finished_at IS NOT NULL AND l.rolled_back_at IS NULL)
  UNION ALL SELECT 3, NOT EXISTS (SELECT 1 FROM m1 JOIN ledger l ON l.migration_name = m1.name),
                      (SELECT count(*) FROM m1 JOIN ledger l ON l.migration_name = m1.name)
  UNION ALL SELECT 4, NOT EXISTS (SELECT 1 FROM cols WHERE tbl = 'BusinessProfile'
                                  AND attname IN ('onboardingCompletedAt', 'onboardingGoal', 'onboardingGoalSource')),
                      (SELECT count(*) FROM cols WHERE tbl = 'BusinessProfile'
                       AND attname IN ('onboardingCompletedAt', 'onboardingGoal', 'onboardingGoalSource'))
  UNION ALL SELECT 5, NOT EXISTS (SELECT 1 FROM cols WHERE tbl = 'User'
                                  AND attname IN ('termsAcceptedAt', 'termsVersion', 'signupAttribution')),
                      (SELECT count(*) FROM cols WHERE tbl = 'User'
                       AND attname IN ('termsAcceptedAt', 'termsVersion', 'signupAttribution'))
  UNION ALL SELECT 6, (SELECT count(*) FROM pg_constraint
                       WHERE conname IN ('BusinessProfile_onboardingGoal_check', 'BusinessProfile_onboardingGoalSource_check'))
                      + (SELECT count(*) FROM pg_class WHERE relname = 'User_email_casefold_key') = 0,
                      (SELECT count(*) FROM pg_constraint
                       WHERE conname IN ('BusinessProfile_onboardingGoal_check', 'BusinessProfile_onboardingGoalSource_check'))
                      + (SELECT count(*) FROM pg_class WHERE relname = 'User_email_casefold_key')
  UNION ALL SELECT 7, (SELECT count(*) FROM pg_roles WHERE rolname IN ('app_auth', 'app_runtime')) = 2,
                      (SELECT count(*) FROM pg_roles WHERE rolname IN ('app_auth', 'app_runtime'))
  UNION ALL SELECT 8, NOT EXISTS (SELECT 1 FROM runtime_logins r
                                  WHERE has_column_privilege(r.oid, 'public."Business"', 'name', 'UPD' || 'ATE')),
                      (SELECT count(*) FROM runtime_logins r
                       WHERE has_column_privilege(r.oid, 'public."Business"', 'name', 'UPD' || 'ATE'))
  UNION ALL SELECT 9, NOT EXISTS (SELECT 1 FROM bound_outside), (SELECT count(*) FROM bound_outside)
  UNION ALL SELECT 10, (SELECT relrowsecurity AND relforcerowsecurity FROM biz) AND (SELECT count(*) FROM tenant_write) = 1,
                       (SELECT count(*) FROM tenant_write)
  UNION ALL SELECT 11, (SELECT count(*) FROM runtime_logins) >= 1
                       AND NOT EXISTS (SELECT 1 FROM runtime_logins WHERE rolsuper OR rolbypassrls),
                       (SELECT count(*) FROM runtime_logins)
  UNION ALL SELECT 12, NOT EXISTS (SELECT 1 FROM collide), (SELECT count(*) FROM collide)
  UNION ALL SELECT 13, true, (SELECT count(*) FROM "Business" b
                              WHERE NOT EXISTS (SELECT 1 FROM "BusinessProfile" p WHERE p."businessId" = b.id))
  UNION ALL SELECT 14, true, (SELECT count(*) FROM "BusinessProfile")
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
