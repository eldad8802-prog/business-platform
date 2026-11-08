#!/usr/bin/env bash
# Service Desk 1.3-0 / PR-1 / migration 20261120090000_service_desk_ui_foundation — Production-topology lab.
#
#   .sd3/lab.sh <db-name> [--with-sd3 | --broken-sd3 | --deploy-only | --broken-deploy-only]
#
# Builds the M2 lab with 20261115090000_service_parts APPLIED (.sdp/lab.sh <db> --with-m2): 1.2a, 1.2b and M2 applied,
# the inventory RLS as Production. That is the database 1.3-0 is released onto — both M2 and the business documents
# migration 20261114090000 sort before it and must be released first (the .sdp lab records 20261114 in the ledger; it
# is not this track's). The ledger is completed with every migration of this checkout that sorts between M2 and 1.3-0.
#   (no mode)      the pre-migration lab: 1.3-0 pending, not applied;
#   --with-sd3:    `prisma migrate deploy` — the release-migrate mechanism — applies exactly 1.3-0;
#   --broken-sd3:  the same with 1.3-0 failing on its last statement (atomicity: nothing of it may remain);
#   --deploy-only / --broken-deploy-only: on a lab already built (rollback proof), only the deploy.
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
M2="20261115090000_service_parts"
SD3="20261120090000_service_desk_ui_foundation"
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
psql_owner() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" "$@"; }

[ -f "$ROOT/prisma/migrations/$SD3/migration.sql" ] || { echo "missing prisma/migrations/$SD3"; exit 1; }

if [ "$MODE" != "--deploy-only" ] && [ "$MODE" != "--broken-deploy-only" ]; then
bash "$ROOT/.sdp/lab.sh" "$DB" --with-m2 >/dev/null
LEDGER="$(mktemp)"
for d in "$ROOT"/prisma/migrations/*/; do
  name="$(basename "$d")"
  [[ "$name" > "$M2" ]] || continue
  [[ "$name" < "$SD3" ]] || continue
  sum="$(sha256sum "$d/migration.sql" | cut -d' ' -f1)"
  echo "INSERT INTO \"_prisma_migrations\" (id, checksum, finished_at, migration_name, applied_steps_count)
        SELECT gen_random_uuid()::text, '$sum', now(), '$name', 1
        WHERE NOT EXISTS (SELECT 1 FROM \"_prisma_migrations\" WHERE migration_name = '$name');" >> "$LEDGER"
done
[ -s "$LEDGER" ] && psql_owner -f "$LEDGER"; rm -f "$LEDGER"
fi

case "$MODE" in
  --with-sd3|--broken-sd3|--deploy-only|--broken-deploy-only) ;;
  "") echo "LAB READY: $DB (1.2a + 1.2b + M2 applied; ledger = every migration before 1.3-0; 1.3-0 pending)"; exit 0 ;;
  *) echo "unknown mode $MODE"; exit 2 ;;
esac

TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
for d in "$ROOT"/prisma/migrations/*/; do [[ "$(basename "$d")" > "$SD3" ]] && continue; cp -r "$d" "$TMP/prisma/migrations/$(basename "$d")"; done
if [ "$MODE" = "--broken-sd3" ] || [ "$MODE" = "--broken-deploy-only" ]; then
  printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$TMP/prisma/migrations/$SD3/migration.sql"
fi
set +e
( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) > "$TMP/deploy.log" 2>&1
rc=$?
set -e
grep -E "migrations found|Applying migration|have been successfully applied|No pending|Error|error|ERROR" "$TMP/deploy.log" | head -12
rm -rf "$TMP"
if [ "$MODE" = "--broken-sd3" ] || [ "$MODE" = "--broken-deploy-only" ]; then
  [ $rc -ne 0 ] || { echo "broken migration did NOT fail"; exit 1; }
  echo "LAB READY: $DB (service desk UI foundation FAILED on its last statement as intended)"; exit 0
fi
[ $rc -eq 0 ] || { echo "service desk UI foundation deploy failed"; exit 1; }
echo "LAB READY: $DB (service desk UI foundation applied)"
