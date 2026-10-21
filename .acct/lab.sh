#!/usr/bin/env bash
# Monthly accountant workflow / migration 20261023090000_accountant_month_close — Production-topology lab.
#
#   .acct/lab.sh <db-name> [--with-acct | --broken-acct]
#
# Builds on the Daily Tasks lab (.dt/lab.sh <db> --with-dt): non-superuser CREATEROLE/BYPASSRLS owner, NOLOGIN
# app_runtime + LOGIN app_runtime_prod, NOLOGIN app_auth, the owner's DEFAULT PRIVILEGES, Business under B4's
# FORCE RLS; ledger through M6 + P3-E + TE + AET + DT. schema.prisma models the accountant tables, so the
# `db push` inside the base lab built them without the migration's policies, triggers, functions and grants:
# they are removed here so the migration builds them the way Production will have them.
#   --with-acct:   `prisma migrate deploy` — the release-migrate mechanism — applies it;
#   --broken-acct: the same with it failing on its last statement (atomicity).
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
M6="20261009090000_m6_acquisition_connections"
P3E="20261013090000_p3e_landing_persistence"
TE="20261015090000_transactional_email_foundation"
AET="20261017090000_auth_email_tokens"
DT="20261018090000_daily_tasks_foundation"
ACCT="20261023090000_accountant_month_close"
bash "$ROOT/.dt/lab.sh" "$DB" --with-dt >/dev/null
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
psql_owner() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" "$@"; }

psql_owner <<'SQL'
DROP TABLE IF EXISTS "AccountantWorkflowEvent", "AccountantDelivery", "AccountantRecipient", "AccountantPackage", "AccountantPeriod" CASCADE;
DELETE FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'accountant_month_close';
DELETE FROM "PlatformFeatureDefinition" WHERE "key" = 'accountant_month_close';
SQL

case "$MODE" in
  --with-acct|--broken-acct) ;;
  *) echo "LAB READY: $DB (through DT; accountant workflow pending)"; exit 0 ;;
esac

TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
for d in "$ROOT"/prisma/migrations/*/; do
  name="$(basename "$d")"
  if [[ ! "$name" > "$M6" || "$name" == "$P3E" || "$name" == "$TE" || "$name" == "$AET" || "$name" == "$DT" || "$name" == "$ACCT" ]]; then
    cp -r "$d" "$TMP/prisma/migrations/$name"
  fi
done
if [ "$MODE" = "--broken-acct" ]; then
  printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$TMP/prisma/migrations/$ACCT/migration.sql"
fi
set +e
( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) > "$TMP/deploy.log" 2>&1
rc=$?
set -e
grep -E "Applying migration|have been successfully applied|Error|error" "$TMP/deploy.log" | head -8
rm -rf "$TMP"
if [ "$MODE" = "--broken-acct" ]; then
  [ $rc -ne 0 ] || { echo "broken migration did NOT fail"; exit 1; }
  echo "LAB READY: $DB (accountant workflow FAILED on its last statement as intended)"; exit 0
fi
[ $rc -eq 0 ] || { echo "accountant workflow deploy failed"; exit 1; }
echo "LAB READY: $DB (accountant workflow applied)"
