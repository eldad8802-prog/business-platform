#!/usr/bin/env bash
# P3-E / migration 20261013090000_p3e_landing_persistence — Production-topology lab.
#
#   .p3e/lab.sh <db-name> [--with-p3e | --broken-p3e]
#
# Builds on the P3-A lab (.p3a/lab.sh <db> --joint): non-superuser CREATEROLE/BYPASSRLS owner, NOLOGIN
# app_runtime + LOGIN app_runtime_prod, the owner's DEFAULT PRIVILEGES (which would hand the runtime
# DELETE / TRUNCATE / table-wide UPDATE on any new table — P3-E must take that back), Business under B4's
# FORCE RLS, and the ledger through 20261009090000_m6_acquisition_connections.
# The migrations main merged after M6 (business-brain policies, M1 onboarding / consent / email case-fold,
# closed-loop evidence) are left out: their objects already come from `db push` in this lab, and P3-E
# names none of them (step 0 of the workflow asserts that). P3-E depends on Business alone.
#   --with-p3e:   `prisma migrate deploy` — the release-migrate mechanism — applies P3-E;
#   --broken-p3e: the same with P3-E failing on its last statement (atomicity).
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
M6="20261009090000_m6_acquisition_connections"
P3E="20261013090000_p3e_landing_persistence"
bash "$ROOT/.p3a/lab.sh" "$DB" --joint >/dev/null
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
# If schema.prisma models P3-E (the application PR), `db push` built the tables without the migration's
# policies, triggers and grants: drop them so the migration builds them the way Production will have them.
PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" \
  -c 'DROP TABLE IF EXISTS "LandingPageVersion", "LandingPage" CASCADE' \
  -c 'DROP TYPE IF EXISTS "LandingVersionStatus", "LandingVersionAuthority" CASCADE'

case "$MODE" in
  --with-p3e|--broken-p3e) ;;
  *) echo "LAB READY: $DB (through M6; P3-E pending)"; exit 0 ;;
esac

TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
for d in "$ROOT"/prisma/migrations/*/; do
  name="$(basename "$d")"
  if [[ ! "$name" > "$M6" || "$name" == "$P3E" ]]; then cp -r "$d" "$TMP/prisma/migrations/$name"; fi
done
if [ "$MODE" = "--broken-p3e" ]; then
  printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$TMP/prisma/migrations/$P3E/migration.sql"
fi
set +e
( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) > "$TMP/deploy.log" 2>&1
rc=$?
set -e
grep -E "Applying migration|have been successfully applied|Error|error" "$TMP/deploy.log" | head -8
rm -rf "$TMP"
if [ "$MODE" = "--broken-p3e" ]; then
  [ $rc -ne 0 ] || { echo "broken P3-E did NOT fail"; exit 1; }
  echo "LAB READY: $DB (P3-E FAILED on its last statement as intended)"; exit 0
fi
[ $rc -eq 0 ] || { echo "P3-E deploy failed"; exit 1; }
echo "LAB READY: $DB (P3-E applied)"
