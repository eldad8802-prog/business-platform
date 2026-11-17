#!/usr/bin/env bash
# Service Desk 1.3-0 erasure texts / migration 20261123090000_service_desk_ui_erasure_text — Production-topology lab.
#
#   .sd3x/lab.sh <db-name>                 the P4 lab (.sd3p4/lab.sh, then --deploy-only): 1.3-0 and the P4 audit journal
#                                          20261122090000 applied, as in Production; 20261123090000 pending, not applied
#   .sd3x/lab.sh <db-name> --deploy-only   on that lab, `prisma migrate deploy` — the release-migrate mechanism — applies
#                                          exactly 20261123090000
#
# A migration that sorts between 1.3-0 and this one and is NOT applied in the lab (today 20261121090000_business_documents
# _po_sheets: the base lab does not build the business-documents objects it needs) is neither recorded nor applied: the
# deploy runs from a copy of prisma/migrations without it, and the lab fails if it is ever found in the ledger.
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SD3="20261120090000_service_desk_ui_foundation"
P4="20261122090000_service_desk_audit_journal"
SD3X="20261123090000_service_desk_ui_erasure_text"
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
recorded() { psql -X -At "$OWNER_URL" -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '$1'"; }
# Not applied in this lab: every migration between 1.3-0 and this one, except P4 (applied by the P4 lab).
skipped() { for d in "$ROOT"/prisma/migrations/*/; do n="$(basename "$d")"; [[ "$n" > "$SD3" && "$n" < "$SD3X" && "$n" != "$P4" ]] && echo "$n"; done; return 0; }
not_recorded() {
  for n in $(skipped); do
    [ "$(recorded "$n")" = "0" ] || { echo "$n is recorded in the ledger, but this lab never built its objects"; exit 1; }
  done
}

[ -f "$ROOT/prisma/migrations/$SD3X/migration.sql" ] || { echo "missing prisma/migrations/$SD3X"; exit 1; }

if [ "$MODE" != "--deploy-only" ]; then
  bash "$ROOT/.sd3p4/lab.sh" "$DB" >/dev/null
  bash "$ROOT/.sd3p4/lab.sh" "$DB" --deploy-only >/dev/null
  [ "$(recorded "$P4")" = "1" ] || { echo "$P4 is not applied in the base lab"; exit 1; }
  [ "$(recorded "$SD3X")" = "0" ] || { echo "$SD3X is already recorded"; exit 1; }
  not_recorded
  echo "LAB READY: $DB (1.3-0 + P4 applied; $SD3X pending)"
  exit 0
fi

not_recorded
TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
SKIPPED="$(skipped | tr '\n' ' ')"
for d in "$ROOT"/prisma/migrations/*/; do
  n="$(basename "$d")"
  [[ "$n" > "$SD3X" ]] && continue
  [[ "$n" > "$SD3" && "$n" < "$SD3X" && "$n" != "$P4" ]] && continue
  cp -r "$d" "$TMP/prisma/migrations/$n"
done
echo "not recorded, not applied in this lab: ${SKIPPED:-(none)}"
( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) | tee /tmp/sd3x-deploy.log
rm -rf "$TMP"
grep -q "Applying migration \`$SD3X\`" /tmp/sd3x-deploy.log || { echo "$SD3X was not applied"; exit 1; }
test "$(grep -c 'Applying migration' /tmp/sd3x-deploy.log)" = "1" || { echo "more than one migration was applied"; exit 1; }
test "$(psql -X -At "$OWNER_URL" -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL")" = "0"
not_recorded
echo "LAB READY: $DB ($SD3X applied)"
