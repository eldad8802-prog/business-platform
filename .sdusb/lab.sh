#!/usr/bin/env bash
# Service Desk / migration 20261124090000_service_user_same_business_fix — Production-topology lab.
#
#   .sdusb/lab.sh <db>                        the P4 lab (.sd3p4/lab.sh <db> + --deploy-only) = the Service Desk state
#                                             Production has today (20261112 … 20261122); THIS migration pending
#   .sdusb/lab.sh <db> --deploy-only          on that lab, `prisma migrate deploy` — the release-migrate mechanism —
#                                             applies exactly 20261124090000
#   .sdusb/lab.sh <db> --broken-deploy-only   the same with it failing on its last statement (atomicity)
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
USB="20261124090000_service_user_same_business_fix"
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
q() { psql -X -At "$OWNER_URL" -c "$1" | tr -d '\r'; }

[ -f "$ROOT/prisma/migrations/$USB/migration.sql" ] || { echo "missing prisma/migrations/$USB"; exit 1; }

stage() { # <dir> <fault?>: every migration the ledger holds as finished + this one
  local T="$1" fault="$2" n
  mkdir -p "$T/prisma/migrations"
  cp "$ROOT/prisma/schema.prisma" "$T/prisma/schema.prisma"
  cp "$ROOT/prisma/migrations/migration_lock.toml" "$T/prisma/migrations/"
  while read -r n; do
    [ -n "$n" ] || continue
    cp -r "$ROOT/prisma/migrations/$n" "$T/prisma/migrations/$n"
  done < <(q "SELECT migration_name FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")
  rm -rf "$T/prisma/migrations/$USB"; cp -r "$ROOT/prisma/migrations/$USB" "$T/prisma/migrations/$USB"
  if [ "$fault" = fault ]; then printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$T/prisma/migrations/$USB/migration.sql"; fi
}
deploy() { # <dir>
  ( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node node_modules/prisma/build/index.js migrate deploy --schema "$1/prisma/schema.prisma" ) 2>&1 </dev/null
}

if [ "$MODE" = "" ]; then
  bash "$ROOT/.sd3p4/lab.sh" "$DB" >/dev/null
  bash "$ROOT/.sd3p4/lab.sh" "$DB" --deploy-only >/dev/null
  [ "$(q "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '$USB'")" = "0" ] || { echo "$USB is already recorded"; exit 1; }
  echo "LAB READY: $DB (Production's Service Desk state through 20261122090000; $USB pending)"
  exit 0
fi

case "$MODE" in
  --deploy-only) FAULT=no ;;
  --broken-deploy-only) FAULT=fault ;;
  *) echo "unknown mode $MODE"; exit 2 ;;
esac
T="$(mktemp -d)"; stage "$T" "$FAULT"; set +e; OUT="$(deploy "$T")"; rc=$?; set -e; rm -rf "$T"
echo "$OUT" | grep -E "Applying migration|have been successfully applied|No pending|Error|error|ERROR" | head -8
if [ "$FAULT" = fault ]; then
  [ $rc -ne 0 ] || { echo "the broken migration did NOT fail"; exit 1; }
  echo "LAB READY: $DB ($USB FAILED on its last statement as intended)"; exit 0
fi
[ $rc -eq 0 ] || { echo "$USB deploy failed"; exit 1; }
test "$(echo "$OUT" | grep -c 'Applying migration')" = "1" || { echo "more than one migration was applied"; exit 1; }
echo "$OUT" | grep -q "Applying migration \`$USB\`" || { echo "$USB was not applied"; exit 1; }
echo "LAB READY: $DB ($USB applied)"
