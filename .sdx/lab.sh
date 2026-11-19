#!/usr/bin/env bash
# Service Desk 1.2b / migration 20261113090000_service_external_work — Production-topology lab.
#
#   .sdx/lab.sh <db-name> [--with-sdx | --broken-sdx | --deploy-only | --broken-deploy-only]
#
# Builds on the Service Desk foundation lab (.sdf/lab.sh <db> --with-sdf: the public booking → appointments →
# accountant → task reminders → Daily Tasks chain, the foundation applied by `migrate deploy`, as in Production).
# Then .sdx/prereq.sql adds Production's FORCE RLS on "Supplier" (D2 wave 3, verbatim).
# The ledger is completed with every migration of this checkout that sorts between the foundation and this one.
# Pending: only this migration. Migrations sorting after it are left out of ledger and deploy.
#   --with-sdx:    `prisma migrate deploy` — the release-migrate mechanism — applies exactly this one;
#   --broken-sdx:  the same with it failing on its last statement (atomicity);
#   --deploy-only / --broken-deploy-only: on a lab already built (rollback proof), only the deploy.
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SDF="20261112090000_service_desk_foundation"
SDX="20261113090000_service_external_work"
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
psql_owner() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" "$@"; }

if [ "$MODE" != "--deploy-only" ] && [ "$MODE" != "--broken-deploy-only" ]; then
bash "$ROOT/.sdf/lab.sh" "$DB" --with-sdf >/dev/null
# schema.prisma models 1.2b (PR-2), so the base chain's `db push` built its tables and enums without the migration's
# checks, triggers, functions, policies and grants. .sdf/lab.sh already drops them before the foundation deploy;
# make sure nothing of them is left, so the migration builds them the way Production has them. The same for the M2
# spare-parts tables (schema.prisma models them too; .sdp/lab.sh deploys M2 on top of this lab).
psql_owner <<'SQL'
DROP TABLE IF EXISTS "ServicePartEvent", "ServicePart" CASCADE;
DROP TYPE IF EXISTS "ServicePartEventKind", "ServicePartWriteOffReason", "ServicePartCostSource", "ServicePartSource",
  "ServicePartState";
DROP TABLE IF EXISTS "ServiceExternalWorkEvent", "ServiceExternalWork" CASCADE;
DROP TYPE IF EXISTS "ServiceExternalWorkEventKind", "ServiceExternalReturnResult", "ServiceExternalProgress",
  "ServiceExternalWorkState";
SQL
psql_owner -f "$ROOT/.sdx/prereq.sql"
LEDGER="$(mktemp)"
for d in "$ROOT"/prisma/migrations/*/; do
  name="$(basename "$d")"
  [[ "$name" > "$SDF" ]] || continue
  [[ "$name" < "$SDX" ]] || continue
  sum="$(sha256sum "$d/migration.sql" | cut -d' ' -f1)"
  echo "INSERT INTO \"_prisma_migrations\" (id, checksum, finished_at, migration_name, applied_steps_count)
        SELECT gen_random_uuid()::text, '$sum', now(), '$name', 1
        WHERE NOT EXISTS (SELECT 1 FROM \"_prisma_migrations\" WHERE migration_name = '$name');" >> "$LEDGER"
done
[ -s "$LEDGER" ] && psql_owner -f "$LEDGER"; rm -f "$LEDGER"
fi

case "$MODE" in
  --with-sdx|--broken-sdx|--deploy-only|--broken-deploy-only) ;;
  *) echo "LAB READY: $DB (ledger = every migration before this one; service external work pending)"; exit 0 ;;
esac

TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
for d in "$ROOT"/prisma/migrations/*/; do [[ "$(basename "$d")" > "$SDX" ]] && continue; cp -r "$d" "$TMP/prisma/migrations/$(basename "$d")"; done
if [ "$MODE" = "--broken-sdx" ] || [ "$MODE" = "--broken-deploy-only" ]; then
  printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$TMP/prisma/migrations/$SDX/migration.sql"
fi
set +e
( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) > "$TMP/deploy.log" 2>&1
rc=$?
set -e
grep -E "migrations found|Applying migration|have been successfully applied|No pending|Error|error|ERROR" "$TMP/deploy.log" | head -12
rm -rf "$TMP"
if [ "$MODE" = "--broken-sdx" ] || [ "$MODE" = "--broken-deploy-only" ]; then
  [ $rc -ne 0 ] || { echo "broken migration did NOT fail"; exit 1; }
  echo "LAB READY: $DB (service external work FAILED on its last statement as intended)"; exit 0
fi
[ $rc -eq 0 ] || { echo "service external work deploy failed"; exit 1; }
echo "LAB READY: $DB (service external work applied)"
