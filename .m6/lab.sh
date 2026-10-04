#!/usr/bin/env bash
# M6 / migration 20261009090000_m6_acquisition_connections — Production-topology lab.
#
#   .m6/lab.sh <db-name> [--with-m6 | --broken-m6]
#
# Production before M6: every migration that sorts before M6 applied, M6 pending. This lab is that:
#   1. .c594/lab.sh <db> — non-superuser CREATEROLE/BYPASSRLS owner, NOLOGIN app_runtime + LOGIN
#      app_runtime_prod, the owner's DEFAULT PRIVILEGES, baselined ledger, #594 by migrate deploy;
#   2. app_auth / app_ctlplane exist (B4 refuses without app_auth), the real D2 E4 narrowing;
#   3. every migration between #594 and M6 recorded applied (real checksums) and B4 applied verbatim;
#   4. --with-m6: `prisma migrate deploy` again, up to and including M6 — the release-migrate
#      mechanism, which therefore applies exactly M6. --broken-m6: a copy that fails at its end.
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
M6="20261009090000_m6_acquisition_connections"
bash "$ROOT/.c594/lab.sh" "$DB" >/dev/null
psql -X -v ON_ERROR_STOP=1 -q -U "$SUPER" -d postgres -c \
  "DO \$\$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_auth') THEN CREATE ROLE app_auth NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_ctlplane') THEN CREATE ROLE app_ctlplane NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
   END \$\$"
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" -f "$ROOT/prisma/migrations/20260908180000_d2_user_business_privilege_narrowing/migration.sql"

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
  grep -E "Applying migration|have been successfully applied|Error|error" "$TMP/deploy.log" | head -6
  if [ $rc -ne 0 ] && [ "${2:-}" != "broken" ]; then echo "--- migrate deploy log (rc=$rc) ---" >&2; tail -40 "$TMP/deploy.log" >&2; fi
  rm -rf "$TMP"
  return $rc
}

# Every migration between #594 and M6 is APPLIED in Production. The pushed schema (main's
# schema.prisma) already holds their tables and types, so replaying them would collide; instead the
# ledger records each with its real checksum, exactly as Production's ledger does, and the one whose
# effect is not a Prisma object and touches what M6 builds on — B4's FORCE RLS on Business — is
# applied verbatim. M6 itself then goes through `prisma migrate deploy` alone.
M594="20261003090000_control_plane_production_privileges"
B4="20261006090000_business_tenant_write_rls"
for d in "$ROOT"/prisma/migrations/*/; do
  name="$(basename "$d")"
  [[ "$name" =~ ^[0-9]{14}_ ]] || continue
  [[ "$name" > "$M594" && "$name" < "$M6" ]] || continue
  if [ "$name" = "$B4" ]; then psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" -f "$d/migration.sql"; fi
  sum="$(sha256sum "$d/migration.sql" | cut -d" " -f1)"
  psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" -c "INSERT INTO \"_prisma_migrations\" (id, checksum, finished_at, migration_name, applied_steps_count) VALUES (gen_random_uuid()::text, '$sum', now(), '$name', 1)"
done

case "$MODE" in
  --with-m6)   deploy_upto "$M6" || { echo "M6 deploy failed"; exit 1; } ;;
  --broken-m6) if deploy_upto "$M6" broken; then echo "broken M6 did NOT fail"; exit 1; fi
               echo "LAB READY: $DB (M6 deploy FAILED as intended)"; exit 0 ;;
esac
echo "LAB READY: $DB (${MODE:-every migration before M6 applied, M6 pending})"
