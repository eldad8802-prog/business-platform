#!/usr/bin/env bash
# Daily Tasks / migration 20261018090000_daily_tasks_foundation — Production-topology lab.
#
#   .dt/lab.sh <db-name> [--with-dt | --broken-dt]
#
# Builds on the auth email tokens lab (.aet/lab.sh <db> --with-aet): non-superuser CREATEROLE/BYPASSRLS owner,
# NOLOGIN app_runtime + LOGIN app_runtime_prod, NOLOGIN app_auth, the owner's DEFAULT PRIVILEGES (which
# handed the runtime arwd on "Task" when `db push` created it — exactly how Production got the privileges
# the G4 gate found), Business under B4's FORCE RLS; ledger through M6 + P3-E + TE + AET. Then .dt/prereq.sql
# adds the DB-only objects Production has and `db push` cannot make: sec-C's Customer / Lead tenant keys and
# wave 1's FORCE RLS + p7w1_tenant on "Task".
# The migrations main merged after M6 other than those three are left out of the lab ledger, as in the AET
# lab: their objects come from `db push`, and this migration names none of them (step 0 of the workflow
# asserts that).
#   --with-dt:   `prisma migrate deploy` — the release-migrate mechanism — applies it;
#   --broken-dt: the same with it failing on its last statement (atomicity).
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
bash "$ROOT/.aet/lab.sh" "$DB" --with-aet >/dev/null
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
psql_owner() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" "$@"; }

# If schema.prisma models the foundation (the application PR), `db push` built its tables and columns without
# the migration's policies, triggers, functions and grants: remove them so the migration builds them the way
# Production will have them.
psql_owner <<'SQL'
DROP TABLE IF EXISTS "TaskEvent", "TaskRequestLedger", "TaskPreferences", "TaskSourceState" CASCADE;
ALTER TABLE "Task"
  DROP COLUMN IF EXISTS "dueOn", DROP COLUMN IF EXISTS "remindAt", DROP COLUMN IF EXISTS "closeReason",
  DROP COLUMN IF EXISTS "completedAt", DROP COLUMN IF EXISTS "completedByUserId",
  DROP COLUMN IF EXISTS "createdByUserId", DROP COLUMN IF EXISTS "assigneeUserId",
  DROP COLUMN IF EXISTS "seriesId", DROP COLUMN IF EXISTS "sequence", DROP COLUMN IF EXISTS "pinnedAt",
  DROP COLUMN IF EXISTS "origin", DROP COLUMN IF EXISTS "version", DROP COLUMN IF EXISTS "customerId",
  DROP COLUMN IF EXISTS "supplierId", DROP COLUMN IF EXISTS "leadId", DROP COLUMN IF EXISTS "documentId",
  DROP COLUMN IF EXISTS "erasedAt";
DROP INDEX IF EXISTS "Task_businessId_id_key";
DROP TABLE IF EXISTS "TaskSeries" CASCADE;
DROP TYPE IF EXISTS "TaskEventType", "TaskEventActor", "TaskSeriesRuleKind", "TaskCloseReason", "TaskOrigin";
SQL
psql_owner -f "$ROOT/.dt/prereq.sql"

case "$MODE" in
  --with-dt|--broken-dt) ;;
  *) echo "LAB READY: $DB (through M6 + P3-E + TE + AET; daily tasks pending)"; exit 0 ;;
esac

TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
for d in "$ROOT"/prisma/migrations/*/; do
  name="$(basename "$d")"
  if [[ ! "$name" > "$M6" || "$name" == "$P3E" || "$name" == "$TE" || "$name" == "$AET" || "$name" == "$DT" ]]; then
    cp -r "$d" "$TMP/prisma/migrations/$name"
  fi
done
if [ "$MODE" = "--broken-dt" ]; then
  printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$TMP/prisma/migrations/$DT/migration.sql"
fi
set +e
( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) > "$TMP/deploy.log" 2>&1
rc=$?
set -e
grep -E "Applying migration|have been successfully applied|Error|error" "$TMP/deploy.log" | head -8
rm -rf "$TMP"
if [ "$MODE" = "--broken-dt" ]; then
  [ $rc -ne 0 ] || { echo "broken migration did NOT fail"; exit 1; }
  echo "LAB READY: $DB (daily tasks FAILED on its last statement as intended)"; exit 0
fi
[ $rc -eq 0 ] || { echo "daily tasks deploy failed"; exit 1; }
echo "LAB READY: $DB (daily tasks applied)"
