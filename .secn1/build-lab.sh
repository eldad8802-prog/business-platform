#!/usr/bin/env bash
# SEC N-1 lab — a FRESH database built by `prisma migrate deploy` (never db push),
# with the Production role shape, and the N-1 migration applied LAST onto tables
# that already hold rows (Production does).
#
# Usage: ADMIN_URL=postgresql://owner@host:port/postgres LAB_DB=<name> bash .secn1/build-lab.sh
#   Optional: N1_TEMPLATE=<db>  — stage 1 (every migration before N-1, plus the seeded
#             rows) is built once into this database and later labs are cloned from it
#             (CREATE DATABASE ... TEMPLATE). The N-1 migration itself is ALWAYS applied
#             fresh from the working tree by `prisma migrate deploy`.
#             STOP_BEFORE_N1=1 builds only stage 1 (used to make that template).
#
# Roles, as in Production: NOLOGIN NOBYPASSRLS groups, a LOGIN NOSUPERUSER
# NOBYPASSRLS runtime member (app_runtime_prod), and ALTER DEFAULT PRIVILEGES
# handing app_runtime a,r,w,d on every new table — the privilege shape that made
# the five P0 tables readable across tenants in the first place.
#
# 20260210120000_billing_invoice_profile_fields is back-dated before the init that
# creates "BusinessProfile" (known baseline debt). It is idempotent, so the lab
# marks it applied, deploys every other migration in order, then executes its SQL.
set -euo pipefail
: "${ADMIN_URL:?ADMIN_URL is required}"
: "${LAB_DB:?LAB_DB is required}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
N1=20260928100000_sec_n1_p0_evidence_tenant_rls
BACKDATED=20260210120000_billing_invoice_profile_fields
MIGRATION_SRC="$ROOT/prisma/migrations/$N1/migration.sql"
export PRISMA_HIDE_UPDATE_MESSAGE=1
RUNTIME_PW="${N1_RUNTIME_PW:-n1_lab_synthetic_runtime_pw}"
PSQL="${PSQL:-psql}"

base="${ADMIN_URL%/*}"
OWNER_URL="$base/$LAB_DB"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

"$PSQL" "$ADMIN_URL" -v ON_ERROR_STOP=1 -q <<SQL
DROP DATABASE IF EXISTS "$LAB_DB" WITH (FORCE);
DO \$\$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['app_runtime','app_auth','app_admin','app_control_plane','app_erasure','app_reader'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOBYPASSRLS', r);
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime_prod') THEN
    CREATE ROLE app_runtime_prod LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '$RUNTIME_PW';
  END IF;
END \$\$;
GRANT app_runtime TO app_runtime_prod;
SQL

CLONED=0
if [ -n "${N1_TEMPLATE:-}" ] && [ "${STOP_BEFORE_N1:-0}" != "1" ] &&    [ "$("$PSQL" "$ADMIN_URL" -At -c "SELECT 1 FROM pg_database WHERE datname = '$N1_TEMPLATE'")" = "1" ]; then
  "$PSQL" "$ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE \"$LAB_DB\" TEMPLATE \"$N1_TEMPLATE\""
  CLONED=1
else
  "$PSQL" "$ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE \"$LAB_DB\""
fi

# Stage 1 tree: every migration EXCEPT N-1.
mkdir -p "$WORK/prisma/migrations"
cp "$ROOT/prisma/schema.prisma" "$WORK/prisma/schema.prisma"
cp "$ROOT/prisma/migrations/migration_lock.toml" "$WORK/prisma/migrations/" 2>/dev/null || true
for d in "$ROOT"/prisma/migrations/*/; do
  name="$(basename "$d")"
  [ "$name" = "$N1" ] && continue
  cp -r "$d" "$WORK/prisma/migrations/$name"
done
export DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL"

if [ "$CLONED" = "0" ]; then
# Default privileges exactly as Production carries them: a,r,w,d to app_runtime.
"$PSQL" "$OWNER_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
SQL

( cd "$ROOT" && npx prisma migrate resolve --schema "$WORK/prisma/schema.prisma" --applied "$BACKDATED" >/dev/null )
( cd "$ROOT" && npx prisma migrate deploy --schema "$WORK/prisma/schema.prisma" >/dev/null )
"$PSQL" "$OWNER_URL" -v ON_ERROR_STOP=1 -q -f "$ROOT/prisma/migrations/$BACKDATED/migration.sql"

# Sequence USAGE for every table EXCEPT the five N-1 tables: stands in for the
# out-of-band wave grants (scripts/security/d2-p7-wave*-grants.sql) that the real
# writers' other tables (InventoryMovement, ...) rely on. The N-1 sequences are
# left to the migration, so a missing sequence grant there shows up as a failure.
"$PSQL" "$OWNER_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE s record;
BEGIN
  FOR s IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'S'
             AND c.relname NOT IN ('InventorySale_id_seq','InventorySaleLine_id_seq','InventorySourceSaleLine_id_seq','BusinessAsset_id_seq','CouponSurfaceEvent_id_seq')
  LOOP
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO app_runtime', s.relname);
  END LOOP;
END $$;
SQL

# Pre-existing rows in all five tables, for two tenants, before N-1 lands.
"$PSQL" "$OWNER_URL" -v ON_ERROR_STOP=1 -q -f "$ROOT/.secn1/seed-existing.sql"
fi
if [ "${STOP_BEFORE_N1:-0}" = "1" ]; then
  echo "STAGE 1 BUILT: $LAB_DB (every migration before N-1, seeded)"
  exit 0
fi

# Stage 2: N-1 on top of populated tables.
mkdir -p "$WORK/prisma/migrations/$N1"
cp "$MIGRATION_SRC" "$WORK/prisma/migrations/$N1/migration.sql"
( cd "$ROOT" && npx prisma migrate deploy --schema "$WORK/prisma/schema.prisma" >/dev/null )
( cd "$ROOT" && npx prisma migrate status --schema "$WORK/prisma/schema.prisma" >/dev/null )
echo "LAB BUILT: $LAB_DB (all migrations via migrate deploy; N-1 applied onto populated tables)"
