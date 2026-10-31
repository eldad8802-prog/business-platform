#!/usr/bin/env bash
# G5 milestone 1 (M2 monitor + M1 delivery tracking) — the application battery on the Production-shaped lab.
#
#   1. baseline = Production today (as .acct/ops-lab.sh step 0): the accountant workflow and its link events applied
#      by `prisma migrate deploy`, the console's read role as Production has it (app_admin + a LOGIN member);
#   2. the three 20261107 migrations applied by `prisma migrate deploy` (the release-migrate mechanism);
#   3. .acct/ops-app-battery.ts as the runtime (DATABASE_URL = app_runtime_prod) and the console (app_admin_lab).
#
#   OPS_BASE_TEMPLATE=<db>  reuse an existing baseline database as the template instead of building one (local runs).
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD. Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LE="20261105090000_accountant_link_events"
C="20261107092000_accountant_ops_admin_read"
M5="20261109091000_accountant_link_otp"   # G5 M4 + M5: the sending code checks the permission and the portal the device
P="${LAB_PASSWORD:-}"
url() { echo "postgresql://$1${P:+:$P}@${PGHOST}:${PGPORT}/$2"; }
owner_sql() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$(url lab_owner "$1")" "${@:2}"; }
super_sql() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q -U "$SUPER" -d "$1" "${@:2}"; }
pending() { case "$1" in "$LE"|2026110709*|2026110909*) return 0 ;; *) return 1 ;; esac; }

deploy() {
  local db="$1" upto="$2" tmp ledger; tmp="$(mktemp -d)"; mkdir -p "$tmp/prisma/migrations"
  cp "$ROOT/prisma/schema.prisma" "$tmp/prisma/schema.prisma"
  cp "$ROOT/prisma/migrations/migration_lock.toml" "$tmp/prisma/migrations/"
  ledger="$(mktemp)"
  for d in "$ROOT"/prisma/migrations/*/; do
    local n; n="$(basename "$d")"
    [[ "$n" > "$upto" ]] && continue
    cp -r "$d" "$tmp/prisma/migrations/$n"
    pending "$n" && continue
    echo "INSERT INTO \"_prisma_migrations\" (id, checksum, finished_at, migration_name, applied_steps_count)
          SELECT gen_random_uuid()::text, '$(sha256sum "$d/migration.sql" | cut -d' ' -f1)', now(), '$n', 1
          WHERE NOT EXISTS (SELECT 1 FROM \"_prisma_migrations\" WHERE migration_name = '$n');" >> "$ledger"
  done
  owner_sql "$db" -f "$ledger"; rm -f "$ledger"
  ( cd "$ROOT" && DATABASE_URL="$(url lab_owner "$db")" DIRECT_URL="$(url lab_owner "$db")" node_modules/.bin/prisma migrate deploy --schema "$tmp/prisma/schema.prisma" ) > "$tmp/deploy.log" 2>&1 \
    || { cat "$tmp/deploy.log"; rm -rf "$tmp"; return 1; }
  grep -E "Applying migration|successfully applied|No pending" "$tmp/deploy.log" | head -6
  rm -rf "$tmp"
}

if [ -n "${OPS_BASE_TEMPLATE:-}" ]; then
  BASE="$OPS_BASE_TEMPLATE"
  echo "== 1. baseline: reusing $BASE"
else
  BASE=ops_app_base
  echo "== 1. baseline = Production today"
  bash "$ROOT/.acct/lab.sh" "$BASE" --with-acct | tail -1
  # schema.prisma models the monitoring tables: `db push` built them without the migration's checks and grants.
  owner_sql "$BASE" -c 'DROP TABLE IF EXISTS "AccountantBusinessAlert", "AccountantOpsAlert", "AccountantOpsRun", "AccountantLinkChallenge", "AccountantLinkDevice" CASCADE'
  super_sql "$BASE" <<SQL
DO \$do\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin') THEN
    CREATE ROLE app_admin NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin_lab') THEN
    CREATE ROLE app_admin_lab LOGIN NOSUPERUSER NOBYPASSRLS ${P:+PASSWORD '$P'} IN ROLE app_admin;
  END IF;
END
\$do\$;
GRANT USAGE ON SCHEMA public TO app_admin;
SQL
  deploy "$BASE" "$LE"
fi
super_sql postgres -c "DROP DATABASE IF EXISTS ops_app" -c "CREATE DATABASE ops_app TEMPLATE $BASE OWNER lab_owner"
# The console's read plane as Production has it (20261024090000_platform_admin_a1 — recorded, not run, in the lab).
owner_sql ops_app -c 'GRANT SELECT ("id", "name") ON "Business" TO app_admin'

echo "== 2. the three 20261107 migrations (+ G5 M4/M5, which the application now needs)"
deploy ops_app "$M5"
[ "$(owner_sql ops_app -At -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name LIKE '2026110709%' AND finished_at IS NOT NULL")" = "3" ] \
  || { echo "the three migrations are not all applied"; exit 1; }

echo "== 3. the application battery"
OWNER_URL="$(url lab_owner ops_app)" DATABASE_URL="$(url app_runtime_prod ops_app)" DIRECT_URL="$(url app_runtime_prod ops_app)" \
  ADMIN_DATABASE_URL="$(url app_admin_lab ops_app)" npx tsx "$ROOT/.acct/ops-app-battery.ts"
