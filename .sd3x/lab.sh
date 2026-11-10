#!/usr/bin/env bash
# Service Desk 1.3-0 erasure texts / migration 20261121090000_service_desk_ui_erasure_text — Production-topology lab.
#
#   .sd3x/lab.sh <db-name>                 the 1.3-0 lab (.sd3/lab.sh --with-sd3): 20261121090000 pending, not applied
#   .sd3x/lab.sh <db-name> --deploy-only   on that lab, `prisma migrate deploy` — the release-migrate mechanism — applies
#                                          exactly 20261121090000
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SD3X="20261121090000_service_desk_ui_erasure_text"
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"

[ -f "$ROOT/prisma/migrations/$SD3X/migration.sql" ] || { echo "missing prisma/migrations/$SD3X"; exit 1; }

if [ "$MODE" != "--deploy-only" ]; then
  bash "$ROOT/.sd3/lab.sh" "$DB" --with-sd3 >/dev/null
  pending="$(psql -X -At "$OWNER_URL" -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '$SD3X'")"
  [ "$pending" = "0" ] || { echo "$SD3X is already recorded"; exit 1; }
  echo "LAB READY: $DB (1.3-0 applied; $SD3X pending)"
  exit 0
fi

( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy ) | tee /tmp/sd3x-deploy.log
grep -q "Applying migration \`$SD3X\`" /tmp/sd3x-deploy.log || { echo "$SD3X was not applied"; exit 1; }
test "$(grep -c 'Applying migration' /tmp/sd3x-deploy.log)" = "1" || { echo "more than one migration was applied"; exit 1; }
test "$(psql -X -At "$OWNER_URL" -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL")" = "0"
echo "LAB READY: $DB ($SD3X applied)"
