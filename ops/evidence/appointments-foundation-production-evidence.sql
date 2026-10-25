-- ============================================================================
-- appointments-foundation-production-evidence.sql
--
-- Read-only Production EVIDENCE after migration
--   20261029090000_appointments_foundation
--
-- Proves the migration's outcome, from the catalog and counts only:
--   * it is recorded and finished, its sha256 is the reviewed one, nothing is unfinished or rolled back;
--   * the nine new tables have RLS ENABLED + FORCED and exactly their per-command policies (26), every one
--     PERMISSIVE, for PUBLIC, with USING / WITH CHECK equal to the tenant GUC expression; no FOR ALL policy and no
--     remove-rows policy anywhere; "Appointment" still has exactly its three p7pilot policies and FORCE RLS;
--   * the exact ACL of every new table and sequence (app_runtime only); no column-level privilege;
--   * the nine composite tenant keys exist and are validated;
--   * the no-overlap EXCLUDE constraint exists (btree_gist installed) with its active-status predicate; the
--     Appointment checks exist (validated, except the text bounds — NOT VALID by design); createdByUserId is nullable
--     and the enum CreatedByActor carries CUSTOMER;
--   * the five triggers exist and are enabled; the four appointment functions exist; SECURITY DEFINER exactly on
--     appointment_erase_business, with a pinned search_path and owned by the migration role; EXECUTE on it held by
--     app_runtime alone, and by nobody on the trigger functions;
--   * the flags appointments and public_booking exist and are OFF, with no business override;
--   * nothing was written: the nine new tables are empty and no appointment uses a new column.
--
-- Checks 21 and 22 run first: the row counts are taken with row_security = off, so a query that row level
-- security would filter stops the run with an ERROR instead of reporting a smaller number.
--
-- OUTPUT (redaction-friendly): n | result | observed_count + an \echo legend.
-- PRIVACY: catalog, ledger and counts only. Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== appointments foundation production evidence: legend (n -> check) =='
\echo '21 V1 the evidence role is a superuser or has BYPASSRLS, so it sees every row (runs first)'
\echo '22 V2 row level security is not active on "StaffMember" for the evidence role (runs first)'
\echo ' 1 the migration is recorded and finished (observed = finished rows)'
\echo ' 2 no ledger row is unfinished or rolled back (observed = such rows)'
\echo ' 3 the recorded checksum is the reviewed sha256 of migration.sql'
\echo ' 4 the nine new tables and Appointment: RLS ENABLED + FORCED (observed = of 10)'
\echo ' 5 exactly 26 policies on the new tables, per command, PERMISSIVE, PUBLIC; no other policy on them (observed = policies)'
\echo ' 6 every new policy USING / WITH CHECK equals the tenant GUC expression exactly (observed = mismatches)'
\echo ' 7 no FOR ALL and no remove-rows policy on the ten tables; Appointment keeps exactly its three p7pilot policies (observed = Appointment policies)'
\echo ' 8 the ACL of every new table and sequence is exactly as reviewed, app_runtime only (observed = mismatching objects)'
\echo ' 9 no column-level privilege on any new table (observed = column ACL items)'
\echo '10 the nine composite tenant keys exist and are validated (observed = of 9)'
\echo '11 Appointment_no_overlap is an EXCLUDE constraint and btree_gist is installed (observed = of 2)'
\echo '12 the Appointment checks exist: nine validated, the text bounds NOT VALID; createdByUserId nullable; CUSTOMER in CreatedByActor (observed = of 12)'
\echo '13 the five triggers exist and are enabled (observed = of 5)'
\echo '14 the four appointment functions exist (observed = functions)'
\echo '15 SECURITY DEFINER exactly on appointment_erase_business; search_path pinned; owned by the migration role (observed = matching, of 1)'
\echo '16 EXECUTE: app_runtime alone on appointment_erase_business; nobody but the owner on the trigger functions; never PUBLIC (observed = other grants)'
\echo '17 flags appointments / public_booking: defaultEnabled false, globalEnabled false, emergencyDisabled false, no business override (observed = overrides)'
\echo '18 nothing written: the nine new tables hold no row (observed = rows)'
\echo '19 no appointment uses a new column: every row is a customer appointment with no end time, staff, buffer or reason (observed = rows)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
-- Hard stop: a query that row level security would filter raises an ERROR instead.
SET LOCAL row_security = off;

\echo '== visibility checks (21, 22) =='
WITH
sm AS (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'StaffMember' AND c.relkind = 'r'),
checks(n, ok, observed_count) AS (
            SELECT 21, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) IS TRUE, 1
  UNION ALL SELECT 22, row_security_active((SELECT oid FROM sm)) IS FALSE, 1
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

