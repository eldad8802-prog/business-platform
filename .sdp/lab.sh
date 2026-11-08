#!/usr/bin/env bash
# Service Desk 1.2c / M2 (spare parts) / migration 20261115090000_service_parts — Production-topology lab.
#
#   .sdp/lab.sh <db-name> [--with-m2 | --broken-m2 | --deploy-only | --broken-deploy-only] [--m0-sim]
#
# Builds the 1.2b lab with 20261113090000_service_external_work APPLIED (.sdx/lab.sh <db> --with-sdx): the database
# M2 is released onto (Production applied 1.2b on 2026-11-06). Then it applies the Production tenant RLS of the
# inventory / suppliers cluster (migration 20260825200000_d2_p7_wave3_tenant_rls, run as-is: idempotent, role-free),
# which the base lab's `db push` does not build — M2's references (InventoryItem, InventoryMovement, PurchaseOrder) are
# judged under the same FORCE RLS as Production.
# The ledger is completed with every migration of this checkout that sorts between 1.2b and M2. Pending: only M2;
# migrations sorting after it are left out of ledger and deploy.
#   (no mode)      the pre-migration lab: M2 pending, not applied;
#   --with-m2:     `prisma migrate deploy` — the release-migrate mechanism — applies exactly M2;
#   --broken-m2:   the same with M2 failing on its last statement (atomicity: nothing of it may remain);
#   --deploy-only / --broken-deploy-only: on a lab already built (rollback proof), only the deploy.
#   --m0-sim:      LAB ONLY — adds 'SERVICE_PART' to "InventoryMovementReason", standing in for the inventory session's
#                  M0 (not released, not written here). M2 itself compares reason::text and needs no M0 to apply; only
#                  the battery's issue / return checks write such movements. Production gets the value from M0 alone.
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"; M0SIM="${3:-}"
[ "$MODE" = "--m0-sim" ] && { MODE=""; M0SIM="--m0-sim"; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SDX="20261113090000_service_external_work"
M2="20261115090000_service_parts"
WAVE3="20260825200000_d2_p7_wave3_tenant_rls"
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
psql_owner() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" "$@"; }

[ -f "$ROOT/prisma/migrations/$M2/migration.sql" ] || { echo "missing prisma/migrations/$M2"; exit 1; }

if [ "$MODE" != "--deploy-only" ] && [ "$MODE" != "--broken-deploy-only" ]; then
bash "$ROOT/.sdx/lab.sh" "$DB" --with-sdx >/dev/null
psql_owner -f "$ROOT/prisma/migrations/$WAVE3/migration.sql"
LEDGER="$(mktemp)"
for d in "$ROOT"/prisma/migrations/*/; do
  name="$(basename "$d")"
  [[ "$name" > "$SDX" ]] || continue
  [[ "$name" < "$M2" ]] || continue
  sum="$(sha256sum "$d/migration.sql" | cut -d' ' -f1)"
  echo "INSERT INTO \"_prisma_migrations\" (id, checksum, finished_at, migration_name, applied_steps_count)
        SELECT gen_random_uuid()::text, '$sum', now(), '$name', 1
        WHERE NOT EXISTS (SELECT 1 FROM \"_prisma_migrations\" WHERE migration_name = '$name');" >> "$LEDGER"
done
[ -s "$LEDGER" ] && psql_owner -f "$LEDGER"; rm -f "$LEDGER"
fi

m0sim() {
  [ "$M0SIM" = "--m0-sim" ] || return 0
  psql_owner -c "ALTER TYPE \"InventoryMovementReason\" ADD VALUE IF NOT EXISTS 'SERVICE_PART'"
  echo "lab only: M0 simulated (InventoryMovementReason + SERVICE_PART)"
}

case "$MODE" in
  --with-m2|--broken-m2|--deploy-only|--broken-deploy-only) ;;
  "") m0sim; echo "LAB READY: $DB (1.2b applied, inventory RLS as Production; ledger = every migration before M2; M2 pending)"; exit 0 ;;
  *) echo "unknown mode $MODE"; exit 2 ;;
esac

TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
for d in "$ROOT"/prisma/migrations/*/; do [[ "$(basename "$d")" > "$M2" ]] && continue; cp -r "$d" "$TMP/prisma/migrations/$(basename "$d")"; done
if [ "$MODE" = "--broken-m2" ] || [ "$MODE" = "--broken-deploy-only" ]; then
  printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$TMP/prisma/migrations/$M2/migration.sql"
fi
set +e
( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) > "$TMP/deploy.log" 2>&1
rc=$?
set -e
grep -E "migrations found|Applying migration|have been successfully applied|No pending|Error|error|ERROR" "$TMP/deploy.log" | head -12
rm -rf "$TMP"
if [ "$MODE" = "--broken-m2" ] || [ "$MODE" = "--broken-deploy-only" ]; then
  [ $rc -ne 0 ] || { echo "broken migration did NOT fail"; exit 1; }
  echo "LAB READY: $DB (service parts FAILED on its last statement as intended)"; exit 0
fi
[ $rc -eq 0 ] || { echo "service parts deploy failed"; exit 1; }
m0sim
echo "LAB READY: $DB (service parts applied)"
