#!/usr/bin/env bash
# S1-A / migration 20261104090000_pos_rivhit_source — Production-topology lab.
#
#   .s1a/lab.sh <db-name>                 build the lab, the migration pending
#   .s1a/lab.sh <db-name> --with-s1a      build it and apply the migration with `prisma migrate deploy`
#   .s1a/lab.sh <db-name> --broken-s1a    build it and apply the migration failing on its last statement
#   .s1a/lab.sh <db-name> --apply         apply the migration to a lab built earlier (pending)
#
# Builds on the revenue truth lab (.rev/lab.sh <db> --with-rev: non-superuser CREATEROLE/BYPASSRLS owner, NOLOGIN
# app_runtime + LOGIN app_runtime_prod, the revenue truth tables exactly as their migration made them), then
#   1. .s1a/prereq.sql: the four CHECKs this migration replaces, exactly as M7-A left them in Production;
#   2. Production's ledger: every migration of this checkout that sorts BEFORE this one, recorded and finished with
#      its real sha256 — so `migrate deploy` applies exactly this one.
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
S1A="20261104090000_pos_rivhit_source"
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
psql_owner() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" "$@"; }

if [ "$MODE" != "--apply" ]; then
  bash "$ROOT/.rev/lab.sh" "$DB" --with-rev >/dev/null
  psql_owner -f "$ROOT/.s1a/prereq.sql"
  LEDGER="$(mktemp)"
  for d in "$ROOT"/prisma/migrations/*/; do
    name="$(basename "$d")"
    [[ "$name" =~ ^[0-9]{14}_ ]] || continue
    [[ "$name" < "$S1A" ]] || continue
    sum="$(sha256sum "$d/migration.sql" | cut -d' ' -f1)"
    echo "INSERT INTO \"_prisma_migrations\" (id, checksum, finished_at, migration_name, applied_steps_count)
          SELECT gen_random_uuid()::text, '$sum', now(), '$name', 1
          WHERE NOT EXISTS (SELECT 1 FROM \"_prisma_migrations\" WHERE migration_name = '$name');" >> "$LEDGER"
  done
  psql_owner -f "$LEDGER"; rm -f "$LEDGER"
fi

case "$MODE" in
  --with-s1a|--broken-s1a|--apply) ;;
  "") echo "LAB READY: $DB (ledger = every migration before S1-A, as Production's; S1-A pending)"; exit 0 ;;
  *) echo "unknown mode $MODE" >&2; exit 2 ;;
esac

TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
for name in $(psql_owner -Atc "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL"); do
  cp -r "$ROOT/prisma/migrations/$name" "$TMP/prisma/migrations/$name"
done
cp -r "$ROOT/prisma/migrations/$S1A" "$TMP/prisma/migrations/$S1A"
if [ "$MODE" = "--broken-s1a" ]; then
  printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$TMP/prisma/migrations/$S1A/migration.sql"
fi
set +e
( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) > "$TMP/deploy.log" 2>&1
rc=$?
set -e
grep -E "Applying migration|have been successfully applied|Error|error" "$TMP/deploy.log" | head -8
rm -rf "$TMP"
if [ "$MODE" = "--broken-s1a" ]; then
  [ $rc -ne 0 ] || { echo "broken migration did NOT fail"; exit 1; }
  echo "LAB READY: $DB (S1-A FAILED on its last statement as intended)"; exit 0
fi
[ $rc -eq 0 ] || { echo "S1-A deploy failed"; exit 1; }
echo "LAB READY: $DB (S1-A applied)"
