#!/usr/bin/env bash
# Task reminders + Web Push / migration 20261022090000_task_reminders_push — Production-topology lab.
#
#   .trp/lab.sh <db-name> [--with-trp | --broken-trp]
#
# Builds on the Daily Tasks lab (.dt/lab.sh <db> --with-dt): non-superuser CREATEROLE/BYPASSRLS owner whose
# DEFAULT PRIVILEGES hand new tables to the runtime, NOLOGIN app_runtime + LOGIN app_runtime_prod, app_auth,
# FORCE RLS on Business and the task tables, the daily tasks foundation applied by `prisma migrate deploy`.
# If schema.prisma already models this migration (the application PR), `db push` built its columns and table
# without the migration's checks, policies, trigger, function and grants: they are removed first so the
# migration builds them the way Production will have them.
#   --with-trp:   `prisma migrate deploy` — the release-migrate mechanism — applies it;
#   --broken-trp: the same with it failing on its last statement (atomicity).
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
TRP="20261022090000_task_reminders_push"
bash "$ROOT/.dt/lab.sh" "$DB" --with-dt >/dev/null
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
psql_owner() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" "$@"; }

psql_owner <<'SQL'
DROP TABLE IF EXISTS "PushSubscription" CASCADE;
DROP INDEX IF EXISTS "Task_reminder_due_idx";
ALTER TABLE "Task" DROP COLUMN IF EXISTS "dueMinute", DROP COLUMN IF EXISTS "remindOffsetMinutes",
  DROP COLUMN IF EXISTS "reminderSentAt";
ALTER TABLE "TaskSeries" DROP COLUMN IF EXISTS "dueMinute", DROP COLUMN IF EXISTS "remindOffsetMinutes";
DROP FUNCTION IF EXISTS public.task_reminders_due(timestamp(3), integer);
SQL

case "$MODE" in
  --with-trp|--broken-trp) ;;
  *) echo "LAB READY: $DB (daily tasks applied; task reminders push pending)"; exit 0 ;;
esac

TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
for d in "$ROOT"/prisma/migrations/*/; do
  name="$(basename "$d")"
  if [[ ! "$name" > "$M6" || "$name" == "$P3E" || "$name" == "$TE" || "$name" == "$AET" || "$name" == "$DT" || "$name" == "$TRP" ]]; then
    cp -r "$d" "$TMP/prisma/migrations/$name"
  fi
done
if [ "$MODE" = "--broken-trp" ]; then
  printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$TMP/prisma/migrations/$TRP/migration.sql"
fi
set +e
( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) > "$TMP/deploy.log" 2>&1
rc=$?
set -e
grep -E "Applying migration|have been successfully applied|Error|error" "$TMP/deploy.log" | head -8
rm -rf "$TMP"
if [ "$MODE" = "--broken-trp" ]; then
  [ $rc -ne 0 ] || { echo "broken migration did NOT fail"; exit 1; }
  echo "LAB READY: $DB (task reminders push FAILED on its last statement as intended)"; exit 0
fi
[ $rc -eq 0 ] || { echo "task reminders push deploy failed"; exit 1; }
echo "LAB READY: $DB (task reminders push applied)"
