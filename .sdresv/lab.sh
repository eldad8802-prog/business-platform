#!/usr/bin/env bash
# Service Desk / migration 20261128090000_service_parts_reservation_guard — Production-topology lab.
#
#   .sdresv/lab.sh <db>                        the P4 lab (.sd3p4/lab.sh <db> + --deploy-only), then the Service Desk
#                                              Drafts this one sorts after — 20261125 (#1096), 20261126 (#1104),
#                                              20261127 (M1, #1118) — applied by `prisma migrate deploy`; THIS one pending
#   .sdresv/lab.sh <db> --deploy-only          on that lab, `prisma migrate deploy` — the release-migrate mechanism —
#                                              applies exactly 20261128090000
#   .sdresv/lab.sh <db> --broken-deploy-only   the same with it failing on its last statement (atomicity)
#   .sdresv/lab.sh <db> --from-p4              as the first form, on a database that already IS the P4 lab
#
# LAB ONLY: 'SERVICE_PART' is added to "InventoryMovementReason" (M0 of the inventory session, simulated exactly as
# .sdp/lab.sh --m0-sim does) so the battery can issue a part with a real stock movement.
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RESV="20261128090000_service_parts_reservation_guard"
BEFORE=(20261125090000_service_desk_handover_owner_confirmed 20261126090000_service_desk_case_charge 20261127090000_service_desk_tracks)
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
q() { psql -X -At "$OWNER_URL" -c "$1" | tr -d '\r'; }

[ -f "$ROOT/prisma/migrations/$RESV/migration.sql" ] || { echo "missing prisma/migrations/$RESV"; exit 1; }

stage() { # <dir> <fault?> <names...>: every migration the ledger holds as finished + the names given
  local T="$1" fault="$2"; shift 2
  mkdir -p "$T/prisma/migrations"
  cp "$ROOT/prisma/schema.prisma" "$T/prisma/schema.prisma"
  cp "$ROOT/prisma/migrations/migration_lock.toml" "$T/prisma/migrations/"
  local n
  while read -r n; do
    [ -n "$n" ] || continue
    cp -r "$ROOT/prisma/migrations/$n" "$T/prisma/migrations/$n"
  done < <(q "SELECT migration_name FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")
  for n in "$@"; do rm -rf "$T/prisma/migrations/$n"; cp -r "$ROOT/prisma/migrations/$n" "$T/prisma/migrations/$n"; done
  if [ "$fault" = fault ]; then printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$T/prisma/migrations/$RESV/migration.sql"; fi
}
deploy() { # <dir>
  ( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$1/prisma/schema.prisma" ) 2>&1 </dev/null
}

if [ "$MODE" = "" ] || [ "$MODE" = "--from-p4" ]; then
  if [ "$MODE" = "" ]; then  # --from-p4: <db> is already the P4 lab (a copy of one), skip its build
    bash "$ROOT/.sd3p4/lab.sh" "$DB" >/dev/null
    bash "$ROOT/.sd3p4/lab.sh" "$DB" --deploy-only >/dev/null
  fi
  psql -X -q -v ON_ERROR_STOP=1 "$OWNER_URL" -c "ALTER TYPE \"InventoryMovementReason\" ADD VALUE IF NOT EXISTS 'SERVICE_PART'"
  T="$(mktemp -d)"; stage "$T" no "${BEFORE[@]}"; set +e; OUT="$(deploy "$T")"; set -e; rm -rf "$T"
  APPLIED="$( { echo "$OUT" | grep -o 'Applying migration `[^`]*`' || true; } | sed 's/Applying migration `//; s/`//' | tr '\n' ' ')"
  [ "$APPLIED" = "${BEFORE[*]} " ] || { echo "$OUT" | tail -20; echo "expected to apply: ${BEFORE[*]} — applied: $APPLIED"; exit 1; }
  [ "$(q "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '$RESV'")" = "0" ] || { echo "$RESV is already recorded"; exit 1; }
  echo "LAB READY: $DB (P4 + ${BEFORE[*]} applied; lab-only M0 value; $RESV pending)"
  exit 0
fi

case "$MODE" in
  --deploy-only) FAULT=no ;;
  --broken-deploy-only) FAULT=fault ;;
  *) echo "unknown mode $MODE"; exit 2 ;;
esac
T="$(mktemp -d)"; stage "$T" "$FAULT" "$RESV"; set +e; OUT="$(deploy "$T")"; rc=$?; set -e; rm -rf "$T"
echo "$OUT" | grep -E "Applying migration|have been successfully applied|No pending|Error|error|ERROR" | head -8
if [ "$FAULT" = fault ]; then
  [ $rc -ne 0 ] || { echo "the broken migration did NOT fail"; exit 1; }
  echo "LAB READY: $DB ($RESV FAILED on its last statement as intended)"; exit 0
fi
[ $rc -eq 0 ] || { echo "$RESV deploy failed"; exit 1; }
test "$(echo "$OUT" | grep -c 'Applying migration')" = "1" || { echo "more than one migration was applied"; exit 1; }
echo "$OUT" | grep -q "Applying migration \`$RESV\`" || { echo "$RESV was not applied"; exit 1; }
echo "LAB READY: $DB ($RESV applied)"
