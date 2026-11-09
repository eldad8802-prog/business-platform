#!/usr/bin/env bash
# Service Desk P4 audit journal / migration 20261122090000_service_desk_audit_journal — Production-topology lab.
#
#   .sd3p4/lab.sh <db-name>                 the 1.3-0 lab (.sd3/lab.sh --with-sd3): 20261122090000 pending, not applied
#   .sd3p4/lab.sh <db-name> --deploy-only   on that lab, `prisma migrate deploy` — the release-migrate mechanism — applies
#                                          exactly 20261122090000
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
P4="20261122090000_service_desk_audit_journal"
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"

[ -f "$ROOT/prisma/migrations/$P4/migration.sql" ] || { echo "missing prisma/migrations/$P4"; exit 1; }

if [ "$MODE" != "--deploy-only" ]; then
  bash "$ROOT/.sd3/lab.sh" "$DB" --with-sd3 >/dev/null
  pending="$(psql -X -At "$OWNER_URL" -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '$P4'")"
  [ "$pending" = "0" ] || { echo "$P4 is already recorded"; exit 1; }
  echo "LAB READY: $DB (1.3-0 applied; $P4 pending)"
  exit 0
fi

( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy ) | tee /tmp/sd3p4-deploy.log
grep -q "Applying migration \`$P4\`" /tmp/sd3p4-deploy.log || { echo "$P4 was not applied"; exit 1; }
test "$(grep -c 'Applying migration' /tmp/sd3p4-deploy.log)" = "1" || { echo "more than one migration was applied"; exit 1; }
test "$(psql -X -At "$OWNER_URL" -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL")" = "0"
echo "LAB READY: $DB ($P4 applied)"
