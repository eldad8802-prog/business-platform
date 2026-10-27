-- ============================================================================
-- public-booking-foundation-production-evidence.sql
--
-- Read-only PROOF, after migration
--   20261106090000_public_booking_foundation
-- was applied: the reviewed file (sha256 pinned below) is the one recorded, its objects exist exactly as reviewed,
-- and nothing was opened to the public by it.
--
--   * recorded and finished, with the reviewed checksum;
--   * the staff column and the eight settings columns: NOT NULL, with their defaults; the enum has BALANCED and
--     PRIORITY; the two checks exist;
--   * the three functions: SECURITY DEFINER, search_path pinned to pg_catalog, public, owned by a BYPASSRLS role;
--     EXECUTE for app_runtime; not for PUBLIC and not for app_auth;
--   * StaffMember and BookingSettings still under RLS ENABLED + FORCED;
--   * the ledger is clean and carries this migration once; all four booking tables under RLS ENABLED + FORCED;
--     PUBLIC and app_auth hold no table privilege on them; app_runtime is still NOLOGIN NOSUPERUSER NOBYPASSRLS;
--   * nothing public: no staff member offered on a link, no link enabled, no booking request, no manage token,
--     public_booking OFF globally and ENABLED for no business; the staff column and the link switch default to false.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== public booking foundation proof: legend (n -> check) =='
\echo ' 1 the migration is recorded, finished, not rolled back, with checksum ed8325b4…d879'
\echo ' 2 the nine new columns are NOT NULL with defaults (observed = of 9)'
\echo ' 3 BookingAssignmentMode = BALANCED, PRIORITY (observed = values)'
\echo ' 4 the two checks exist (observed = of 2)'
\echo ' 5 the three functions: SECURITY DEFINER with search_path pg_catalog, public (observed = of 3)'
\echo ' 6 …owned by a BYPASSRLS (or superuser) role (observed = of 3)'
\echo ' 7 …EXECUTE for app_runtime (observed = of 3)'
\echo ' 8 …and for neither PUBLIC nor app_auth (observed = grants found)'
\echo ' 9 StaffMember and BookingSettings: RLS enabled and forced (observed = of 2)'
\echo '10 no staff member is offered on a public link'
\echo '11 no booking link is enabled'
\echo '12 no booking request and no manage token exist'
\echo '13 public_booking: globally OFF (observed = policies globally ON)'
\echo '14 public_booking: ENABLED for no business (observed = such overrides)'
\echo '15 ledger: no unfinished and no rolled-back row (observed = such rows)'
\echo '16 exactly one ledger row carries this migration name'
\echo '17 BookingRequest and AppointmentManageToken: RLS enabled and forced (observed = of 2)'
\echo '18 PUBLIC and app_auth hold no table privilege on the four tables (observed = privileges found)'
\echo '19 app_runtime is still NOLOGIN NOSUPERUSER NOBYPASSRLS'
\echo '20 StaffMember.publicBookable defaults to false (a new staff member is never public)'
\echo '21 BookingSettings.enabled defaults to false (a new link is never open)'

WITH f AS (
  SELECT p.oid, p.prosecdef, p.proconfig, p.proowner, p.proacl
    FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
   WHERE s.nspname = 'public' AND p.proname IN ('booking_resolve_public','booking_pending_due','booking_resolve_manage_token')
), c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261106090000_public_booking_foundation'
      AND finished_at IS NOT NULL AND rolled_back_at IS NULL AND checksum = 'ed8325b4ed36e36a8be130fec46ac83d2c56a7227ce97e4a8d41863d3f56d879') AS observed, 1 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
      AND ((table_name = 'StaffMember' AND column_name = 'publicBookable')
        OR (table_name = 'BookingSettings' AND column_name IN ('assignmentMode','selfCancelEnabled','selfCancelWindowHours','maxOpenRequestsPerPhone','showAddress','showBusinessDetails','showPrices','showStaffNames')))
      AND is_nullable = 'NO' AND column_default IS NOT NULL), 9
  UNION ALL SELECT 3, (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'BookingAssignmentMode' AND e.enumlabel IN ('BALANCED','PRIORITY')), 2
  UNION ALL SELECT 4, (SELECT count(*) FROM pg_constraint WHERE conname IN ('BookingSettings_self_cancel_window','BookingSettings_open_per_phone')), 2
  UNION ALL SELECT 5, (SELECT count(*) FROM f WHERE prosecdef AND array_to_string(proconfig, ',') = 'search_path=pg_catalog, public'), 3
  UNION ALL SELECT 6, (SELECT count(*) FROM f JOIN pg_roles r ON r.oid = f.proowner WHERE r.rolbypassrls OR r.rolsuper), 3
  UNION ALL SELECT 7, (SELECT count(*) FROM f WHERE has_function_privilege('app_runtime', f.oid, 'EXECUTE')), 3
  UNION ALL SELECT 8, (SELECT count(*) FROM f, aclexplode(f.proacl) a
      WHERE a.privilege_type = 'EXECUTE' AND (a.grantee = 0 OR a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'app_auth'))), 0
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('StaffMember','BookingSettings') AND relrowsecurity AND relforcerowsecurity), 2
  UNION ALL SELECT 10, (SELECT count(*) FROM "StaffMember" WHERE "publicBookable"), 0
  UNION ALL SELECT 11, (SELECT count(*) FROM "BookingSettings" WHERE enabled), 0
  UNION ALL SELECT 12, (SELECT count(*) FROM "BookingRequest") + (SELECT count(*) FROM "AppointmentManageToken"), 0
  UNION ALL SELECT 13, (SELECT count(*) FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'public_booking' AND "globalEnabled"), 0
  UNION ALL SELECT 14, (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'public_booking' AND state = 'ENABLED'), 0
  UNION ALL SELECT 15, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL), 0
  UNION ALL SELECT 16, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261106090000_public_booking_foundation'), 1
  UNION ALL SELECT 17, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('BookingRequest','AppointmentManageToken') AND relrowsecurity AND relforcerowsecurity), 2
  UNION ALL SELECT 18, (SELECT count(*) FROM information_schema.role_table_grants WHERE table_schema = 'public'
      AND table_name IN ('StaffMember','BookingSettings','BookingRequest','AppointmentManageToken') AND grantee IN ('PUBLIC','app_auth')), 0
  UNION ALL SELECT 19, (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls), 1
  UNION ALL SELECT 20, (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'StaffMember'
      AND column_name = 'publicBookable' AND column_default = 'false'), 1
  UNION ALL SELECT 21, (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'BookingSettings'
      AND column_name = 'enabled' AND column_default = 'false'), 1
)
SELECT n, CASE WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result, observed AS observed_count
  FROM c
 ORDER BY n;
