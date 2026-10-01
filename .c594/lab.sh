#!/usr/bin/env bash
# PR #594 / migration 20261003090000_control_plane_production_privileges —
# Production-topology PostgreSQL lab (ephemeral PG15+).
#
#   .c594/lab.sh <db-name> [--without-594 | --broken-594]
#
# Production's migration ledger is BASELINED (the repository's early history
# does not replay from an empty database), so release-migrate only ever applies
# PENDING migrations. This lab reproduces exactly that situation:
#   1. roles with Production's attributes: a NON-superuser owner `lab_owner`
#      (CREATEROLE + BYPASSRLS — the shape of Neon's neondb_owner), the tenant
#      runtime as NOLOGIN group `app_runtime` + LOGIN member `app_runtime_prod`;
#   2. the owner's DEFAULT PRIVILEGES handing app_runtime SELECT/INSERT/UPDATE/
#      DELETE on new tables and USAGE/SELECT on new sequences — the source of the
#      runtime's write privileges on the four feature/audit tables in Production
#      (preflight run 36791336257);
#   3. the schema built as lab_owner (so every table is owned by it and picks up
#      that default ACL), the REAL PW-2 migration (app_ctlplane group, FORCE RLS
#      and the three policies on BusinessFeatureAccess) applied verbatim, and the
#      platform feature catalog row the control-plane path reads;
#   4. a migration ledger marking every migration BEFORE #594 as applied, with
#      each file's real sha256 (= Production after M5);
#   5. `prisma migrate deploy` — the exact release-migrate mechanism — which
#      therefore applies ONLY #594 (skipped with --without-594; with
#      --broken-594 a copy of #594 that fails on its last statement, to prove
#      atomicity).
#
# env: PGHOST, PGPORT, SUPER (a superuser, to create roles / the database),
#      LAB_PASSWORD (optional synthetic password for the LOGIN roles).
# Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUPER="${SUPER:?SUPER (superuser) required}"
M594="20261003090000_control_plane_production_privileges"
PW_OPT="${LAB_PASSWORD:+PASSWORD '${LAB_PASSWORD}'}"
psql_s() { psql -X -v ON_ERROR_STOP=1 -q -U "$SUPER" "$@"; }

psql_s -d postgres <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lab_owner') THEN
    CREATE ROLE lab_owner LOGIN NOSUPERUSER CREATEROLE CREATEDB BYPASSRLS ${PW_OPT};
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime_prod') THEN
    CREATE ROLE app_runtime_prod LOGIN NOSUPERUSER NOBYPASSRLS INHERIT ${PW_OPT} IN ROLE app_runtime;
  END IF;
END \$\$;
GRANT app_runtime TO lab_owner WITH ADMIN OPTION;
SQL
psql_s -d postgres -c "DROP DATABASE IF EXISTS \"$DB\"" -c "CREATE DATABASE \"$DB\" OWNER lab_owner"

OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
po() { psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" "$@"; }
po -c "GRANT USAGE ON SCHEMA public TO app_runtime" \
   -c "ALTER DEFAULT PRIVILEGES FOR ROLE lab_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime" \
   -c "ALTER DEFAULT PRIVILEGES FOR ROLE lab_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_runtime"

( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma db push --skip-generate >/dev/null )
po -f "$ROOT/prisma/migrations/20260901090000_d2_pw2_business_feature_access_rls/migration.sql"
# The feature catalog, seeded by the same INSERT statements Production ran.
for f in 20260528120000_platform_feature_access_foundation 20260930090000_knowledge_derive_authority; do
  awk 'toupper($0) ~ /^INSERT INTO "PLATFORMFEATURE(DEFINITION|POLICY)"/{p=1} p{print} p && /;[[:space:]]*$/{p=0}'     "$ROOT/prisma/migrations/$f/migration.sql" | po
done

# Baselined ledger: every migration before #594, with its real checksum.
po -c 'CREATE TABLE IF NOT EXISTS "_prisma_migrations" (id varchar(36) PRIMARY KEY, checksum varchar(64) NOT NULL, finished_at timestamptz, migration_name varchar(255) NOT NULL, logs text, rolled_back_at timestamptz, started_at timestamptz NOT NULL DEFAULT now(), applied_steps_count integer NOT NULL DEFAULT 0)'
LEDGER="$(mktemp)"
for d in "$ROOT"/prisma/migrations/*/; do
  name="$(basename "$d")"
  [ "$name" \> "$M594" ] || [ "$name" = "$M594" ] && continue
  sum="$(sha256sum "$d/migration.sql" | cut -d' ' -f1)"
  echo "INSERT INTO \"_prisma_migrations\" (id, checksum, finished_at, migration_name, applied_steps_count) VALUES (gen_random_uuid()::text, '$sum', now(), '$name', 1);" >> "$LEDGER"
done
po -f "$LEDGER"; rm -f "$LEDGER"

if [ "$MODE" != "--without-594" ]; then
  TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
  cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
  cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
  for d in "$ROOT"/prisma/migrations/*/; do cp -r "$d" "$TMP/prisma/migrations/$(basename "$d")"; done
  if [ "$MODE" = "--broken-594" ]; then
    printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$TMP/prisma/migrations/$M594/migration.sql"
  fi
  set +e
  ( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) > "$TMP/deploy.log" 2>&1
  rc=$?
  set -e
  grep -E "Applying migration|have been successfully applied|Error|error" "$TMP/deploy.log" | head -5
  rm -rf "$TMP"
  if [ "$MODE" = "--broken-594" ]; then
    [ $rc -ne 0 ] || { echo "broken #594 did NOT fail"; exit 1; }
    echo "LAB READY: $DB (#594 deploy FAILED as intended, rc=$rc)"; exit 0
  fi
  [ $rc -eq 0 ] || { echo "migrate deploy failed (rc=$rc)"; exit 1; }
fi
echo "LAB READY: $DB (${MODE:-#594 applied by prisma migrate deploy})"
