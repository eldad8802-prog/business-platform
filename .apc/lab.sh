#!/usr/bin/env bash
# Appointments completion / migration 20261226090000_appointments_completion — Production-topology lab.
#
#   .apc/lab.sh <db-name> [--with-apc | --broken-apc | --deploy-only]
#
# Chains the public booking lab (.bkg/lab.sh <db> --with-bkg: the appointments foundation and the public booking
# foundation applied by `prisma migrate deploy` on Production's role topology — non-superuser CREATEROLE/BYPASSRLS
# owner, NOLOGIN app_runtime + LOGIN app_runtime_prod, app_auth, the owner's DEFAULT PRIVILEGES), then brings the
# notification engine foundation onto the same database (NTE_ONTO=1 .nte/lab.sh --with-nte: FORCE RLS + tenant
# policies on "Notification" / "NotificationDelivery" from their canonical migration, the worker's columns), so this
# migration meets exactly the objects it extends.
# `db push` (inside the base lab) builds this branch's schema.prisma, which models this migration: everything it made
# for it is removed here (the two tables, the new columns, the new enum, and the WHATSAPP label — "NotificationChannel"
# is rebuilt without it) so the migration builds them the way Production will have them. "Customer" gets Production's
# ("businessId", "id") key (20260926110000, which `db push` cannot make) when it is missing.
# The ledger is completed with EVERY migration of this checkout that sorts before this one (real sha256), as
# Production's is. Pending: only this migration.
#   (no flag):      the migration is pending (APC_SEED, optional: a SQL file run as the owner — rows written before);
#   --with-apc:     `prisma migrate deploy` — the release-migrate mechanism — applies exactly this one;
#   --broken-apc:   the same with it failing on its last statement (atomicity);
#   --deploy-only:  skip the build (a pending lab built by a plain run, with rows added in between) and deploy.
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional), APC_SEED (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APC="20261226090000_appointments_completion"
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
psql_owner() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" "$@"; }

if [ "$MODE" != "--deploy-only" ]; then
bash "$ROOT/.bkg/lab.sh" "$DB" --with-bkg >/dev/null

psql_owner <<'SQL'
DROP TABLE IF EXISTS "AppointmentSeries", "BookingPhoneChallenge" CASCADE;
DROP INDEX IF EXISTS "Appointment_businessId_seriesId_seriesIndex_key";
DROP INDEX IF EXISTS "Appointment_businessId_seriesId_idx";
ALTER TABLE "Appointment" DROP COLUMN IF EXISTS "seriesId", DROP COLUMN IF EXISTS "seriesIndex";
ALTER TABLE "BookingSettings"
  DROP COLUMN IF EXISTS "selfRescheduleEnabled", DROP COLUMN IF EXISTS "selfRescheduleWindowHours",
  DROP COLUMN IF EXISTS "reminderOffsetsMinutes", DROP COLUMN IF EXISTS "bookingHorizonDays", DROP COLUMN IF EXISTS "showLogo";
ALTER TABLE "BookingRequest" DROP COLUMN IF EXISTS "phoneVerifiedAt";
ALTER TABLE "NotificationDelivery"
  DROP COLUMN IF EXISTS "recipientKind", DROP COLUMN IF EXISTS "recipientPhone", DROP COLUMN IF EXISTS "templateKey",
  DROP COLUMN IF EXISTS "messageClass", DROP COLUMN IF EXISTS "providerMessageId", DROP COLUMN IF EXISTS "providerStatus",
  DROP COLUMN IF EXISTS "providerUpdatedAt", DROP COLUMN IF EXISTS "appointmentId";
DROP TYPE IF EXISTS "AppointmentSeriesFrequency";
-- `db push` made "NotificationChannel" with this branch's WHATSAPP label: rebuild it as Production has it.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'NotificationChannel' AND e.enumlabel = 'WHATSAPP') THEN
    ALTER TYPE "NotificationChannel" RENAME TO "NotificationChannel_apc_lab";
    CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'PUSH');
    ALTER TABLE "Notification" ALTER COLUMN "intendedChannels" TYPE "NotificationChannel"[] USING "intendedChannels"::text[]::"NotificationChannel"[];
    ALTER TABLE "NotificationDelivery" ALTER COLUMN "channel" TYPE "NotificationChannel" USING "channel"::text::"NotificationChannel";
    DROP TYPE "NotificationChannel_apc_lab";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Customer_businessId_id_key') THEN
    ALTER TABLE "Customer" ADD CONSTRAINT "Customer_businessId_id_key" UNIQUE ("businessId", "id");
  END IF;
END
$do$;
SQL

NTE_ONTO=1 bash "$ROOT/.nte/lab.sh" "$DB" --with-nte >/dev/null

# Production's ledger: every migration of this checkout that sorts before this one is recorded and finished.
LEDGER="$(mktemp)"
for d in "$ROOT"/prisma/migrations/*/; do
  name="$(basename "$d")"
  [[ "$name" < "$APC" ]] || continue
  sum="$(sha256sum "$d/migration.sql" | cut -d' ' -f1)"
  echo "INSERT INTO \"_prisma_migrations\" (id, checksum, finished_at, migration_name, applied_steps_count)
        SELECT gen_random_uuid()::text, '$sum', now(), '$name', 1
        WHERE NOT EXISTS (SELECT 1 FROM \"_prisma_migrations\" WHERE migration_name = '$name');" >> "$LEDGER"
done
psql_owner -f "$LEDGER"; rm -f "$LEDGER"
if [ -n "${APC_SEED:-}" ]; then psql_owner -f "$APC_SEED"; fi
fi

case "$MODE" in
  --with-apc|--broken-apc|--deploy-only) ;;
  *) echo "LAB READY: $DB (ledger = every migration before this one; appointments completion pending)"; exit 0 ;;
esac

TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
for d in "$ROOT"/prisma/migrations/*/; do [[ "$(basename "$d")" > "$APC" ]] && continue; cp -r "$d" "$TMP/prisma/migrations/$(basename "$d")"; done
if [ "$MODE" = "--broken-apc" ]; then
  printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$TMP/prisma/migrations/$APC/migration.sql"
fi
set +e
( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) > "$TMP/deploy.log" 2>&1
rc=$?
set -e
grep -E "migrations found|Applying migration|have been successfully applied|No pending|Error|error" "$TMP/deploy.log" | head -8
rm -rf "$TMP"
if [ "$MODE" = "--broken-apc" ]; then
  [ $rc -ne 0 ] || { echo "broken migration did NOT fail"; exit 1; }
  echo "LAB READY: $DB (appointments completion FAILED on its last statement as intended)"; exit 0
fi
[ $rc -eq 0 ] || { echo "appointments completion deploy failed"; exit 1; }
echo "LAB READY: $DB (appointments completion applied)"
