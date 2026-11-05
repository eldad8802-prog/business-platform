#!/usr/bin/env bash
# Leads L1.5-a · emergency switch / migration 20261113090000_platform_feature_emergency_switch — Production-topology lab.
#
#   .pfe/lab.sh <db-name> [--with-pfe | --broken-pfe]
#
# The acquisition objects as Production has them, from their REAL migrations (the m6-acquisition-ci recipe): roles as in
# Production (app_runtime NOSUPERUSER NOBYPASSRLS; app_auth / app_ctlplane / app_admin), the schema without M6 / M7-A
# (db push of the stripped schema), then the M6, M7-A and M7-B/C migrations verbatim, and their row-level security
# replayed. A Prisma ledger lists EVERY other migration of this checkout as finished (real sha256) — including ones that
# sort AFTER this one and are already applied in Production (20261112090000_service_desk_foundation) — so
# Production's pending set is mirrored: only this migration.
#   (no mode)      pending — nothing of this migration exists;
#   --with-pfe:    `prisma migrate deploy` — the release-migrate mechanism — applies exactly this one;
#   --broken-pfe:  the same with it failing on its last statement (atomicity).
#
# env: PGHOST, PGPORT, SUPER, PGPASSWORD (the superuser's), LAB_PASSWORD. Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LRP="20261113090000_platform_feature_emergency_switch"
CTL="20261003090000_control_plane_production_privileges"
M6="20261009090000_m6_acquisition_connections"
M7A="20261013090000_m7a_commerce_telephony_foundation"
M7BC="20261014090000_m7bc_commerce_demand_and_line_labels"
BASE="postgresql://${SUPER}:${PGPASSWORD}@${PGHOST}:${PGPORT}"
OWNER_URL="$BASE/$DB"
q() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$@"; }

# Roles (cluster-wide, once).
q "$BASE/postgres" <<SQL
DO \$r\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime LOGIN PASSWORD '${LAB_PASSWORD}' NOSUPERUSER NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_auth') THEN CREATE ROLE app_auth NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_ctlplane') THEN CREATE ROLE app_ctlplane NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin') THEN CREATE ROLE app_admin NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
  -- A login that was never given EXECUTE on the resolvers (the boundary check).
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lrp_outsider') THEN
    CREATE ROLE lrp_outsider LOGIN PASSWORD '${LAB_PASSWORD}' NOSUPERUSER NOBYPASSRLS; END IF;
  -- The environment-specific control-plane LOGIN (Production: provisioned by scripts/ops/control-plane-login.ts).
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pfe_ctl') THEN
    CREATE ROLE pfe_ctl LOGIN PASSWORD '${LAB_PASSWORD}' NOSUPERUSER NOBYPASSRLS IN ROLE app_ctlplane; END IF;
END \$r\$;
SQL
q "$BASE/postgres" -c "CREATE DATABASE \"$DB\""

# The schema without M6 / M7-A, then the REAL acquisition migrations and their row-level security.
node "$ROOT/.m7a/strip-schema.mjs" "$ROOT/prisma/schema.prisma" "/tmp/lrp-base-$DB.prisma"
( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma db push --schema "/tmp/lrp-base-$DB.prisma" --skip-generate ) > /dev/null
q "$OWNER_URL" -c "GRANT USAGE ON SCHEMA public TO app_runtime" \
  -c "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime" \
  -c "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime"
q "$OWNER_URL" -f "$ROOT/prisma/migrations/$M6/migration.sql"
q "$OWNER_URL" -f "$ROOT/.m7a/prereq.sql"
q "$OWNER_URL" -f "$ROOT/prisma/migrations/$M7A/migration.sql"
q "$OWNER_URL" -f "$ROOT/.m7bc/prereq.sql"
q "$OWNER_URL" -1 -f "$ROOT/prisma/migrations/$M7BC/migration.sql"
node "$ROOT/.m6/replay-rls.mjs" "$OWNER_URL" "$M6" "$M7A" "$M7BC" > /dev/null
# The control-plane privileges exactly as Production has them (app_ctlplane SELECT-only on the policy table; the
# runtime's inherited writes revoked).
q "$OWNER_URL" -f "$ROOT/prisma/migrations/$CTL/migration.sql"

# Nothing of this migration may pre-exist (asserted, not assumed).
q "$OWNER_URL" <<'SQL'
DO $c$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'platform_set_feature_emergency') THEN
    RAISE EXCEPTION 'lab: the switch function exists before the migration';
  END IF;
END $c$;
SQL

# Production's ledger: every OTHER migration of this checkout, finished, real checksum — this one applies OUT OF ORDER
# after a later-named migration that is already applied, exactly as release-migrate will apply it.
LEDGER="$(mktemp)"
cat > "$LEDGER" <<'SQL'
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  "id" VARCHAR(36) PRIMARY KEY NOT NULL, "checksum" VARCHAR(64) NOT NULL, "finished_at" TIMESTAMPTZ,
  "migration_name" VARCHAR(255) NOT NULL, "logs" TEXT, "rolled_back_at" TIMESTAMPTZ,
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(), "applied_steps_count" INTEGER NOT NULL DEFAULT 0);
SQL
for d in "$ROOT"/prisma/migrations/*/; do
  name="$(basename "$d")"
  [[ "$name" == "$LRP" ]] && continue
  sum="$(sha256sum "$d/migration.sql" | cut -d' ' -f1)"
  echo "INSERT INTO \"_prisma_migrations\" (id, checksum, finished_at, migration_name, applied_steps_count)
        VALUES (gen_random_uuid()::text, '$sum', now(), '$name', 1);" >> "$LEDGER"
done
q "$OWNER_URL" -f "$LEDGER"; rm -f "$LEDGER"

case "$MODE" in
  --with-pfe|--broken-pfe) ;;
  *) echo "LAB READY: $DB (ledger = every other migration; the emergency switch function pending)"; exit 0 ;;
esac

TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
for d in "$ROOT"/prisma/migrations/*/; do cp -r "$d" "$TMP/prisma/migrations/$(basename "$d")"; done
if [ "$MODE" = "--broken-pfe" ]; then
  printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$TMP/prisma/migrations/$LRP/migration.sql"
fi
set +e
( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) > "$TMP/deploy.log" 2>&1
rc=$?
set -e
grep -E "migrations found|Applying migration|have been successfully applied|No pending|Error|error" "$TMP/deploy.log" | head -8
rm -rf "$TMP"
if [ "$MODE" = "--broken-pfe" ]; then
  [ $rc -ne 0 ] || { echo "broken migration did NOT fail"; exit 1; }
  echo "LAB READY: $DB (the switch function FAILED on the last statement as intended)"; exit 0
fi
[ $rc -eq 0 ] || { echo "deploy of $LRP failed"; exit 1; }
echo "LAB READY: $DB ($LRP applied)"
