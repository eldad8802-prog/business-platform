#!/usr/bin/env bash
# Milestone C (public booking) / migration 20261106090000_public_booking_foundation — Production-topology lab.
#
#   .bkg/lab.sh <db-name> [--with-bkg | --broken-bkg]
#
# Builds on the appointments lab (.appt/lab.sh <db> --with-appt): the same roles (non-superuser BYPASSRLS owner,
# NOLOGIN app_runtime + LOGIN app_runtime_prod, app_auth), the appointments foundation applied by `prisma migrate
# deploy`. That lab rebuilds "StaffMember" and "BookingSettings" from the appointments migration, so neither carries
# this migration's columns; anything else `db push` made for this migration (the enum, when schema.prisma models it)
# is removed here so the migration builds it the way Production will have it.
# The ledger is completed with every migration of this checkout that sorts between the appointments foundation and
# this one (real sha256), as Production's will be. Pending: only this migration.
#   --with-bkg:   `prisma migrate deploy` — the release-migrate mechanism — applies exactly this one;
#   --broken-bkg: the same with it failing on its last statement (atomicity);
#   --deploy-only: skip the base lab and the ledger (a lab already built by a plain run, with rows added in between).
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APPT="20261029090000_appointments_foundation"
BKG="20261106090000_public_booking_foundation"
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
psql_owner() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" "$@"; }

if [ "$MODE" != "--deploy-only" ]; then
bash "$ROOT/.appt/lab.sh" "$DB" --with-appt >/dev/null

psql_owner <<'SQL'
ALTER TABLE "StaffMember" DROP COLUMN IF EXISTS "publicBookable";
ALTER TABLE "BookingSettings"
  DROP COLUMN IF EXISTS "assignmentMode", DROP COLUMN IF EXISTS "selfCancelEnabled",
  DROP COLUMN IF EXISTS "selfCancelWindowHours", DROP COLUMN IF EXISTS "maxOpenRequestsPerPhone",
  DROP COLUMN IF EXISTS "showAddress", DROP COLUMN IF EXISTS "showBusinessDetails",
  DROP COLUMN IF EXISTS "showPrices", DROP COLUMN IF EXISTS "showStaffNames";
DROP TYPE IF EXISTS "BookingAssignmentMode";
DROP FUNCTION IF EXISTS public.booking_resolve_public(text);
DROP FUNCTION IF EXISTS public.booking_pending_due(timestamp(3), integer);
SQL

LEDGER="$(mktemp)"
for d in "$ROOT"/prisma/migrations/*/; do
  name="$(basename "$d")"
  [[ "$name" > "$APPT" ]] || continue
  [[ "$name" < "$BKG" ]] || continue
  sum="$(sha256sum "$d/migration.sql" | cut -d' ' -f1)"
  echo "INSERT INTO \"_prisma_migrations\" (id, checksum, finished_at, migration_name, applied_steps_count)
        SELECT gen_random_uuid()::text, '$sum', now(), '$name', 1
        WHERE NOT EXISTS (SELECT 1 FROM \"_prisma_migrations\" WHERE migration_name = '$name');" >> "$LEDGER"
done
[ -s "$LEDGER" ] && psql_owner -f "$LEDGER"; rm -f "$LEDGER"
fi

case "$MODE" in
  --with-bkg|--broken-bkg|--deploy-only) ;;
  *) echo "LAB READY: $DB (ledger = every migration before this one; public booking foundation pending)"; exit 0 ;;
esac

TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
for d in "$ROOT"/prisma/migrations/*/; do [[ "$(basename "$d")" > "$BKG" ]] && continue; cp -r "$d" "$TMP/prisma/migrations/$(basename "$d")"; done
if [ "$MODE" = "--broken-bkg" ]; then
  printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$TMP/prisma/migrations/$BKG/migration.sql"
fi
set +e
( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) > "$TMP/deploy.log" 2>&1
rc=$?
set -e
grep -E "migrations found|Applying migration|have been successfully applied|No pending|Error|error" "$TMP/deploy.log" | head -8
rm -rf "$TMP"
if [ "$MODE" = "--broken-bkg" ]; then
  [ $rc -ne 0 ] || { echo "broken migration did NOT fail"; exit 1; }
  echo "LAB READY: $DB (public booking foundation FAILED on its last statement as intended)"; exit 0
fi
[ $rc -eq 0 ] || { echo "public booking foundation deploy failed"; exit 1; }
echo "LAB READY: $DB (public booking foundation applied)"
