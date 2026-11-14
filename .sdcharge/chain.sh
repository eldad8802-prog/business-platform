#!/usr/bin/env bash
# Service Desk — the application chain of the pending migrations, the way release-migrate.yml applies them:
# `prisma migrate deploy` over a staged directory = every migration the ledger already holds + the approved prefix.
#
#   .sdcharge/chain.sh <db> [extra-migration-dir ...]
#
# On the P4 lab <db> (.sd3p4/lab.sh <db> then --deploy-only). The approved prefix is: the extra dirs given (e.g. #1061's
# 20261123090000, from its branch), then 20261125090000 (#1096), then 20261126090000 (this track), in name order.
#   F  fault: on a copy, the last migration fails on its final statement → nothing of it exists (one implicit
#      transaction: no table, no type, no enum value, no CHECK), the ledger marks it failed; `migrate resolve
#      --rolled-back` + a clean deploy then applies it — the recovery procedure, proven.
#   A  apply: exactly the prefix, in order, each once; nothing failed in the ledger.
#   R  rollback (on a copy, after A): rollback-1104.sql removes every object of 20261126090000 and its ledger row; a
#      plain deploy re-applies it; rollback-1096.sql restores the original handover CHECKs (valid: no handover rows).
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="${1:?usage: chain.sh <db> [extra-migration-dir ...]}"; shift
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LAB_PASSWORD="${LAB_PASSWORD:-sd_lab_pw}"
H="${PGHOST:-localhost}:${PGPORT:-5432}"
owner_url() { echo "postgresql://lab_owner:$LAB_PASSWORD@$H/$1"; }
super() { psql -X -q -v ON_ERROR_STOP=1 -d "${2:-postgres}" -U "$SUPER" -c "$1"; }
HANDOVER="20261125090000_service_desk_handover_owner_confirmed"
CHARGE="20261126090000_service_desk_case_charge"
PREFIX=("$@" "$ROOT/prisma/migrations/$HANDOVER" "$ROOT/prisma/migrations/$CHARGE")

