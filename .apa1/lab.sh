#!/usr/bin/env bash
# Admin Control Center A1 / migration 20261024090000_platform_admin_a1 — Production-topology lab.
#
#   .apa1/lab.sh <db-name> [--with-apa1 | --broken-apa1]
#
# Builds on the task reminders lab (.trp/lab.sh <db> --with-trp): non-superuser CREATEROLE/BYPASSRLS owner whose
# DEFAULT PRIVILEGES hand new tables to the runtime, NOLOGIN app_runtime + LOGIN app_runtime_prod, app_auth,
# FORCE RLS on Business, the ledger through 20261022090000 — i.e. Production with A1 the only pending migration.
# Then .apa1/prereq.sql adds what the A1 migration builds on and `db push` cannot make: the app_admin group, the
# tenant RLS and policies on the tables the console reads, and the six existing p7adm_read policies.
# schema.prisma models PlatformAdminPasskey (this PR), so `db push` built it without the migration's checks and
# grants: it is dropped first so the migration builds it the way Production will have it.
# Two LOGIN roles join the groups for the battery: app_admin_lab (app_admin) and app_auth_lab (app_auth).
#   --with-apa1:   `prisma migrate deploy` — the release-migrate mechanism — applies it;
#   --broken-apa1: the same with it failing on its last statement (atomicity).
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
M6="20261009090000_m6_acquisition_connections"
P3E="20261013090000_p3e_landing_persistence"
TE="20261015090000_transactional_email_foundation"
AET="20261017090000_auth_email_tokens"
DT="20261018090000_daily_tasks_foundation"
TRP="20261022090000_task_reminders_push"
APA1="20261024090000_platform_admin_a1"
bash "$ROOT/.trp/lab.sh" "$DB" --with-trp >/dev/null
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
psql_owner() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" "$@"; }

psql_owner -c 'DROP TABLE IF EXISTS "PlatformAdminPasskey" CASCADE'
psql_owner -f "$ROOT/.apa1/prereq.sql"

PW="${LAB_PASSWORD:-}"
psql -X -v ON_ERROR_STOP=1 -q -U "$SUPER" -d postgres -c \
  "DO \$\$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin_lab') THEN
       CREATE ROLE app_admin_lab LOGIN INHERIT NOSUPERUSER NOBYPASSRLS PASSWORD '${PW}';
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_auth_lab') THEN
       CREATE ROLE app_auth_lab LOGIN INHERIT NOSUPERUSER NOBYPASSRLS PASSWORD '${PW}';
     END IF;
   END \$\$" \
  -c "GRANT app_admin TO app_admin_lab" \
  -c "GRANT app_auth TO app_auth_lab"
psql -X -v ON_ERROR_STOP=1 -q -U "$SUPER" -d "$DB" -c "GRANT CONNECT ON DATABASE \"$DB\" TO app_admin_lab, app_auth_lab"

case "$MODE" in
  --with-apa1|--broken-apa1) ;;
  *) echo "LAB READY: $DB (through 20261022090000 + A1 prerequisites; A1 pending)"; exit 0 ;;
esac

TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
for d in "$ROOT"/prisma/migrations/*/; do
  name="$(basename "$d")"
  if [[ ! "$name" > "$M6" || "$name" == "$P3E" || "$name" == "$TE" || "$name" == "$AET" || "$name" == "$DT" || "$name" == "$TRP" || "$name" == "$APA1" ]]; then
    cp -r "$d" "$TMP/prisma/migrations/$name"
  fi
done
if [ "$MODE" = "--broken-apa1" ]; then
  printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$TMP/prisma/migrations/$APA1/migration.sql"
fi
set +e
( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) > "$TMP/deploy.log" 2>&1
rc=$?
set -e
grep -E "Applying migration|have been successfully applied|Error|error" "$TMP/deploy.log" | head -8
rm -rf "$TMP"
if [ "$MODE" = "--broken-apa1" ]; then
  [ $rc -ne 0 ] || { echo "broken migration did NOT fail"; exit 1; }
  echo "LAB READY: $DB (A1 FAILED on its last statement as intended)"; exit 0
fi
[ $rc -eq 0 ] || { echo "A1 deploy failed"; exit 1; }
echo "LAB READY: $DB (A1 applied)"
