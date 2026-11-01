#!/usr/bin/env bash
# Shared security lab — a database with Production's privilege model, built from EVERY migration on this checkout.
#
#   scripts/security-lab/build-lab.sh <db-name>
#
# What makes it Production-shaped (docs/architecture/permissions-contract.md, "Roles"):
#   * the owner is a NON-superuser LOGIN role with CREATEROLE + BYPASSRLS — the shape of neondb_owner;
#   * NOLOGIN group roles app_runtime, app_auth, app_admin, app_ctlplane, task_maintenance exist BEFORE the first
#     migration, so no migration's `IF EXISTS (… pg_roles …)` branch is skipped;
#   * the owner's DEFAULT PRIVILEGES are Production's (ops/evidence/payables-runtime-grants-evidence.sql):
#     tables → app_runtime SELECT, INSERT, UPDATE, DELETE; sequences → app_runtime SELECT, USAGE;
#   * one LOGIN role per group (<group>_lab, INHERIT), the way Production's app_runtime_prod etc. are — the
#     application connects as those, never as the owner;
#   * migrations are applied by psql, one transaction each, in directory order, and recorded in _prisma_migrations
#     with their real sha256 (so `prisma migrate status` agrees). One exception, the same as every database that
#     ever replayed this chain: 20260210120000_billing_invoice_profile_fields sorts before init but alters a table
#     init creates, so it runs right after 20260330142739_core_data_layer_v1 (it is all ADD COLUMN IF NOT EXISTS).
#
# No `prisma db push`, no blanket grants: a privilege exists here only if a migration or Production's default
# privileges give it. Synthetic only. ZERO secrets. ZERO network.
#
# env: PGHOST, PGPORT, SUPER (a superuser, for CREATE ROLE / CREATE DATABASE only), PGPASSWORD for SUPER (optional),
#      LAB_PASSWORD (optional, used for every lab login role; default "lab").
set -euo pipefail
DB="${1:?usage: build-lab.sh <db-name>}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
: "${PGHOST:=localhost}" "${PGPORT:=5432}" "${SUPER:=postgres}" "${LAB_PASSWORD:=lab}"
export PGHOST PGPORT PGCLIENTENCODING=UTF8
EARLY="20260210120000_billing_invoice_profile_fields"
AFTER="20260330142739_core_data_layer_v1"

psql_super() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q -U "$SUPER" "$@"; }
OWNER_URL="postgresql://lab_owner:${LAB_PASSWORD}@${PGHOST}:${PGPORT}/${DB}"
psql_owner() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" "$@"; }

# Roles are cluster-wide: create once, reuse across lab databases.
psql_super -d postgres -v pw="$LAB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE lab_owner LOGIN NOSUPERUSER CREATEROLE BYPASSRLS PASSWORD %L', :'pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lab_owner') \gexec
SELECT format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION', g)
  FROM unnest(ARRAY['app_runtime','app_auth','app_admin','app_ctlplane','task_maintenance']) g
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = g) \gexec
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB INHERIT PASSWORD %L IN ROLE %I', g || '_lab', :'pw', g)
  FROM unnest(ARRAY['app_runtime','app_auth','app_admin','app_ctlplane']) g
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = g || '_lab') \gexec
-- The owner administers the groups (Production: neondb_owner has ADMIN on every app group, no INHERIT, no SET).
SELECT format('GRANT %I TO lab_owner WITH ADMIN TRUE, INHERIT FALSE, SET FALSE', g)
  FROM unnest(ARRAY['app_runtime','app_auth','app_admin','app_ctlplane','task_maintenance']) g \gexec
SQL

psql_super -d postgres -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" -c "CREATE DATABASE \"$DB\" OWNER lab_owner"
psql_super -d "$DB" -c "REVOKE CREATE ON SCHEMA public FROM PUBLIC" -c "ALTER SCHEMA public OWNER TO lab_owner"

psql_owner <<'SQL'
-- The ledger predates the default privileges (Prisma created it on the first deploy), so the runtime gets nothing on it.
CREATE TABLE "_prisma_migrations" (
  "id" VARCHAR(36) PRIMARY KEY, "checksum" VARCHAR(64) NOT NULL, "finished_at" TIMESTAMPTZ,
  "migration_name" VARCHAR(255) NOT NULL, "logs" TEXT, "rolled_back_at" TIMESTAMPTZ,
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(), "applied_steps_count" INTEGER NOT NULL DEFAULT 0
);
ALTER DEFAULT PRIVILEGES FOR ROLE lab_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE lab_owner IN SCHEMA public GRANT SELECT, USAGE ON SEQUENCES TO app_runtime;
SQL

# One psql session, one transaction per migration (BEGIN; \i …; ledger row; COMMIT), in order.
DRIVER="$(mktemp)"; trap 'rm -f "$DRIVER"' EXIT
add() {
  local name="$1" file="$ROOT/prisma/migrations/$1/migration.sql" sum
  sum="$(sha256sum "$file" | cut -d" " -f1)"
  command -v cygpath > /dev/null && file="$(cygpath -m "$file")"  # a native psql on Windows reads C:/… paths
  {
    echo "\\echo $name"
    echo "BEGIN;"
    echo "\\i $file"
    echo "INSERT INTO \"_prisma_migrations\" (id, checksum, finished_at, migration_name, applied_steps_count)" \
         "VALUES (gen_random_uuid()::text, '$sum', now(), '$name', 1);"
    echo "COMMIT;"
  } >> "$DRIVER"
}
n=0
for d in "$ROOT"/prisma/migrations/*/; do
  name="$(basename "$d")"
  [ "$name" = "$EARLY" ] && continue
  add "$name"; n=$((n + 1))
  if [ "$name" = "$AFTER" ]; then add "$EARLY"; n=$((n + 1)); fi
done
if ! psql_owner -f "$DRIVER" > "$DRIVER.log" 2>&1; then
  echo "MIGRATION FAILED — last started: $(grep -E '^[0-9]{14}_' "$DRIVER.log" | tail -1)"
  grep -E "ERROR" "$DRIVER.log" | tail -5; rm -f "$DRIVER.log"; exit 1
fi
rm -f "$DRIVER.log"
echo "LAB READY: $DB — $n migrations applied as lab_owner; login roles: app_runtime_lab, app_auth_lab, app_admin_lab, app_ctlplane_lab"