stage() { # <target-dir> [fault]: applied (from the ledger) + the prefix; with "fault", the last one fails at its end
  local T="$1" db="$2" fault="${3:-}"
  mkdir -p "$T/prisma/migrations"
  cp "$ROOT/prisma/schema.prisma" "$T/prisma/schema.prisma"
  cp "$ROOT/prisma/migrations/migration_lock.toml" "$T/prisma/migrations/"
  local src
  while read -r n; do
    [ -n "$n" ] || continue
    src="$ROOT/prisma/migrations/$n"
    for d in "${PREFIX[@]}"; do [ "$(basename "$d")" = "$n" ] && src="$d"; done
    cp -r "$src" "$T/prisma/migrations/$n"
  done \
    < <(q "$db" "SELECT migration_name FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")
  for d in "${PREFIX[@]}"; do cp -r "$d" "$T/prisma/migrations/$(basename "$d")"; done
  if [ "$fault" = fault ]; then printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$T/prisma/migrations/$CHARGE/migration.sql"; fi
}
deploy() { ( cd "$ROOT" && DATABASE_URL="$(owner_url "$2")" DIRECT_URL="$(owner_url "$2")" node_modules/.bin/prisma migrate deploy --schema "$1/prisma/schema.prisma" ) 2>&1; }
resolve_rb() { ( cd "$ROOT" && DATABASE_URL="$(owner_url "$2")" DIRECT_URL="$(owner_url "$2")" node_modules/.bin/prisma migrate resolve --rolled-back "$3" --schema "$1/prisma/schema.prisma" ) >/dev/null 2>&1; }
q() { psql -X -At "$(owner_url "$1")" -c "$2" | tr -d '\r'; }
gone() { # <db>: nothing of 20261126090000 exists
  test "$(q "$1" "SELECT (to_regclass('public.\"ServiceCaseCharge\"') IS NULL AND to_regclass('public.\"ServiceCaseBillingLink\"') IS NULL
    AND to_regtype('\"ServiceChargeMode\"') IS NULL AND to_regprocedure('public.service_case_charge_erase_business()') IS NULL
    AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ServiceCaseEvent_charge_in_place'))::text")" = "true"
}
pass=0; fail=0
ok() { if eval "$2"; then pass=$((pass+1)); echo "  [PASS] $1"; else fail=$((fail+1)); echo "  [FAIL] $1"; fi; }

echo "F — a failure inside the migration"
super "DROP DATABASE IF EXISTS ${DB}_fault"; super "CREATE DATABASE ${DB}_fault TEMPLATE $DB OWNER lab_owner"
T="$(mktemp -d)"; stage "$T" "${DB}_fault" fault; OUT="$(deploy "$T" "${DB}_fault" || true)"; rm -rf "$T"
ok "F1 the deploy reports the failure" 'echo "$OUT" | grep -q "division by zero"'
ok "F2 nothing of the failed migration exists (no table, type, function, CHECK)" 'gone "${DB}_fault"'
ok "F3 not even its new journal enum values (one implicit transaction)" \
  'test "$(q "${DB}_fault" "SELECT count(*) FROM pg_enum WHERE enumlabel IN ('"'"'charge.recorded'"'"', '"'"'RECORD_CHARGE'"'"')")" = "0"'
ok "F4 the ledger marks exactly that migration failed" \
  'test "$(q "${DB}_fault" "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '"'"'$CHARGE'"'"' AND finished_at IS NULL AND rolled_back_at IS NULL")" = "1"'
T="$(mktemp -d)"; stage "$T" "${DB}_fault"; resolve_rb "$T" "${DB}_fault" "$CHARGE"; OUT="$(deploy "$T" "${DB}_fault")"; rm -rf "$T"
ok "F5 recovery: resolve --rolled-back, then a clean deploy applies it" 'echo "$OUT" | grep -q "Applying migration \`$CHARGE\`" && ! gone "${DB}_fault"'
super "DROP DATABASE ${DB}_fault"

echo "A — the chain, in order"
T="$(mktemp -d)"; stage "$T" "$DB"; OUT="$(deploy "$T" "$DB")"; rm -rf "$T"
APPLIED="$(echo "$OUT" | grep -o 'Applying migration `[^`]*`' | sed 's/Applying migration `//; s/`//' | tr '\n' ' ')"
EXPECTED="$(for d in "${PREFIX[@]}"; do basename "$d"; done | sort | tr '\n' ' ')"
echo "  applied: $APPLIED"
ok "A1 exactly the approved prefix was applied, in name order" 'test "$APPLIED" = "$EXPECTED"'
ok "A2 nothing failed or rolled back in the ledger" \
  'test "$(q "$DB" "SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL")" = "0"'
ok "A3 existing data unchanged: no row in the new tables, handover rows untouched" \
  'test "$(q "$DB" "SELECT (SELECT count(*) FROM \"ServiceCaseCharge\") + (SELECT count(*) FROM \"ServiceCaseBillingLink\")")" = "0"'

echo "R — rollback scripts (on a copy)"
super "DROP DATABASE IF EXISTS ${DB}_rb"; super "CREATE DATABASE ${DB}_rb TEMPLATE $DB OWNER lab_owner"
psql -X -q -v ON_ERROR_STOP=1 "$(owner_url "${DB}_rb")" -f "$ROOT/.sdcharge/rollback-1104.sql"
ok "R1 rollback-1104 removes every object of the charge migration" 'gone "${DB}_rb"'
T="$(mktemp -d)"; stage "$T" "${DB}_rb"; OUT="$(deploy "$T" "${DB}_rb")"; rm -rf "$T"
ok "R2 the ledger row went with it: a plain deploy re-applies it (the leftover enum values are skipped)" 'echo "$OUT" | grep -q "Applying migration \`$CHARGE\`" && ! gone "${DB}_rb"'
psql -X -q -v ON_ERROR_STOP=1 "$(owner_url "${DB}_rb")" -f "$ROOT/.sdcharge/rollback-1096.sql"
ok "R3 rollback-1096 restores the original handover CHECKs" \
  'test "$(q "${DB}_rb" "SELECT count(*) FROM pg_constraint WHERE conname IN ('"'"'ServiceHandover_signed'"'"', '"'"'ServiceHandover_receiver'"'"')")" = "2"'
super "DROP DATABASE ${DB}_rb"

echo
echo "$pass passed, $fail failed"
test "$fail" = "0"
