#!/usr/bin/env bash
# Revenue truth / migration 20261028090000_revenue_truth_foundation — Production-topology lab.
#
#   .rev/lab.sh <db-name>                 build the lab, revenue truth pending
#   .rev/lab.sh <db-name> --with-rev      build it and apply the migration with `prisma migrate deploy`
#   .rev/lab.sh <db-name> --apply         apply the migration to a lab built earlier (pending) — for the
#                                         before / after catalog comparison on ONE database
#   .rev/lab.sh <db-name> --broken-rev    build it and apply the migration failing on its last statement
#
# Builds on the daily tasks lab (.dt/lab.sh <db> --with-dt): non-superuser CREATEROLE/BYPASSRLS owner, NOLOGIN
# app_runtime + LOGIN app_runtime_prod, NOLOGIN app_auth, the owner's DEFAULT PRIVILEGES (they hand the runtime
# a,r,w,d on every new table — the migration must take that back), Business under FORCE RLS, sec-C's tenant
# keys; ledger through M6 + P3-E + TE + AET + DT. Every other table the migration builds on ("Document",
# "AcquisitionConnection", "ExternalTransaction", "BillingDocument") comes from `db push`, with the tenant
# keys its schema declares.
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REV="20261028090000_revenue_truth_foundation"
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
psql_owner() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" "$@"; }

if [ "$MODE" != "--apply" ]; then
  bash "$ROOT/.dt/lab.sh" "$DB" --with-dt >/dev/null
  # If schema.prisma models the foundation (the application PR), `db push` built its tables without the
  # migration's policies, triggers, functions and grants: remove them so the migration builds them the way
  # Production will have them.
  psql_owner <<'SQL'
DROP TABLE IF EXISTS "RevenueDecision", "RevenueLink", "RevenueDailyCloseVat", "RevenueDailyCloseTender",
                     "RevenueSettlement", "RevenueReceipt", "RevenueDailyClose", "RevenueSale" CASCADE;
DROP TYPE IF EXISTS "RevenueSourceKind", "RevenueCapture", "RevenueSaleKind", "RevenueTenderMethod",
                    "RevenueReceiptDirection", "RevenueVatCategory", "RevenueValidation", "RevenueLinkKind",
                    "RevenueLinkBasis", "RevenueActor", "RevenueDecisionKind";
SQL
fi

case "$MODE" in
  --with-rev|--broken-rev|--apply) ;;
  *) echo "LAB READY: $DB (through DT; revenue truth pending)"; exit 0 ;;
esac

# The ledger the lab already has, plus this migration — nothing else, so `migrate deploy` applies exactly one.
TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
for name in $(psql_owner -Atc "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL"); do
  cp -r "$ROOT/prisma/migrations/$name" "$TMP/prisma/migrations/$name"
done
cp -r "$ROOT/prisma/migrations/$REV" "$TMP/prisma/migrations/$REV"
if [ "$MODE" = "--broken-rev" ]; then
  printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$TMP/prisma/migrations/$REV/migration.sql"
fi
set +e
( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) > "$TMP/deploy.log" 2>&1
rc=$?
set -e
grep -E "Applying migration|have been successfully applied|Error|error" "$TMP/deploy.log" | head -8
rm -rf "$TMP"
if [ "$MODE" = "--broken-rev" ]; then
  [ $rc -ne 0 ] || { echo "broken migration did NOT fail"; exit 1; }
  echo "LAB READY: $DB (revenue truth FAILED on its last statement as intended)"; exit 0
fi
[ $rc -eq 0 ] || { echo "revenue truth deploy failed"; exit 1; }
echo "LAB READY: $DB (revenue truth applied)"
