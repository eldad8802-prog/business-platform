#!/usr/bin/env bash
# Service Desk / migration 20261112090000_service_desk_foundation — Production-topology lab.
#
#   .sdf/lab.sh <db-name> [--with-sdf | --broken-sdf | --deploy-only]
#
# Builds on the public booking lab (.bkg/lab.sh <db> --with-bkg, itself on the appointments → accountant → task
# reminders → Daily Tasks chain): non-superuser CREATEROLE/BYPASSRLS owner, NOLOGIN app_runtime + LOGIN
# app_runtime_prod, NOLOGIN app_auth, the owner's DEFAULT PRIVILEGES, "Customer" ("businessId", "id"), StaffMember
# under FORCE RLS. Then .sdf/prereq.sql adds Production's FORCE RLS on "BillingDocument" (cutover-2B, verbatim).
# The ledger is completed with EVERY other migration of this checkout that sorts before this one (real sha256), as
# Production's is. Pending: only this migration. Migrations sorting after it are left out of ledger and deploy.
#   --with-sdf:    `prisma migrate deploy` — the release-migrate mechanism — applies exactly this one;
#   --broken-sdf:  the same with it failing on its last statement (atomicity);
#   --deploy-only: on a lab already built (rollback proof), only the deploy;
#   --broken-deploy-only: the same, failing on its last statement.
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BKG="20261106090000_public_booking_foundation"
SDF="20261112090000_service_desk_foundation"
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
psql_owner() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" "$@"; }

if [ "$MODE" != "--deploy-only" ] && [ "$MODE" != "--broken-deploy-only" ]; then
bash "$ROOT/.bkg/lab.sh" "$DB" --with-bkg >/dev/null
# schema.prisma models the Service Desk (PR-2), so the base lab's `db push` built its tables and enums without
# the migration's checks, triggers, functions, policies and grants: remove them so the migration builds them the
# way Production has them.
psql_owner <<'SQL'
DROP TABLE IF EXISTS "ServiceHandover", "ServiceCaseEvent", "ServiceQuote", "ServiceCaseIntake", "ServiceCase",
  "ServiceDevice", "ServiceCaseNumberSequence" CASCADE;
DROP TYPE IF EXISTS "ServiceEventType", "ServiceCaseAction", "ServiceActor", "ServiceQuoteApprovalMethod",
  "ServiceQuoteState", "ServiceCoverageDecision", "ServiceCoverageSource", "ServiceOutcome", "ServiceHoldReason",
  "ServiceCaseStatus", "ServiceCaseKind";
SQL
psql_owner -f "$ROOT/.sdf/prereq.sql"

# Production's ledger: every migration of this checkout that sorts before this one is recorded and finished.
LEDGER="$(mktemp)"
for d in "$ROOT"/prisma/migrations/*/; do
  name="$(basename "$d")"
  [[ "$name" > "$BKG" ]] || continue
  [[ "$name" < "$SDF" ]] || continue
  sum="$(sha256sum "$d/migration.sql" | cut -d' ' -f1)"
  echo "INSERT INTO \"_prisma_migrations\" (id, checksum, finished_at, migration_name, applied_steps_count)
        SELECT gen_random_uuid()::text, '$sum', now(), '$name', 1
        WHERE NOT EXISTS (SELECT 1 FROM \"_prisma_migrations\" WHERE migration_name = '$name');" >> "$LEDGER"
done
[ -s "$LEDGER" ] && psql_owner -f "$LEDGER"; rm -f "$LEDGER"
fi

case "$MODE" in
  --with-sdf|--broken-sdf|--deploy-only|--broken-deploy-only) ;;
  *) echo "LAB READY: $DB (ledger = every migration before this one; service desk foundation pending)"; exit 0 ;;
esac

TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
for d in "$ROOT"/prisma/migrations/*/; do [[ "$(basename "$d")" > "$SDF" ]] && continue; cp -r "$d" "$TMP/prisma/migrations/$(basename "$d")"; done
if [ "$MODE" = "--broken-sdf" ] || [ "$MODE" = "--broken-deploy-only" ]; then
  printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$TMP/prisma/migrations/$SDF/migration.sql"
fi
set +e
( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) > "$TMP/deploy.log" 2>&1
rc=$?
set -e
grep -E "migrations found|Applying migration|have been successfully applied|No pending|Error|error|ERROR" "$TMP/deploy.log" | head -12
rm -rf "$TMP"
if [ "$MODE" = "--broken-sdf" ] || [ "$MODE" = "--broken-deploy-only" ]; then
  [ $rc -ne 0 ] || { echo "broken migration did NOT fail"; exit 1; }
  echo "LAB READY: $DB (service desk foundation FAILED on its last statement as intended)"; exit 0
fi
[ $rc -eq 0 ] || { echo "service desk foundation deploy failed"; exit 1; }
echo "LAB READY: $DB (service desk foundation applied)"
