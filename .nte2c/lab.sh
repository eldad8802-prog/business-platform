#!/usr/bin/env bash
# Notification engine activation / migration 20261212090000_notification_engine_activation — Production-topology lab.
#
#   .nte2c/lab.sh <db-name> [--with-nte2c | --broken-nte2c]
#
# Chains the follow-up lab (.nte2/lab.sh <db> --with-nte2: the foundation lab + migration 20261211090000 applied by
# `prisma migrate deploy`, seeded with NTE_SEED if set), so the activation migration meets exactly what it depends on:
# the foundation's owed pushes, the feature rows of `notifications_engine` (definition + policy, OFF), the role
# topology (lab_owner BYPASSRLS, app_runtime / app_runtime_prod NOBYPASSRLS, app_ctlplane, app_auth).
# If schema.prisma already models the table (the engine's code PR), `db push` built it without its checks, policy,
# grants, functions and triggers: it is removed first so the migration builds it the way Production will have it.
# The control-plane privileges (20261003090000, idempotent) are re-applied verbatim and a LOGIN member of app_ctlplane
# (nte2c_ctl_login) is created, so the battery writes the per-business switch as the real writer role.
# NTE2C_SEED (optional): a SQL file run as the owner on the PENDING database (rows the application wrote before the
# release — e.g. a notifications_engine override already ENABLED, to prove the backfill).
#   (no flag):       the activation migration is pending;
#   --with-nte2c:    `prisma migrate deploy` — the release-migrate mechanism — applies it;
#   --broken-nte2c:  the same with it failing on its last statement (atomicity).
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional), NTE_SEED / NTE2C_SEED (optional). Synthetic only. ZERO secrets.
# ZERO network.
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
NTE2C="20261212090000_notification_engine_activation"
bash "$ROOT/.nte2/lab.sh" "$DB" --with-nte2 >/dev/null
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
psql_owner() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" "$@"; }

# The platform admin's write path, as Production has it: the control-plane privileges migration applied verbatim
# (idempotent) and a LOGIN member of app_ctlplane (nte2c_ctl_login) so the battery switches the engine through the
# real writer role (NOBYPASSRLS, no privilege on the new table).
PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q -U "$SUPER" -d postgres <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nte2c_ctl_login') THEN
    CREATE ROLE nte2c_ctl_login LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${LAB_PASSWORD:-}' IN ROLE app_ctlplane;
  END IF;
END \$\$;
SQL
psql_owner -f "$ROOT/prisma/migrations/20261003090000_control_plane_production_privileges/migration.sql"

psql_owner <<'SQL'
DROP TRIGGER IF EXISTS "BusinessFeatureAccess_notification_engine_activation" ON "BusinessFeatureAccess";
DROP TRIGGER IF EXISTS "PlatformFeaturePolicy_notification_engine_activation" ON "PlatformFeaturePolicy";
DROP FUNCTION IF EXISTS public.notification_engine_observe(integer, boolean, timestamp(3));
DROP FUNCTION IF EXISTS public.notification_engine_policy_changed();
DROP FUNCTION IF EXISTS public.notification_engine_override_changed();
DROP FUNCTION IF EXISTS public.notification_engine_record(integer, boolean, timestamp(3), text);
DROP FUNCTION IF EXISTS public.notification_engine_effective(text, boolean, boolean);
DROP TABLE IF EXISTS "NotificationEngineActivation" CASCADE;
SQL
if [ -n "${NTE2C_SEED:-}" ]; then psql_owner -f "$NTE2C_SEED"; fi

case "$MODE" in
  --with-nte2c|--broken-nte2c) ;;
  *) echo "LAB READY: $DB (notification engine follow-up applied; activation pending)"; exit 0 ;;
esac

TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
for d in "$ROOT"/prisma/migrations/*/; do
  name="$(basename "$d")"
  if [[ ! "$name" > "$M6" || "$name" == "$P3E" || "$name" == "$TE" || "$name" == "$AET" || "$name" == "$DT" || "$name" == "$TRP" || "$name" == "$NTE" || "$name" == "$NTE2" || "$name" == "$NTE2C" ]]; then
    cp -r "$d" "$TMP/prisma/migrations/$name"
  fi
done
if [ "$MODE" = "--broken-nte2c" ]; then
  printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$TMP/prisma/migrations/$NTE2C/migration.sql"
fi
set +e
( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) > "$TMP/deploy.log" 2>&1
rc=$?
set -e
grep -E "Applying migration|have been successfully applied|Error|error" "$TMP/deploy.log" | head -8
rm -rf "$TMP"
if [ "$MODE" = "--broken-nte2c" ]; then
  [ $rc -ne 0 ] || { echo "broken migration did NOT fail"; exit 1; }
  echo "LAB READY: $DB (notification engine activation FAILED on its last statement as intended)"; exit 0
fi
[ $rc -eq 0 ] || { echo "notification engine activation deploy failed"; exit 1; }
echo "LAB READY: $DB (notification engine activation applied)"
