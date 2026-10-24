#!/usr/bin/env bash
# Appointments / migration 20261029090000_appointments_foundation — Production-topology lab.
#
#   .appt/lab.sh <db-name> [--with-appt | --broken-appt]
#
# Builds on the accountant lab (.acct/lab.sh <db> --with-acct, itself on the task reminders / Daily Tasks chain):
# non-superuser CREATEROLE/BYPASSRLS owner, NOLOGIN app_runtime + LOGIN app_runtime_prod, NOLOGIN app_auth, the
# owner's DEFAULT PRIVILEGES, Business under B4's FORCE RLS, the accountant workflow applied by `prisma migrate
# deploy`. Then .appt/prereq.sql adds what Production has on "Appointment" and `db push` cannot make: the cutover-2B
# FORCE RLS with its three p7pilot_* policies, verbatim (20260902120000).
# The ledger is completed with EVERY other migration on this checkout that sorts before this one (real sha256), as
# Production's is. Pending: only this migration. Migrations sorting after it are left out of ledger and deploy.
# schema.prisma may model the appointment tables and columns (the application PR), so the `db push` inside the base
# lab may have built them without the migration's constraints, policies, triggers, functions and grants: they are
# removed here so the migration builds them the way Production will have them.
#   --with-appt:   `prisma migrate deploy` — the release-migrate mechanism — over every migration directory up to
#                  and including this one, which therefore applies exactly this one;
#   --broken-appt: the same with it failing on its last statement (atomicity).
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APPT="20261029090000_appointments_foundation"
bash "$ROOT/.acct/lab.sh" "$DB" --with-acct >/dev/null
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
psql_owner() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" "$@"; }

psql_owner <<'SQL'
DROP TABLE IF EXISTS "AppointmentEvent", "AppointmentManageToken", "BookingRequest", "BookingSettings",
  "ServiceBookingPolicy", "AvailabilityException", "AvailabilityRule", "StaffServiceAssignment" CASCADE;
ALTER TABLE "Appointment"
  DROP COLUMN IF EXISTS "kind", DROP COLUMN IF EXISTS "endsAt", DROP COLUMN IF EXISTS "staffMemberId",
  DROP COLUMN IF EXISTS "locationKind", DROP COLUMN IF EXISTS "locationDetail",
  DROP COLUMN IF EXISTS "bufferBeforeMinutes", DROP COLUMN IF EXISTS "bufferAfterMinutes",
  DROP COLUMN IF EXISTS "holdExpiresAt", DROP COLUMN IF EXISTS "actualStartedAt", DROP COLUMN IF EXISTS "actualEndedAt",
  DROP COLUMN IF EXISTS "cancelReason", DROP COLUMN IF EXISTS "version", DROP COLUMN IF EXISTS "erasedAt";
DROP INDEX IF EXISTS "Appointment_businessId_staffMemberId_startsAt_idx";
DROP TABLE IF EXISTS "StaffMember" CASCADE;
DROP TYPE IF EXISTS "AppointmentKind", "AppointmentLocationKind", "AppointmentCancelReason", "AppointmentEventActor",
  "AppointmentEventType", "AvailabilityExceptionKind", "BookingApprovalMode", "BookingStaffChoice", "BookingRequestStatus";
-- Production's column is NOT NULL before this migration (the table holds no row yet in the lab).
ALTER TABLE "Appointment" ALTER COLUMN "createdByUserId" SET NOT NULL;
DELETE FROM "PlatformFeaturePolicy" WHERE "featureKey" IN ('appointments', 'public_booking');
DELETE FROM "PlatformFeatureDefinition" WHERE "key" IN ('appointments', 'public_booking');
SQL
psql_owner -f "$ROOT/.appt/prereq.sql"

# Production's ledger: every migration of this checkout that sorts before this one is recorded and finished.
LEDGER="$(mktemp)"
for d in "$ROOT"/prisma/migrations/*/; do
  name="$(basename "$d")"
  [ "$name" = "$APPT" ] && continue
  [[ "$name" > "$APPT" ]] && continue
  sum="$(sha256sum "$d/migration.sql" | cut -d' ' -f1)"
  echo "INSERT INTO \"_prisma_migrations\" (id, checksum, finished_at, migration_name, applied_steps_count)
        SELECT gen_random_uuid()::text, '$sum', now(), '$name', 1
        WHERE NOT EXISTS (SELECT 1 FROM \"_prisma_migrations\" WHERE migration_name = '$name');" >> "$LEDGER"
done
psql_owner -f "$LEDGER"; rm -f "$LEDGER"

case "$MODE" in
  --with-appt|--broken-appt) ;;
  *) echo "LAB READY: $DB (ledger = every migration before this one; appointments foundation pending)"; exit 0 ;;
esac

TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
for d in "$ROOT"/prisma/migrations/*/; do [[ "$(basename "$d")" > "$APPT" ]] && continue; cp -r "$d" "$TMP/prisma/migrations/$(basename "$d")"; done
if [ "$MODE" = "--broken-appt" ]; then
  printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$TMP/prisma/migrations/$APPT/migration.sql"
fi
set +e
( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) > "$TMP/deploy.log" 2>&1
rc=$?
set -e
grep -E "migrations found|Applying migration|have been successfully applied|No pending|Error|error" "$TMP/deploy.log" | head -8
rm -rf "$TMP"
if [ "$MODE" = "--broken-appt" ]; then
  [ $rc -ne 0 ] || { echo "broken migration did NOT fail"; exit 1; }
  echo "LAB READY: $DB (appointments foundation FAILED on its last statement as intended)"; exit 0
fi
[ $rc -eq 0 ] || { echo "appointments foundation deploy failed"; exit 1; }
echo "LAB READY: $DB (appointments foundation applied)"
