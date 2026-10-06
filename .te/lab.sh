#!/usr/bin/env bash
# Transactional email foundation / migration 20261015090000_transactional_email_foundation — lab.
#
#   .te/lab.sh <db-name> [--with-te | --broken-te]
#
# Builds on the P3-E lab (.p3e/lab.sh <db> --with-p3e): non-superuser CREATEROLE/BYPASSRLS owner,
# NOLOGIN app_runtime + LOGIN app_runtime_prod, NOLOGIN app_auth (the real D2 E4 narrowing on User),
# the owner's DEFAULT PRIVILEGES (which would hand the runtime arwd on any new table — this migration
# must take that back), Business under B4's FORCE RLS; ledger through M6 + P3-E.
# The migrations main merged after M6 other than P3-E are left out of the lab ledger, exactly as in the
# P3-E lab: their objects come from `db push` here, and this migration names none of them (step 0 of the
# workflow asserts that). It depends on Business and User alone.
#   --with-te:   `prisma migrate deploy` — the release-migrate mechanism — applies it;
#   --broken-te: the same with it failing on its last statement (atomicity).
# A LOGIN member of app_auth (te_auth_login) is created so the battery can act as the signup plane.
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
M6="20261009090000_m6_acquisition_connections"
P3E="20261013090000_p3e_landing_persistence"
TE="20261015090000_transactional_email_foundation"
bash "$ROOT/.p3e/lab.sh" "$DB" --with-p3e >/dev/null
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
psql_owner() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" "$@"; }
# If schema.prisma models the table (the application PR), `db push` built it without the migration's
# policies and grants: drop it so the migration builds it the way Production will have it.
psql_owner -c 'DROP TABLE IF EXISTS "TransactionalEmail" CASCADE'
# The signup-plane login the battery acts as (Production: app_auth_prod). Created by the superuser:
# granting membership in app_auth needs ADMIN on it, which lab_owner (like Production's owner) lacks.
psql_super() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q -U "$SUPER" -d "$DB" "$@"; }
psql_super -c "DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'te_auth_login') THEN
    CREATE ROLE te_auth_login LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${LAB_PASSWORD:-}' IN ROLE app_auth;
  END IF; END \$\$"

case "$MODE" in
  --with-te|--broken-te) ;;
  *) echo "LAB READY: $DB (through M6 + P3-E; transactional email pending)"; exit 0 ;;
esac

TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
for d in "$ROOT"/prisma/migrations/*/; do
  name="$(basename "$d")"
  if [[ ! "$name" > "$M6" || "$name" == "$P3E" || "$name" == "$TE" ]]; then cp -r "$d" "$TMP/prisma/migrations/$name"; fi
done
if [ "$MODE" = "--broken-te" ]; then
  printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$TMP/prisma/migrations/$TE/migration.sql"
fi
set +e
( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) > "$TMP/deploy.log" 2>&1
rc=$?
set -e
grep -E "Applying migration|have been successfully applied|Error|error" "$TMP/deploy.log" | head -8
rm -rf "$TMP"
if [ "$MODE" = "--broken-te" ]; then
  [ $rc -ne 0 ] || { echo "broken migration did NOT fail"; exit 1; }
  echo "LAB READY: $DB (transactional email FAILED on its last statement as intended)"; exit 0
fi
[ $rc -eq 0 ] || { echo "transactional email deploy failed"; exit 1; }
echo "LAB READY: $DB (transactional email applied)"
