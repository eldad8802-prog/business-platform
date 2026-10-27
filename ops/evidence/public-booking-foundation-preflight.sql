-- ============================================================================
-- public-booking-foundation-preflight.sql
--
-- Read-only PREFLIGHT for migration
--   20261106090000_public_booking_foundation   (NOT applied)
--
-- Measures the premises the migration's outcome depends on:
--   * the ledger is clean, this migration is not recorded, nothing sorting after it was applied first;
--   * what it builds on is finished: the appointments foundation (the tables it extends), and the three
--     migrations of other tracks that sort before it — 20261103090000_document_supplier_link,
--     20261104090000_pos_rivhit_source and 20261105090000_accountant_link_events — so the release applies exactly
--     this one, in order;
--   * none of the names it introduces exists yet: the staff column, the eight settings columns, the enum, the
--     two checks and the three functions;
--   * StaffMember and BookingSettings are under RLS ENABLED + FORCED; PUBLIC and app_auth hold nothing on
--     BookingSettings, BookingRequest or AppointmentManageToken;
--   * app_runtime exists NOLOGIN NOSUPERUSER NOBYPASSRLS; the role that owns the tables (the migration role,
--     which will own the functions) carries BYPASSRLS or is a superuser;
--   * how many BookingSettings / StaffMember rows exist (they take the safe defaults: no staff member becomes
--     public, no link is enabled).
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== public booking foundation preflight: legend (n -> check) =='
\echo ' 1 ledger: no unfinished and no rolled-back row (observed = such rows)'
\echo ' 2 20261106090000_public_booking_foundation is NOT recorded'
\echo ' 3 no finished migration sorts after it'
\echo ' 4 20261029090000_appointments_foundation is finished'
\echo ' 5 the dependencies are finished: document_supplier_link, pos_rivhit_source, accountant_link_events (observed = of 3)'
\echo ' 6 StaffMember.publicBookable does not exist yet'
\echo ' 7 none of the eight BookingSettings columns exists yet'
\echo ' 8 the BookingAssignmentMode type does not exist yet'
\echo ' 9 none of the two checks exists yet'
\echo '10 none of the three functions exists yet'
\echo '11 StaffMember and BookingSettings: RLS enabled and forced (observed = of 2)'
\echo '12 PUBLIC and app_auth hold no privilege on BookingSettings, BookingRequest, AppointmentManageToken'
\echo '13 app_runtime exists NOLOGIN NOSUPERUSER NOBYPASSRLS'
\echo '14 the owner of BookingSettings (the migration role) carries BYPASSRLS or is a superuser'
\echo '15 BookingSettings rows (informational: they take the defaults)'
\echo '16 StaffMember rows (informational: none becomes public)'
\echo '17 dependency 20261103090000_document_supplier_link finished (informational: 1 = yes)'
\echo '18 dependency 20261104090000_pos_rivhit_source finished (informational: 1 = yes)'
\echo '19 dependency 20261105090000_accountant_link_events finished (informational: 1 = yes)'

WITH c AS (
  SELECT 1 AS n, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) AS observed, 0 AS want
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261106090000_public_booking_foundation'), 0
  UNION ALL SELECT 3, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name > '20261106090000_public_booking_foundation' AND finished_at IS NOT NULL), 0
  UNION ALL SELECT 4, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261029090000_appointments_foundation' AND finished_at IS NOT NULL AND rolled_back_at IS NULL), 1
  UNION ALL SELECT 5, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name IN ('20261103090000_document_supplier_link', '20261104090000_pos_rivhit_source', '20261105090000_accountant_link_events') AND finished_at IS NOT NULL AND rolled_back_at IS NULL), 3
  UNION ALL SELECT 6, (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'StaffMember' AND column_name = 'publicBookable'), 0
  UNION ALL SELECT 7, (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'BookingSettings'
      AND column_name IN ('assignmentMode','selfCancelEnabled','selfCancelWindowHours','maxOpenRequestsPerPhone','showAddress','showBusinessDetails','showPrices','showStaffNames')), 0
  UNION ALL SELECT 8, (SELECT count(*) FROM pg_type WHERE typname = 'BookingAssignmentMode'), 0
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_constraint WHERE conname IN ('BookingSettings_self_cancel_window','BookingSettings_open_per_phone')), 0
  UNION ALL SELECT 10, (SELECT count(*) FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
      WHERE s.nspname = 'public' AND p.proname IN ('booking_resolve_public','booking_pending_due','booking_resolve_manage_token')), 0
  UNION ALL SELECT 11, (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('StaffMember','BookingSettings') AND relrowsecurity AND relforcerowsecurity), 2
  UNION ALL SELECT 12, (SELECT count(*) FROM information_schema.role_table_grants WHERE table_schema = 'public'
      AND table_name IN ('BookingSettings','BookingRequest','AppointmentManageToken') AND grantee IN ('PUBLIC','app_auth')), 0
  UNION ALL SELECT 13, (SELECT count(*) FROM pg_roles WHERE rolname = 'app_runtime' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls), 1
  UNION ALL SELECT 14, (SELECT count(*) FROM pg_class t JOIN pg_roles r ON r.oid = t.relowner
      WHERE t.relnamespace = 'public'::regnamespace AND t.relname = 'BookingSettings' AND (r.rolbypassrls OR r.rolsuper)), 1
  UNION ALL SELECT 15, (SELECT count(*) FROM "BookingSettings"), NULL
  UNION ALL SELECT 16, (SELECT count(*) FROM "StaffMember"), NULL
  UNION ALL SELECT 17, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261103090000_document_supplier_link' AND finished_at IS NOT NULL AND rolled_back_at IS NULL), NULL
  UNION ALL SELECT 18, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261104090000_pos_rivhit_source' AND finished_at IS NOT NULL AND rolled_back_at IS NULL), NULL
  UNION ALL SELECT 19, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261105090000_accountant_link_events' AND finished_at IS NOT NULL AND rolled_back_at IS NULL), NULL
)
SELECT n,
       CASE WHEN want IS NULL THEN 'INFO' WHEN observed = want THEN 'PASS' ELSE 'FAIL' END AS result,
       observed AS observed_count
  FROM c
 ORDER BY n;
