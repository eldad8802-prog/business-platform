#!/usr/bin/env bash
# Monthly accountant workflow / migration 20261027090000_accountant_month_close — Production-topology lab.
#
#   .acct/lab.sh <db-name> [--with-acct | --broken-acct]
#
# Builds on the task reminders lab (.trp/lab.sh <db> --with-trp, itself on the Daily Tasks lab): non-superuser
# CREATEROLE/BYPASSRLS owner, NOLOGIN app_runtime + LOGIN app_runtime_prod, NOLOGIN app_auth, the owner's DEFAULT
# PRIVILEGES, Business under B4's FORCE RLS, Daily Tasks + task reminders applied by `prisma migrate deploy`.
# The ledger is then completed with EVERY other migration on this checkout (real sha256), as Production's ledger
# is — including 20261024090000_platform_admin_a1, applied in Production on 2026-10-22 and sorting BEFORE this
# migration (the reason it was re-timed from 20261023090000). Pending: only this migration.
# Migrations that sort AFTER this one (merged to main once it was applied in Production on 2026-10-24) are left
# out of both the ledger and the deploy, exactly as release-migrate staged "applied + the approved prefix": the
# lab reproduces the release that happened, and a later migration can never be applied, or counted, here.
# schema.prisma may model the accountant tables (the application PR), so the `db push` inside the base lab may
# have built them without the migration's policies, triggers, functions and grants: they are removed here so the
# migration builds them the way Production will have them.
#   --with-acct:   `prisma migrate deploy` — the release-migrate mechanism — over every migration directory up to
#                  and including this one, which therefore applies exactly this one;
#   --broken-acct: the same with it failing on its last statement (atomicity).
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ACCT="20261027090000_accountant_month_close"
bash "$ROOT/.trp/lab.sh" "$DB" --with-trp >/dev/null
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
psql_owner() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" "$@"; }

psql_owner <<'SQL'
DROP TABLE IF EXISTS "AccountantBusinessAlert", "AccountantOpsAlert", "AccountantOpsRun", "AccountantLinkChallenge", "AccountantLinkDevice" CASCADE;  -- G5 (20261107090000 / 20261109091000): later, not part of this baseline
DROP TABLE IF EXISTS "AccountantWorkflowEvent", "AccountantDelivery", "AccountantRecipient", "AccountantPackage", "AccountantPeriod" CASCADE;
DELETE FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'accountant_month_close';
DELETE FROM "PlatformFeatureDefinition" WHERE "key" = 'accountant_month_close';
SQL

# Production's ledger: every migration of this checkout except this one is recorded and finished.
LEDGER="$(mktemp)"
for d in "$ROOT"/prisma/migrations/*/; do
  name="$(basename "$d")"
  [ "$name" = "$ACCT" ] && continue
  [[ "$name" > "$ACCT" ]] && continue
  sum="$(sha256sum "$d/migration.sql" | cut -d' ' -f1)"
  echo "INSERT INTO \"_prisma_migrations\" (id, checksum, finished_at, migration_name, applied_steps_count)
        SELECT gen_random_uuid()::text, '$sum', now(), '$name', 1
        WHERE NOT EXISTS (SELECT 1 FROM \"_prisma_migrations\" WHERE migration_name = '$name');" >> "$LEDGER"
done
psql_owner -f "$LEDGER"; rm -f "$LEDGER"

case "$MODE" in
  --with-acct|--broken-acct) ;;
  *) echo "LAB READY: $DB (ledger = every migration on this checkout; accountant workflow pending)"; exit 0 ;;
esac

TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
for d in "$ROOT"/prisma/migrations/*/; do [[ "$(basename "$d")" > "$ACCT" ]] && continue; cp -r "$d" "$TMP/prisma/migrations/$(basename "$d")"; done
if [ "$MODE" = "--broken-acct" ]; then
  printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$TMP/prisma/migrations/$ACCT/migration.sql"
fi
set +e
( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) > "$TMP/deploy.log" 2>&1
rc=$?
set -e
grep -E "migrations found|Applying migration|have been successfully applied|No pending|Error|error" "$TMP/deploy.log" | head -8
rm -rf "$TMP"
if [ "$MODE" = "--broken-acct" ]; then
  [ $rc -ne 0 ] || { echo "broken migration did NOT fail"; exit 1; }
  echo "LAB READY: $DB (accountant workflow FAILED on its last statement as intended)"; exit 0
fi
[ $rc -eq 0 ] || { echo "accountant workflow deploy failed"; exit 1; }
echo "LAB READY: $DB (accountant workflow applied)"
