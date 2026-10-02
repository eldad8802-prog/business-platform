#!/usr/bin/env bash
# P2 (#601) / migration 20261004090000_p2_business_identity — Production-topology lab.
#
#   .p2/lab.sh <db-name> [--with-p2 | --broken-p2]
#
# Production today (2026-10-02): 163 migrations applied, the last one #594; P2 merged on main and
# PENDING. This lab is exactly that:
#   1. .c594/lab.sh <db>  — non-superuser CREATEROLE/BYPASSRLS owner (neondb_owner's shape), NOLOGIN
#      app_runtime + LOGIN app_runtime_prod, the owner's DEFAULT PRIVILEGES (app_runtime arwd on new
#      tables, rU on new sequences), baselined ledger, #594 applied by `prisma migrate deploy`;
#   2. app_auth (NOLOGIN) and the real D2 E4 Business/User narrowing (as Production);
#   3. --with-p2: `prisma migrate deploy` over the migrations up to and INCLUDING P2 only — the
#      release-migrate mechanism, which therefore applies exactly P2 (a later pending migration never
#      rides along). --broken-p2: a copy of P2 that fails on its last statement (atomicity).
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
P2="20261004090000_p2_business_identity"
bash "$ROOT/.c594/lab.sh" "$DB" >/dev/null
psql -X -v ON_ERROR_STOP=1 -q -U "$SUPER" -d postgres -c \
  "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_auth') THEN CREATE ROLE app_auth NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END \$\$"
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" -f "$ROOT/prisma/migrations/20260908180000_d2_user_business_privilege_narrowing/migration.sql"

# Lab faults only: SQL run as the owner just before the deploy (e.g. a drifted default ACL).
if [ -n "${LAB_PRE_SQL:-}" ]; then psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" -c "$LAB_PRE_SQL"; fi

if [ -n "$MODE" ]; then
  TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
  cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
  cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
  for d in "$ROOT"/prisma/migrations/*/; do
    name="$(basename "$d")"
    [[ "$name" > "$P2" ]] && continue
    cp -r "$d" "$TMP/prisma/migrations/$name"
  done
  if [ "$MODE" = "--broken-p2" ]; then
    printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$TMP/prisma/migrations/$P2/migration.sql"
  fi
  set +e
  ( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) > "$TMP/deploy.log" 2>&1
  rc=$?
  set -e
  grep -E "Applying migration|have been successfully applied|Error|error" "$TMP/deploy.log" | head -5
  rm -rf "$TMP"
  if [ "$MODE" = "--broken-p2" ]; then
    [ $rc -ne 0 ] || { echo "broken P2 did NOT fail"; exit 1; }
    echo "LAB READY: $DB (P2 deploy FAILED as intended, rc=$rc)"; exit 0
  fi
  [ $rc -eq 0 ] || { echo "migrate deploy failed (rc=$rc)"; exit 1; }
fi
echo "LAB READY: $DB (${MODE:-Production today: #594 applied, P2 pending})"
