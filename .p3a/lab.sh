#!/usr/bin/env bash
# P3-A / migrations 20261008090000_p3a_identity_enum_values + 20261008090100_p3a_trust_claims —
# Production-topology lab.
#
#   .p3a/lab.sh <db-name> [--joint | --with-p3a | --broken-p3a]
#
# Production before the JOINT release: 168 migrations applied, the last one
# 20261008090000_learning_coverage_policies (cost Wave-2 before it), and three pending — P3-A #1,
# P3-A #2 and 20261009090000_m6_acquisition_connections. M6 merged before P3-A and sorts after it;
# `prisma migrate deploy` applies every pending migration in order, so ONE release-migrate run applies
# all three. This lab is that:
#   1. .c594/lab.sh <db> — non-superuser CREATEROLE/BYPASSRLS owner, NOLOGIN app_runtime + LOGIN
#      app_runtime_prod, the owner's DEFAULT PRIVILEGES (which would hand the runtime DELETE on any
#      new table — P3-A must take that back), baselined ledger, #594 by migrate deploy;
#   2. app_auth / app_ctlplane exist (B4 refuses without app_auth), the real D2 E4 narrowing;
#   3. `prisma migrate deploy` over the migrations up to and INCLUDING the 168th (P2, cost wave 1, B4,
#      cost wave 2, learning-coverage policies) — so the P2 tables P3-A alters are the real ones,
#      built by the real P2 migration;
#   4. --joint: `prisma migrate deploy` again over main as it is — the release-migrate mechanism,
#      which therefore applies exactly P3-A #1, P3-A #2, M6, in that order (the real release);
#      --with-p3a: the P3-A pair only — the comparison point for "M6 changes nothing P3-A owns";
#      --broken-p3a: the joint release with P3-A #2 failing on its last statement (M6 must not run).
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASELINE="20261008090000_learning_coverage_policies"
P3A_ENUMS="20261008090000_p3a_identity_enum_values"
P3A="20261008090100_p3a_trust_claims"
M6="20261009090000_m6_acquisition_connections"
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

deploy_upto() {  # deploy_upto <last-migration-name> [<migration that fails on its last statement>]
  local TMP; TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
  cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
  cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
  for d in "$ROOT"/prisma/migrations/*/; do
    local name; name="$(basename "$d")"
    [[ "$name" > "$1" ]] && continue
    cp -r "$d" "$TMP/prisma/migrations/$name"
  done
  if [ -n "${2:-}" ]; then
    printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$TMP/prisma/migrations/$2/migration.sql"
  fi
  set +e
  ( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) > "$TMP/deploy.log" 2>&1
  local rc=$?
  set -e
  grep -E "Applying migration|have been successfully applied|Error|error" "$TMP/deploy.log" | head -8
  rm -rf "$TMP"
  return $rc
}

deploy_upto "$BASELINE" >/dev/null || { echo "baseline deploy (168) failed"; exit 1; }

case "$MODE" in
  --joint)      deploy_upto "$M6" || { echo "joint deploy failed"; exit 1; } ;;
  --with-p3a)   deploy_upto "$P3A" || { echo "P3-A deploy failed"; exit 1; } ;;
  --broken-p3a) if deploy_upto "$M6" "$P3A"; then echo "broken P3-A did NOT fail"; exit 1; fi
                echo "LAB READY: $DB (joint deploy FAILED at P3-A #2 as intended)"; exit 0 ;;
esac
echo "LAB READY: $DB (${MODE:-168 applied; P3-A pair + M6 pending})"
