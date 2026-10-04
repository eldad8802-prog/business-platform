#!/usr/bin/env bash
# P3-A / migrations 20261008090000_p3a_identity_enum_values + 20261008090100_p3a_trust_claims —
# Production-topology lab.
#
#   .p3a/lab.sh <db-name> [--with-p3a | --broken-p3a]
#
# Production once Wave-2 is applied: 167 migrations, the last one 20261007090000_cost_learning_wave2_patterns
# (its release-migrate run is at the gate as this is written; P3-A is applied only after it). This lab is that:
#   1. .c594/lab.sh <db> — non-superuser CREATEROLE/BYPASSRLS owner, NOLOGIN app_runtime + LOGIN
#      app_runtime_prod, the owner's DEFAULT PRIVILEGES (which would hand the runtime DELETE on any
#      new table — P3-A must take that back), baselined ledger, #594 by migrate deploy;
#   2. app_auth / app_ctlplane exist (B4 refuses without app_auth), the real D2 E4 narrowing;
#   3. `prisma migrate deploy` over the migrations up to and INCLUDING Wave-2 (P2, cost wave 1, B4,
#      cost wave 2) —
#      so the P2 tables P3-A alters are the real ones, built by the real P2 migration;
#   4. --with-p3a: `prisma migrate deploy` again, up to and including both P3-A files — the
#      release-migrate mechanism, which therefore applies exactly the two P3-A migrations.
#      --broken-p3a: the second P3-A file fails on its last statement.
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASELINE="20261007090000_cost_learning_wave2_patterns"
P3A_ENUMS="20261008090000_p3a_identity_enum_values"
P3A="20261008090100_p3a_trust_claims"
bash "$ROOT/.c594/lab.sh" "$DB" >/dev/null
psql -X -v ON_ERROR_STOP=1 -q -U "$SUPER" -d postgres -c \
  "DO \$\$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_auth') THEN CREATE ROLE app_auth NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_ctlplane') THEN CREATE ROLE app_ctlplane NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
   END \$\$"
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" -f "$ROOT/prisma/migrations/20260908180000_d2_user_business_privilege_narrowing/migration.sql"

# `prisma db push` (inside .c594/lab.sh) built every table from schema.prisma, P2's included, without
# the P2 migration's CHECKs, partial indexes, policies or grants. Production's P2 tables were built
# by that migration, and P3-A replaces two of its CHECKs by name — so drop what db push made for P2
# and let migrate deploy build it the way Production has it.
psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" \
  -c 'DROP TABLE IF EXISTS "BusinessIdentityStatement", "BusinessIdentityFactAuthority" CASCADE' \
  -c 'DROP TYPE IF EXISTS "BusinessIdentityDimension", "BusinessIdentitySource", "BusinessIdentityStatus", "BusinessIdentityFact" CASCADE' \
  -c "DELETE FROM \"_prisma_migrations\" WHERE migration_name > '20261003090000_control_plane_production_privileges'"

deploy_upto() {  # deploy_upto <last-migration-name> [broken]
  local TMP; TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
  cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
  cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
  for d in "$ROOT"/prisma/migrations/*/; do
    local name; name="$(basename "$d")"
    [[ "$name" > "$1" ]] && continue
    cp -r "$d" "$TMP/prisma/migrations/$name"
  done
  if [ "${2:-}" = "broken" ]; then
    printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$TMP/prisma/migrations/$1/migration.sql"
  fi
  set +e
  ( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) > "$TMP/deploy.log" 2>&1
  local rc=$?
  set -e
  grep -E "Applying migration|have been successfully applied|Error|error" "$TMP/deploy.log" | head -8
  rm -rf "$TMP"
  return $rc
}

deploy_upto "$BASELINE" >/dev/null || { echo "baseline deploy (up to Wave-2) failed"; exit 1; }

case "$MODE" in
  --with-p3a)   deploy_upto "$P3A" || { echo "P3-A deploy failed"; exit 1; } ;;
  --broken-p3a) if deploy_upto "$P3A" broken; then echo "broken P3-A did NOT fail"; exit 1; fi
                echo "LAB READY: $DB (P3-A deploy FAILED as intended)"; exit 0 ;;
esac
echo "LAB READY: $DB (${MODE:-Production before P3-A: 167 applied, Wave-2 last, P3-A pending})"
