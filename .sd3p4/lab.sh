#!/usr/bin/env bash
# Service Desk P4 audit journal / migration 20261122090000_service_desk_audit_journal — Production-topology lab.
#
#   .sd3p4/lab.sh <db-name>                 the 1.3-0 lab (.sd3/lab.sh --with-sd3): 20261122090000 pending, not applied
#   .sd3p4/lab.sh <db-name> --deploy-only   on that lab, `prisma migrate deploy` — the release-migrate mechanism — applies
#                                          exactly 20261122090000
#
# A migration that sorts between 1.3-0 and P4 (today 20261121090000_business_documents_po_sheets, #1030) is NEITHER
# recorded NOR applied here: the base lab does not build the business-documents objects it needs, so recording it would
# claim a structure this lab does not have. The deploy runs from a copy of prisma/migrations without those directories,
# so the pending set is exactly P4, and the lab fails if one of them is ever found in the ledger. (P4 and po_sheets share
# no object; the full sequence was proven separately on a copy of Preview and on Preview itself.)
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
P4="20261122090000_service_desk_audit_journal"
SD3="20261120090000_service_desk_ui_foundation"
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
between() { for d in "$ROOT"/prisma/migrations/*/; do n="$(basename "$d")"; [[ "$n" > "$SD3" && "$n" < "$P4" ]] && echo "$n"; done; return 0; }
not_recorded() {  # none of the in-between migrations may be in the ledger: this lab has not built their objects
  for n in $(between); do
    [ "$(psql -X -At "$OWNER_URL" -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '$n'")" = "0" ] \
      || { echo "$n is recorded in the ledger, but this lab never built its objects"; exit 1; }
  done
}

[ -f "$ROOT/prisma/migrations/$P4/migration.sql" ] || { echo "missing prisma/migrations/$P4"; exit 1; }

if [ "$MODE" != "--deploy-only" ]; then
  bash "$ROOT/.sd3/lab.sh" "$DB" --with-sd3 >/dev/null
  pending="$(psql -X -At "$OWNER_URL" -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '$P4'")"
  [ "$pending" = "0" ] || { echo "$P4 is already recorded"; exit 1; }
  not_recorded
  echo "LAB READY: $DB (1.3-0 applied; $P4 pending)"
  exit 0
fi

not_recorded
TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
SKIPPED="$(between | tr '\n' ' ')"
for d in "$ROOT"/prisma/migrations/*/; do
  n="$(basename "$d")"
  [[ "$n" > "$P4" ]] && continue
  [[ "$n" > "$SD3" && "$n" < "$P4" ]] && continue
  cp -r "$d" "$TMP/prisma/migrations/$n"
done
echo "not recorded, not applied in this lab: ${SKIPPED:-(none)}"
( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) | tee /tmp/sd3p4-deploy.log
rm -rf "$TMP"
grep -q "Applying migration \`$P4\`" /tmp/sd3p4-deploy.log || { echo "$P4 was not applied"; exit 1; }
test "$(grep -c 'Applying migration' /tmp/sd3p4-deploy.log)" = "1" || { echo "more than one migration was applied"; exit 1; }
test "$(psql -X -At "$OWNER_URL" -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL")" = "0"
not_recorded
echo "LAB READY: $DB ($P4 applied)"
