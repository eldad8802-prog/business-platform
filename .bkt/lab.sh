#!/usr/bin/env bash
# Business kind transition / migration 20261221090000_business_kind_transition — Production-topology lab.
#
#   .bkt/lab.sh <db-name> [--with-bkt | --broken-bkt]
#
# Builds on the signup legal identity lab (.sli/lab.sh <db> --with-sli: non-superuser BYPASSRLS owner, NOLOGIN
# app_runtime + LOGIN app_runtime_prod, app_auth + te_auth_login, BusinessProfile under FORCE RLS with the runtime's
# real grants, 20261128090000 applied by `migrate deploy`). BusinessIssuerDeclaration comes from `db push` (this
# migration only READS it: the latest version and its anonymisedAt).
#   (no flag)     baseline: this migration pending;
#   --with-bkt:   `prisma migrate deploy` — the release-migrate mechanism — applies it;
#   --broken-bkt: the same with it failing on its last statement (atomicity).
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BKT="20261221090000_business_kind_transition"
bash "$ROOT/.sli/lab.sh" "$DB" --with-sli >/dev/null
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
psql_owner() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" "$@"; }
# If schema.prisma models the table (the application PR), `db push` built it without the migration's policies,
# trigger and grants: remove it so the migration builds it the way Production will have it.
psql_owner -c 'DROP TABLE IF EXISTS "BusinessKindTransition" CASCADE'

case "$MODE" in
  --with-bkt|--broken-bkt) ;;
  *) echo "LAB READY: $DB (through 20261128090000; business kind transition pending)"; exit 0 ;;
esac

# The migrations directory = exactly the lab ledger + this migration, so `migrate deploy` applies this one alone.
TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
for name in $(psql_owner -At -c 'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL') "$BKT"; do
  cp -r "$ROOT/prisma/migrations/$name" "$TMP/prisma/migrations/$name"
done
if [ "$MODE" = "--broken-bkt" ]; then
  printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$TMP/prisma/migrations/$BKT/migration.sql"
fi
set +e
( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) > "$TMP/deploy.log" 2>&1
rc=$?
set -e
grep -E "Applying migration|have been successfully applied|Error|error" "$TMP/deploy.log" | head -8
rm -rf "$TMP"
if [ "$MODE" = "--broken-bkt" ]; then
  [ $rc -ne 0 ] || { echo "broken migration did NOT fail"; exit 1; }
  echo "LAB READY: $DB (--broken-bkt: the migration FAILED on its last statement as intended)"; exit 0
fi
[ $rc -eq 0 ] || { echo "business kind transition deploy failed"; exit 1; }
echo "LAB READY: $DB (business kind transition applied)"
