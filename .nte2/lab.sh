#!/usr/bin/env bash
# Notification engine follow-up / migration 20261211090000_notification_engine_followup — Production-topology lab.
#
#   .nte2/lab.sh <db-name> [--with-nte2 | --broken-nte2]
#
# Chains the foundation lab (.nte/lab.sh <db> --with-nte: the task reminders push lab + migration
# 20261210090000_notification_engine_foundation applied by `prisma migrate deploy`, seeded with NTE_SEED if set), so
# the follow-up meets exactly what it depends on: the foundation's columns, task_reminders_due(), the feature tables.
#   (no flag):      the follow-up is pending;
#   --with-nte2:    `prisma migrate deploy` — the release-migrate mechanism — applies it;
#   --broken-nte2:  the same with it failing on its last statement (atomicity).
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional), NTE_SEED (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
M6="20261009090000_m6_acquisition_connections"
P3E="20261013090000_p3e_landing_persistence"
TE="20261015090000_transactional_email_foundation"
AET="20261017090000_auth_email_tokens"
DT="20261018090000_daily_tasks_foundation"
TRP="20261022090000_task_reminders_push"
NTE="20261210090000_notification_engine_foundation"
NTE2="20261211090000_notification_engine_followup"
bash "$ROOT/.nte/lab.sh" "$DB" --with-nte >/dev/null
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"

case "$MODE" in
  --with-nte2|--broken-nte2) ;;
  *) echo "LAB READY: $DB (notification engine foundation applied; follow-up pending)"; exit 0 ;;
esac

TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
for d in "$ROOT"/prisma/migrations/*/; do
  name="$(basename "$d")"
  if [[ ! "$name" > "$M6" || "$name" == "$P3E" || "$name" == "$TE" || "$name" == "$AET" || "$name" == "$DT" || "$name" == "$TRP" || "$name" == "$NTE" || "$name" == "$NTE2" ]]; then
    cp -r "$d" "$TMP/prisma/migrations/$name"
  fi
done
if [ "$MODE" = "--broken-nte2" ]; then
  printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$TMP/prisma/migrations/$NTE2/migration.sql"
fi
set +e
( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) > "$TMP/deploy.log" 2>&1
rc=$?
set -e
grep -E "Applying migration|have been successfully applied|Error|error" "$TMP/deploy.log" | head -8
rm -rf "$TMP"
if [ "$MODE" = "--broken-nte2" ]; then
  [ $rc -ne 0 ] || { echo "broken migration did NOT fail"; exit 1; }
  echo "LAB READY: $DB (notification engine follow-up FAILED on its last statement as intended)"; exit 0
fi
[ $rc -eq 0 ] || { echo "notification engine follow-up deploy failed"; exit 1; }
echo "LAB READY: $DB (notification engine follow-up applied)"
