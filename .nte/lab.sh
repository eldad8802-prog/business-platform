#!/usr/bin/env bash
# Notification engine foundation / migration 20261210090000_notification_engine_foundation — Production-topology lab.
#
#   .nte/lab.sh <db-name> [--with-nte | --broken-nte]
#
# Builds on the task reminders push lab (.trp/lab.sh <db> --with-trp, which chains .dt → .aet → .te → .p3e → .m6 →
# .p3a → .c594): non-superuser CREATEROLE/BYPASSRLS owner whose DEFAULT PRIVILEGES hand new tables to the runtime,
# NOLOGIN app_runtime + LOGIN app_runtime_prod, NOLOGIN app_auth, FORCE RLS on Business, the task tables and
# "PushSubscription", the daily tasks foundation and the task reminders push migration applied by
# `prisma migrate deploy` (task_user_same_business, "PushSubscription_endpoint_shape" exactly as Production has them).
# Then the DB-only objects Production has and `db push` cannot make: FORCE RLS + the tenant policies on
# "Notification" / "NotificationDelivery", executed from the canonical migration 20260903200000 by
# scripts/ci/notification-rls-bootstrap.mjs (no copy of the policy SQL), and the AuthSession privilege contract applied
# verbatim from its migrations (20260908200000, then 20260913120000 — both idempotent): app_runtime holds nothing on
# "AuthSession" / "AuthSessionSecret" (auth_sessions_live is its only door), app_auth its column grants.
# If schema.prisma already models this migration (the application PR), `db push` built its columns and tables without
# the migration's checks, policies, triggers, functions and grants: they are removed first so the migration builds
# them the way Production will have them.
# The migrations main merged after M6 other than those the chain names are left out of the lab ledger, as in the
# TRP lab: their objects come from `db push`, and this migration names none of them (step 0 of the workflow
# asserts that).
#   --with-nte:   `prisma migrate deploy` — the release-migrate mechanism — applies it;
#   --broken-nte: the same with it failing on its last statement (atomicity).
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
NTE="20261210090000_notification_engine_foundation"
bash "$ROOT/.trp/lab.sh" "$DB" --with-trp >/dev/null
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
psql_owner() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" "$@"; }

psql_owner <<'SQL'
DROP TABLE IF EXISTS "NotificationSettings", "NotificationPreference" CASCADE;
ALTER TABLE "PushSubscription"
  DROP COLUMN IF EXISTS "provider", DROP COLUMN IF EXISTS "authSessionId", DROP COLUMN IF EXISTS "revokedReason",
  DROP COLUMN IF EXISTS "lastSeenAt", DROP COLUMN IF EXISTS "appVersion";
ALTER TABLE "PushSubscription" DROP CONSTRAINT IF EXISTS "PushSubscription_id_businessId_key";
DROP INDEX IF EXISTS "PushSubscription_id_businessId_key";
DROP TRIGGER IF EXISTS "Notification_user_same_business" ON "Notification";
DROP INDEX IF EXISTS "Notification_businessId_userId_lastSurfacedAt_idx";
ALTER TABLE "Notification" DROP COLUMN IF EXISTS "userId";
DROP TRIGGER IF EXISTS "NotificationDelivery_user_same_business" ON "NotificationDelivery";
ALTER TABLE "NotificationDelivery"
  DROP COLUMN IF EXISTS "userId", DROP COLUMN IF EXISTS "subscriptionId", DROP COLUMN IF EXISTS "attempts",
  DROP COLUMN IF EXISTS "nextAttemptAt", DROP COLUMN IF EXISTS "leaseUntil", DROP COLUMN IF EXISTS "expiresAt",
  DROP COLUMN IF EXISTS "completedAt";
DROP FUNCTION IF EXISTS public.notification_push_due(timestamp(3), integer);
DROP FUNCTION IF EXISTS public.notification_live_businesses(integer, integer);
DROP FUNCTION IF EXISTS public.auth_sessions_live(uuid[], timestamp(3));
SQL
( cd "$ROOT" && DATABASE_URL="$OWNER_URL" node scripts/ci/notification-rls-bootstrap.mjs >/dev/null )
psql_owner -f "$ROOT/prisma/migrations/20260908200000_auth_session_privilege_contract/migration.sql"
psql_owner -f "$ROOT/prisma/migrations/20260913120000_authsession_user_agent/migration.sql"
# Rows written by the application BEFORE the release (optional, for the backward-compatibility battery): a SQL file
# run as the owner on the pending database, so the migration meets existing rows exactly as it will in Production.
if [ -n "${NTE_SEED:-}" ]; then psql_owner -f "$NTE_SEED"; fi

case "$MODE" in
  --with-nte|--broken-nte) ;;
  *) echo "LAB READY: $DB (task reminders push applied; notification engine foundation pending)"; exit 0 ;;
esac

TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
for d in "$ROOT"/prisma/migrations/*/; do
  name="$(basename "$d")"
  if [[ ! "$name" > "$M6" || "$name" == "$P3E" || "$name" == "$TE" || "$name" == "$AET" || "$name" == "$DT" || "$name" == "$TRP" || "$name" == "$NTE" ]]; then
    cp -r "$d" "$TMP/prisma/migrations/$name"
  fi
done
if [ "$MODE" = "--broken-nte" ]; then
  printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$TMP/prisma/migrations/$NTE/migration.sql"
fi
set +e
( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) > "$TMP/deploy.log" 2>&1
rc=$?
set -e
grep -E "Applying migration|have been successfully applied|Error|error" "$TMP/deploy.log" | head -8
rm -rf "$TMP"
if [ "$MODE" = "--broken-nte" ]; then
  [ $rc -ne 0 ] || { echo "broken migration did NOT fail"; exit 1; }
  echo "LAB READY: $DB (notification engine foundation FAILED on its last statement as intended)"; exit 0
fi
[ $rc -eq 0 ] || { echo "notification engine foundation deploy failed"; exit 1; }
echo "LAB READY: $DB (notification engine foundation applied)"
