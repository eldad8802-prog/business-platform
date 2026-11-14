#!/usr/bin/env bash
# Notifications: stuck documents + personal appointment lead time / migration
# 20261213090000_notification_docs_stuck_appointment_lead — Production-topology lab.
#
#   .nte2d/lab.sh <db-name> [--with-nte2d | --broken-nte2d]
#
# Chains the activation lab (.nte2c/lab.sh <db> --with-nte2c: the foundation, the follow-up and the activation record
# applied by `prisma migrate deploy` on Production's role topology — lab_owner BYPASSRLS, app_runtime /
# app_runtime_prod NOBYPASSRLS, app_ctlplane, app_auth; FORCE RLS on "Document" (p7w4d_tenant, p7adm_read) and on
# "NotificationSettings"), so this migration meets exactly what it builds on.
# If schema.prisma already models the two columns (the code PR, once this migration is in its base), `db push` built
# them without the trigger and the check: they are removed first so the migration builds them the way Production will
# have them.
# NTE2D_SEED (optional): a SQL file run as the owner on the PENDING database (rows the application wrote before the
# release — documents in every status, a settings row — to prove history stays unstamped and untouched).
#   (no flag):        the migration is pending;
#   --with-nte2d:     `prisma migrate deploy` — the release-migrate mechanism — applies it;
#   --broken-nte2d:   the same with it failing on its last statement (atomicity).
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional), NTE_SEED / NTE2C_SEED / NTE2D_SEED (optional). Synthetic only.
# ZERO secrets. ZERO network.
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
NTE2D="20261213090000_notification_docs_stuck_appointment_lead"
bash "$ROOT/.nte2c/lab.sh" "$DB" --with-nte2c >/dev/null
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
psql_owner() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" "$@"; }

# "Document" as Production has it (`db push` makes neither RLS nor grants): the documents tenant RLS migration applied
# verbatim (20260827090000 — idempotent: FORCE RLS + p7w4d_tenant + p7adm_read on the documents cluster), and the
# admin read plane's column grant on "Document" taken from 20261024090000 itself (that migration as a whole is not
# re-runnable: it makes a table `db push` already made), so the proof can show the admin's grants do not reach the
# new column.
# Production has the platform admin read role (app_admin, NOLOGIN, created out of band as in .acct/ops-lab.sh); the
# documents RLS migration grants it p7adm_read. Roles are cluster-wide, so a fresh CI cluster needs it made here.
PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q -U "$SUPER" -d postgres <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin') THEN
    CREATE ROLE app_admin NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END \$\$;
SQL
psql_owner -f "$ROOT/prisma/migrations/20260827090000_d2_p7_w4d_documents_tenant_rls/migration.sql"
ADMIN_DOC_GRANT="$(sed -n '/GRANT SELECT ("id", "businessId", "status", "source", "createdAt")/,/ON "Document" TO app_admin;/p' \
  "$ROOT/prisma/migrations/20261024090000_platform_admin_a1/migration.sql")"
case "$ADMIN_DOC_GRANT" in *'ON "Document" TO app_admin;'*) ;; *) echo "admin grant on Document not found in 20261024090000"; exit 1 ;; esac
psql_owner -c "$ADMIN_DOC_GRANT"

psql_owner <<'SQL'
DROP TRIGGER IF EXISTS "Document_status_changed_at" ON "Document";
DROP FUNCTION IF EXISTS public.document_status_changed_at();
ALTER TABLE "Document" DROP COLUMN IF EXISTS "statusChangedAt";
ALTER TABLE "NotificationSettings" DROP CONSTRAINT IF EXISTS "NotificationSettings_appointment_reminder";
ALTER TABLE "NotificationSettings" DROP COLUMN IF EXISTS "appointmentReminderMinutes";
SQL
if [ -n "${NTE2D_SEED:-}" ]; then psql_owner -f "$NTE2D_SEED"; fi

case "$MODE" in
  --with-nte2d|--broken-nte2d) ;;
  *) echo "LAB READY: $DB (notification engine activation applied; docs + appointments migration pending)"; exit 0 ;;
esac

TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
for d in "$ROOT"/prisma/migrations/*/; do
  name="$(basename "$d")"
  if [[ ! "$name" > "$M6" || "$name" == "$P3E" || "$name" == "$TE" || "$name" == "$AET" || "$name" == "$DT" || "$name" == "$TRP" || "$name" == "$NTE" || "$name" == "$NTE2" || "$name" == "$NTE2C" || "$name" == "$NTE2D" ]]; then
    cp -r "$d" "$TMP/prisma/migrations/$name"
  fi
done
if [ "$MODE" = "--broken-nte2d" ]; then
  printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$TMP/prisma/migrations/$NTE2D/migration.sql"
fi
set +e
( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) > "$TMP/deploy.log" 2>&1
rc=$?
set -e
grep -E "Applying migration|have been successfully applied|Error|error" "$TMP/deploy.log" | head -8
rm -rf "$TMP"
if [ "$MODE" = "--broken-nte2d" ]; then
  [ $rc -ne 0 ] || { echo "broken migration did NOT fail"; exit 1; }
  echo "LAB READY: $DB (docs + appointments migration FAILED on its last statement as intended)"; exit 0
fi
[ $rc -eq 0 ] || { echo "docs + appointments migration deploy failed"; exit 1; }
echo "LAB READY: $DB (docs + appointments migration applied)"
