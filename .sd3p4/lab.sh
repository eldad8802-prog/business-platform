#!/usr/bin/env bash
# Service Desk P4 audit journal / migration 20261122090000_service_desk_audit_journal — Production-topology lab.
#
#   .sd3p4/lab.sh <db-name>                 the 1.3-0 lab (.sd3/lab.sh --with-sd3): 20261122090000 pending, not applied
#                                          every migration sorting between 1.3-0 and P4 (today 20261121090000
#                                          business_documents_po_sheets, which needs the business documents objects
#                                          the base lab only records) is completed in the ledger with its real sha256,
#                                          like the earlier ones — so the pending set is exactly P4
#   .sd3p4/lab.sh <db-name> --deploy-only   on that lab, `prisma migrate deploy` — the release-migrate mechanism — applies
#                                          exactly 20261122090000
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
P4="20261122090000_service_desk_audit_journal"
SD3="20261120090000_service_desk_ui_foundation"
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"

[ -f "$ROOT/prisma/migrations/$P4/migration.sql" ] || { echo "missing prisma/migrations/$P4"; exit 1; }

if [ "$MODE" != "--deploy-only" ]; then
  bash "$ROOT/.sd3/lab.sh" "$DB" --with-sd3 >/dev/null
  LEDGER="$(mktemp)"
  for d in "$ROOT"/prisma/migrations/*/; do
    name="$(basename "$d")"
    [[ "$name" > "$SD3" ]] || continue
    [[ "$name" < "$P4" ]] || continue
    sum="$(sha256sum "$d/migration.sql" | cut -d" " -f1)"
    echo "INSERT INTO \"_prisma_migrations\" (id, checksum, finished_at, migration_name, applied_steps_count)
          SELECT gen_random_uuid()::text, '$sum', now(), '$name', 1
          WHERE NOT EXISTS (SELECT 1 FROM \"_prisma_migrations\" WHERE migration_name = '$name');" >> "$LEDGER"
  done
  [ -s "$LEDGER" ] && PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" -f "$LEDGER"; rm -f "$LEDGER"
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