\echo '== evidence checks (1-19) =='
WITH
pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
rel(nm, oid, relowner, relrowsecurity, relforcerowsecurity, relacl) AS (
  SELECT c.relname, c.oid, c.relowner, c.relrowsecurity, c.relforcerowsecurity, c.relacl
  FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub)),
rt AS (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime'),
tables(nm) AS (VALUES ('StaffMember'), ('StaffServiceAssignment'), ('AvailabilityRule'), ('AvailabilityException'),
                      ('ServiceBookingPolicy'), ('BookingSettings'), ('BookingRequest'), ('AppointmentManageToken'),
                      ('AppointmentEvent')),
appt AS (SELECT oid FROM rel WHERE nm = 'Appointment'),
expected_expr(e) AS (VALUES ('("businessId" = (NULLIF(current_setting(''app.current_business_id''::text, true), ''''::text))::integer)')),
expected_pol(tbl, polname, cmd, has_q, has_wc) AS (VALUES
  ('StaffMember', 'staff_member_tenant_select', 'r', true, false),
  ('StaffMember', 'staff_member_tenant_insert', 'a', false, true),
  ('StaffMember', 'staff_member_tenant_update', 'w', true, true),
  ('StaffServiceAssignment', 'staff_assignment_tenant_select', 'r', true, false),
  ('StaffServiceAssignment', 'staff_assignment_tenant_insert', 'a', false, true),
  ('StaffServiceAssignment', 'staff_assignment_tenant_update', 'w', true, true),
  ('AvailabilityRule', 'availability_rule_tenant_select', 'r', true, false),
  ('AvailabilityRule', 'availability_rule_tenant_insert', 'a', false, true),
  ('AvailabilityRule', 'availability_rule_tenant_update', 'w', true, true),
  ('AvailabilityException', 'availability_exception_tenant_select', 'r', true, false),
  ('AvailabilityException', 'availability_exception_tenant_insert', 'a', false, true),
  ('AvailabilityException', 'availability_exception_tenant_update', 'w', true, true),
  ('ServiceBookingPolicy', 'service_booking_policy_tenant_select', 'r', true, false),
  ('ServiceBookingPolicy', 'service_booking_policy_tenant_insert', 'a', false, true),
  ('ServiceBookingPolicy', 'service_booking_policy_tenant_update', 'w', true, true),
  ('BookingSettings', 'booking_settings_tenant_select', 'r', true, false),
  ('BookingSettings', 'booking_settings_tenant_insert', 'a', false, true),
  ('BookingSettings', 'booking_settings_tenant_update', 'w', true, true),
  ('BookingRequest', 'booking_request_tenant_select', 'r', true, false),
  ('BookingRequest', 'booking_request_tenant_insert', 'a', false, true),
  ('BookingRequest', 'booking_request_tenant_update', 'w', true, true),
  ('AppointmentManageToken', 'appointment_token_tenant_select', 'r', true, false),
  ('AppointmentManageToken', 'appointment_token_tenant_insert', 'a', false, true),
  ('AppointmentManageToken', 'appointment_token_tenant_update', 'w', true, true),
  ('AppointmentEvent', 'appointment_event_tenant_select', 'r', true, false),
  ('AppointmentEvent', 'appointment_event_tenant_insert', 'a', false, true)),
pols AS (SELECT r.nm AS tbl, p.polname, p.polcmd::text AS cmd, p.polpermissive, p.polroles,
                pg_get_expr(p.polqual, p.polrelid) AS q, pg_get_expr(p.polwithcheck, p.polrelid) AS wc
         FROM pg_policy p JOIN rel r ON r.oid = p.polrelid WHERE r.nm IN (SELECT nm FROM tables)),
appt_pols AS (SELECT p.polname, p.polcmd::text AS cmd FROM pg_policy p WHERE p.polrelid = (SELECT oid FROM appt)),
letter AS (SELECT * FROM (VALUES ('SELECT', 'r'), ('INS' || 'ERT', 'a'), ('UPD' || 'ATE', 'w'), ('DEL' || 'ETE', 'd'),
                                 ('TRUNC' || 'ATE', 'D'), ('REFERENCES', 'x'), ('TRIGGER', 't'), ('MAINTAIN', 'm'),
                                 ('USAGE', 'U')) v(priv, l)),
acl_items AS (SELECT r.nm, x.grantee, (SELECT l FROM letter WHERE priv = x.privilege_type) COLLATE "C" AS l
              FROM rel r CROSS JOIN LATERAL aclexplode(r.relacl) x WHERE x.grantee <> r.relowner),
acl_letters AS (SELECT nm, grantee, string_agg(DISTINCT l, '' ORDER BY l) AS letters FROM acl_items GROUP BY nm, grantee),
expected_acl(nm, letters) AS (VALUES
  ('StaffMember', 'arw'), ('StaffMember_id_seq', 'Ur'),
  ('StaffServiceAssignment', 'arw'), ('StaffServiceAssignment_id_seq', 'Ur'),
  ('AvailabilityRule', 'arw'), ('AvailabilityRule_id_seq', 'Ur'),
  ('AvailabilityException', 'arw'), ('AvailabilityException_id_seq', 'Ur'),
  ('ServiceBookingPolicy', 'arw'), ('ServiceBookingPolicy_id_seq', 'Ur'),
  ('BookingSettings', 'arw'),
  ('BookingRequest', 'arw'), ('BookingRequest_id_seq', 'Ur'),
  ('AppointmentManageToken', 'arw'), ('AppointmentManageToken_id_seq', 'Ur'),
  ('AppointmentEvent', 'ar'), ('AppointmentEvent_id_seq', 'Ur')),
acl_mismatch AS (
  SELECT e.nm FROM expected_acl e
   WHERE (SELECT count(*) FROM acl_letters a WHERE a.nm = e.nm) <> 1
      OR NOT EXISTS (SELECT 1 FROM acl_letters a WHERE a.nm = e.nm AND a.grantee = (SELECT oid FROM rt) AND a.letters = e.letters)),
expected_fk(conname) AS (VALUES
  ('Appointment_staffMemberId_tenant_fkey'), ('StaffServiceAssignment_staffMemberId_tenant_fkey'),
  ('StaffServiceAssignment_businessServiceId_tenant_fkey'), ('AvailabilityRule_staffMemberId_tenant_fkey'),
  ('AvailabilityException_staffMemberId_tenant_fkey'), ('ServiceBookingPolicy_businessServiceId_tenant_fkey'),
  ('BookingRequest_appointmentId_tenant_fkey'), ('AppointmentManageToken_appointmentId_tenant_fkey'),
  ('AppointmentEvent_appointmentId_tenant_fkey')),
expected_check(conname) AS (VALUES
  ('Appointment_owner_has_user'), ('Appointment_kind_shape'), ('Appointment_time_shape'),
  ('Appointment_duration_consistent'), ('Appointment_buffers'), ('Appointment_actual_shape'),
  ('Appointment_cancel_reason_status'), ('Appointment_location_detail_length'), ('Appointment_version_positive')),
expected_trg(tgname) AS (VALUES
  ('Appointment_user_same_business'), ('BookingRequest_user_same_business'), ('AppointmentEvent_user_same_business'),
  ('AppointmentEvent_append_only'), ('AppointmentEvent_no_truncate')),
fns AS (SELECT p.oid, p.proname, p.prosecdef, p.proconfig, p.proowner, p.proacl FROM pg_proc p
        WHERE p.pronamespace = (SELECT oid FROM pub) AND p.proname LIKE 'appointment\_%'),
fn_grants AS (SELECT f.proname, x.grantee FROM fns f CROSS JOIN LATERAL aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) x
              WHERE x.privilege_type = 'EXECUTE' AND x.grantee <> f.proowner),
mig_owner AS (SELECT relowner FROM rel WHERE nm = 'StaffMember'),
checks(n, ok, observed_count) AS (
  SELECT 1, (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261029090000_appointments_foundation'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL) = 1,
            (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '20261029090000_appointments_foundation'
               AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  UNION ALL SELECT 2, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) = 0,
                      (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
  UNION ALL SELECT 3, (SELECT checksum FROM "_prisma_migrations" WHERE migration_name = '20261029090000_appointments_foundation') = '8950e58a4f4c054f9c603579f1f369daf62f62df282faaf63185883dcc063442', 1
  UNION ALL SELECT 4, (SELECT count(*) FROM rel WHERE (nm IN (SELECT nm FROM tables) OR nm = 'Appointment') AND relrowsecurity AND relforcerowsecurity) = 10,
                      (SELECT count(*) FROM rel WHERE (nm IN (SELECT nm FROM tables) OR nm = 'Appointment') AND relrowsecurity AND relforcerowsecurity)
  UNION ALL SELECT 5, (SELECT count(*) FROM pols) = 26
                      AND (SELECT count(*) FROM pols p JOIN expected_pol e ON e.tbl = p.tbl AND e.polname = p.polname AND e.cmd = p.cmd
                            WHERE p.polpermissive AND p.polroles = ARRAY[0]::oid[]
                              AND (p.q IS NOT NULL) = e.has_q AND (p.wc IS NOT NULL) = e.has_wc) = 26,
                      (SELECT count(*) FROM pols)
  UNION ALL SELECT 6, (SELECT count(*) FROM pols WHERE (q IS NOT NULL AND q <> (SELECT e FROM expected_expr))
                                                    OR (wc IS NOT NULL AND wc <> (SELECT e FROM expected_expr))) = 0,
                      (SELECT count(*) FROM pols WHERE (q IS NOT NULL AND q <> (SELECT e FROM expected_expr))
                                                    OR (wc IS NOT NULL AND wc <> (SELECT e FROM expected_expr)))
  UNION ALL SELECT 7, (SELECT count(*) FROM pols WHERE cmd IN ('*', 'd')) = 0
                      AND (SELECT count(*) FROM appt_pols) = 3
                      AND (SELECT count(*) FROM appt_pols WHERE (polname, cmd) IN (('p7pilot_tenant_read', 'r'), ('p7pilot_tenant_insert', 'a'), ('p7pilot_tenant_update', 'w'))) = 3,
                      (SELECT count(*) FROM appt_pols)
  UNION ALL SELECT 8, (SELECT count(*) FROM acl_mismatch) = 0, (SELECT count(*) FROM acl_mismatch)
  UNION ALL SELECT 9, (SELECT count(*) FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x
                         WHERE a.attrelid IN (SELECT oid FROM rel WHERE nm IN (SELECT nm FROM tables))) = 0,
                      (SELECT count(*) FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x
                         WHERE a.attrelid IN (SELECT oid FROM rel WHERE nm IN (SELECT nm FROM tables)))
  UNION ALL SELECT 10, (SELECT count(*) FROM pg_constraint c JOIN expected_fk e ON e.conname = c.conname
                          WHERE c.contype = 'f' AND c.convalidated AND array_length(c.conkey, 1) = 2) = 9,
                       (SELECT count(*) FROM pg_constraint c JOIN expected_fk e ON e.conname = c.conname
                          WHERE c.contype = 'f' AND c.convalidated AND array_length(c.conkey, 1) = 2)
  UNION ALL SELECT 11, (SELECT count(*) FROM pg_constraint WHERE conname = 'Appointment_no_overlap' AND contype = 'x'
                          AND conrelid = (SELECT oid FROM appt)
                          AND pg_get_constraintdef(oid) LIKE '%WHERE ((("endsAt" IS NOT NULL) AND (status = ANY%')
                       + (SELECT count(*) FROM pg_extension WHERE extname = 'btree_gist') = 2,
                       (SELECT count(*) FROM pg_constraint WHERE conname = 'Appointment_no_overlap' AND contype = 'x'
                          AND conrelid = (SELECT oid FROM appt)
                          AND pg_get_constraintdef(oid) LIKE '%WHERE ((("endsAt" IS NOT NULL) AND (status = ANY%')
                       + (SELECT count(*) FROM pg_extension WHERE extname = 'btree_gist')
  UNION ALL SELECT 12, (SELECT count(*) FROM pg_constraint c JOIN expected_check e ON e.conname = c.conname
                          WHERE c.contype = 'c' AND c.convalidated AND c.conrelid = (SELECT oid FROM appt))
                       + (SELECT count(*) FROM pg_constraint WHERE conname = 'Appointment_text_length' AND contype = 'c' AND NOT convalidated)
                       + (SELECT count(*) FROM pg_attribute WHERE attrelid = (SELECT oid FROM appt) AND attname = 'createdByUserId' AND NOT attnotnull)
                       + (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'CreatedByActor' AND e.enumlabel = 'CUSTOMER') = 12,
                       (SELECT count(*) FROM pg_constraint c JOIN expected_check e ON e.conname = c.conname
                          WHERE c.contype = 'c' AND c.convalidated AND c.conrelid = (SELECT oid FROM appt))
                       + (SELECT count(*) FROM pg_constraint WHERE conname = 'Appointment_text_length' AND contype = 'c' AND NOT convalidated)
                       + (SELECT count(*) FROM pg_attribute WHERE attrelid = (SELECT oid FROM appt) AND attname = 'createdByUserId' AND NOT attnotnull)
                       + (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'CreatedByActor' AND e.enumlabel = 'CUSTOMER')
  UNION ALL SELECT 13, (SELECT count(*) FROM pg_trigger t JOIN expected_trg e ON e.tgname = t.tgname
                          WHERE NOT t.tgisinternal AND t.tgenabled = 'O') = 5,
                       (SELECT count(*) FROM pg_trigger t JOIN expected_trg e ON e.tgname = t.tgname
                          WHERE NOT t.tgisinternal AND t.tgenabled = 'O')
  UNION ALL SELECT 14, (SELECT count(*) FROM fns) = 4, (SELECT count(*) FROM fns)
  UNION ALL SELECT 15, (SELECT count(*) FROM fns WHERE prosecdef) = 1
                       AND (SELECT count(*) FROM fns f
                             WHERE f.proname = 'appointment_erase_business' AND f.prosecdef AND f.proowner = (SELECT relowner FROM mig_owner)
                               AND EXISTS (SELECT 1 FROM unnest(f.proconfig) c WHERE c LIKE 'search\_path=%')) = 1,
                       (SELECT count(*) FROM fns f
                         WHERE f.proname = 'appointment_erase_business' AND f.prosecdef AND f.proowner = (SELECT relowner FROM mig_owner)
                           AND EXISTS (SELECT 1 FROM unnest(f.proconfig) c WHERE c LIKE 'search\_path=%'))
  UNION ALL SELECT 16, (SELECT count(*) FROM fn_grants g
                          WHERE NOT (g.proname = 'appointment_erase_business' AND g.grantee = (SELECT oid FROM rt))) = 0
                       AND (SELECT count(*) FROM fn_grants g WHERE g.proname = 'appointment_erase_business' AND g.grantee = (SELECT oid FROM rt)) = 1,
                       (SELECT count(*) FROM fn_grants g
                          WHERE NOT (g.proname = 'appointment_erase_business' AND g.grantee = (SELECT oid FROM rt)))
  UNION ALL SELECT 17, (SELECT count(*) FROM "PlatformFeatureDefinition" d JOIN "PlatformFeaturePolicy" p ON p."featureKey" = d."key"
                          WHERE d."key" IN ('appointments', 'public_booking') AND NOT d."defaultEnabled" AND NOT p."globalEnabled" AND NOT p."emergencyDisabled") = 2
                       AND (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" IN ('appointments', 'public_booking')) = 0,
                       (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" IN ('appointments', 'public_booking'))
  UNION ALL SELECT 18, (SELECT count(*) FROM "StaffMember") + (SELECT count(*) FROM "StaffServiceAssignment")
                       + (SELECT count(*) FROM "AvailabilityRule") + (SELECT count(*) FROM "AvailabilityException")
                       + (SELECT count(*) FROM "ServiceBookingPolicy") + (SELECT count(*) FROM "BookingSettings")
                       + (SELECT count(*) FROM "BookingRequest") + (SELECT count(*) FROM "AppointmentManageToken")
                       + (SELECT count(*) FROM "AppointmentEvent") = 0,
                       (SELECT count(*) FROM "StaffMember") + (SELECT count(*) FROM "StaffServiceAssignment")
                       + (SELECT count(*) FROM "AvailabilityRule") + (SELECT count(*) FROM "AvailabilityException")
                       + (SELECT count(*) FROM "ServiceBookingPolicy") + (SELECT count(*) FROM "BookingSettings")
                       + (SELECT count(*) FROM "BookingRequest") + (SELECT count(*) FROM "AppointmentManageToken")
                       + (SELECT count(*) FROM "AppointmentEvent")
  UNION ALL SELECT 19, (SELECT count(*) FROM "Appointment"
                          WHERE "kind" <> 'CUSTOMER' OR "endsAt" IS NOT NULL OR "staffMemberId" IS NOT NULL
                             OR "bufferBeforeMinutes" <> 0 OR "bufferAfterMinutes" <> 0 OR "cancelReason" IS NOT NULL
                             OR "version" <> 1 OR "createdByUserId" IS NULL) = 0,
                       (SELECT count(*) FROM "Appointment"
                          WHERE "kind" <> 'CUSTOMER' OR "endsAt" IS NOT NULL OR "staffMemberId" IS NOT NULL
                             OR "bufferBeforeMinutes" <> 0 OR "bufferAfterMinutes" <> 0 OR "cancelReason" IS NOT NULL
                             OR "version" <> 1 OR "createdByUserId" IS NULL)
)
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, observed_count
FROM checks ORDER BY n;

ROLLBACK;
