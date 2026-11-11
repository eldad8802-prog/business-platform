#!/usr/bin/env bash
# Issuer declaration (#1081) / migration 20261123090000_issuer_declaration — Production-topology lab.
#
#   .issuer-declaration/lab.sh <db-name>                the P4 lab (.sd3p4/lab.sh + --deploy-only) with the purge's
#                                                       prerequisites (.sdf/erasure-prereq.sh): 20261123090000 pending
#   .issuer-declaration/lab.sh <db-name> --deploy-only  on that lab, `prisma migrate deploy` — the release-migrate
#                                                       mechanism — applies exactly 20261123090000
#
# A migration that sorts between 1.3-0 and P4 (today 20261121090000_business_documents_po_sheets) is neither recorded nor
# applied, exactly as in .sd3p4/lab.sh: the base lab does not build the business-documents objects it needs.
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ME="20261123090000_issuer_declaration"
P4="20261122090000_service_desk_audit_journal"
SD3="20261120090000_service_desk_ui_foundation"
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"

[ -f "$ROOT/prisma/migrations/$ME/migration.sql" ] || { echo "missing prisma/migrations/$ME"; exit 1; }

if [ "$MODE" != "--deploy-only" ]; then
  bash "$ROOT/.sd3p4/lab.sh" "$DB" >/dev/null
  bash "$ROOT/.sd3p4/lab.sh" "$DB" --deploy-only >/dev/null
  bash "$ROOT/.sdf/erasure-prereq.sh" "$DB" >/dev/null
  # The code PR models the declaration tables: drop what db push built, so the migration builds them (no-op otherwise).
  psql -X -q -v ON_ERROR_STOP=1 "$OWNER_URL" -f "$ROOT/.issuer-declaration/drop-pushed.sql" >/dev/null 2>&1
  [ "$(psql -X -At "$OWNER_URL" -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '$ME'")" = "0" ] \
    || { echo "$ME is already recorded"; exit 1; }
  echo "LAB READY: $DB (P4 applied, erasure prerequisites in place; $ME pending)"
  exit 0
fi

TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
for d in "$ROOT"/prisma/migrations/*/; do
  n="$(basename "$d")"
  [[ "$n" > "$ME" ]] && continue
  [[ "$n" > "$SD3" && "$n" < "$P4" ]] && continue
  cp -r "$d" "$TMP/prisma/migrations/$n"
done
( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) | tee /tmp/issuer-decl-deploy.log
rm -rf "$TMP"
grep -q "Applying migration \`$ME\`" /tmp/issuer-decl-deploy.log || { echo "$ME was not applied"; exit 1; }
test "$(grep -c 'Applying migration' /tmp/issuer-decl-deploy.log)" = "1" || { echo "more than one migration was applied"; exit 1; }
test "$(psql -X -At "$OWNER_URL" -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL")" = "0"
echo "LAB READY: $DB ($ME applied)"
