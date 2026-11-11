#!/usr/bin/env bash
# Mutation test of the reservation guard: each mutant weakens ONE rule of 20261128090000 on a copy of the applied lab
# <db> (.sdresv/lab.sh <db> + --deploy-only), then runs .sdresv/battery.ts on it. Every mutant must be KILLED (the
# battery fails, naming the checks meant for it); a surviving mutant fails this script.
#
#   .sdresv/mutate.sh <db>
#
# env: PGHOST, PGPORT, SUPER, PGPASSWORD (the superuser's), LAB_PASSWORD. Synthetic only.
set -uo pipefail
DB="${1:?usage: mutate.sh <db>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
H="${PGHOST:-localhost}:${PGPORT:-5432}"
url() { echo "postgresql://$1:$LAB_PASSWORD@$H/$2"; }
super() { psql -X -q -v ON_ERROR_STOP=1 -d postgres -U "$SUPER" -c "$1" >/dev/null; }
TSX="${TSX:-node node_modules/tsx/dist/cli.mjs}"

# replace_in <function> <needle> <replacement>: the function re-created with one text change (refused if not found)
replace_in() {
  cat <<SQL
DO \$m\$
DECLARE src text;
BEGIN
  SELECT prosrc INTO src FROM pg_proc WHERE proname = '$1' AND pronamespace = 'public'::regnamespace;
  IF src IS NULL OR position(\$n\$$2\$n\$ IN src) = 0 THEN RAISE EXCEPTION 'mutation needle not found in $1'; END IF;
  EXECUTE format('CREATE OR REPLACE FUNCTION public.$1() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS %L',
                 replace(src, \$n\$$2\$n\$, \$n\$$3\$n\$));
END
\$m\$;
SQL
}
G2_WHEN='AFTER UPDATE OF "state" ON "ServicePart" FOR EACH ROW'
declare -a NAMES SQLS
add() { NAMES+=("$1"); SQLS+=("$2"); }
add "M1 G1 trigger dropped" 'DROP TRIGGER "ServiceCase_parts_released_on_cancel" ON "ServiceCase";'
add "M2 G2 trigger dropped" 'DROP TRIGGER "ServicePart_takes_stock_on_live_case" ON "ServicePart";'
add "M3 G1 immediate instead of deferred" 'DROP TRIGGER "ServiceCase_parts_released_on_cancel" ON "ServiceCase";
CREATE CONSTRAINT TRIGGER "ServiceCase_parts_released_on_cancel" AFTER UPDATE OF "outcome", "cancellationRequested" ON "ServiceCase"
  NOT DEFERRABLE FOR EACH ROW WHEN (NEW."outcome"::text = '"'CANCELLED'"' OR NEW."cancellationRequested")
  EXECUTE FUNCTION public.service_case_parts_released_on_cancel();'
add "M4 G2 ignores a cancelled case" "$(replace_in service_part_takes_stock_guard "IF c.outcome IS NOT DISTINCT FROM 'CANCELLED' OR c.requested THEN" "IF false THEN")"
add "M5 G2 without the quantity check" "$(replace_in service_part_takes_stock_guard "IF v_on_hand IS NULL OR v_reserved > v_on_hand + 1e-9 THEN" "IF false THEN")"
add "M6 G2 without the item advisory lock" "$(replace_in service_part_takes_stock_guard 'PERFORM pg_advisory_xact_lock(1396986454, NEW."inventoryItemId");' "")"
add "M7 G1 also counts consumed (ISSUED) lines" "$(replace_in service_case_parts_released_on_cancel "p.\"state\" = 'RESERVED'" "p.\"state\" IN ('RESERVED', 'ISSUED')")"
add "M8 G1 ignores a cancel REQUESTED at a supplier" "$(replace_in service_case_parts_released_on_cancel "IS NOT DISTINCT FROM 'CANCELLED' OR c.requested)" "IS NOT DISTINCT FROM 'CANCELLED')")"
add "M9 G2 quantity off by one (the last unit refused)" "$(replace_in service_part_takes_stock_guard "v_reserved > v_on_hand + 1e-9" "v_reserved >= v_on_hand")"
add "M10 G2 watches RESERVED only (an issue after a cancel passes)" 'DROP TRIGGER "ServicePart_takes_stock_on_live_case" ON "ServicePart";
CREATE TRIGGER "ServicePart_takes_stock_on_live_case" '"$G2_WHEN"'
  WHEN (NEW."state" = '"'RESERVED'"' AND NEW."state" IS DISTINCT FROM OLD."state")
  EXECUTE FUNCTION public.service_part_takes_stock_guard();'

killed=0; survived=0
for i in "${!NAMES[@]}"; do
  M="${DB}_mut$i"
  super "DROP DATABASE IF EXISTS $M"; super "CREATE DATABASE $M TEMPLATE $DB OWNER lab_owner"
  if ! printf '%s\n' "${SQLS[$i]}" | psql -X -q -v ON_ERROR_STOP=1 "$(url lab_owner "$M")" >/dev/null 2>/tmp/sdresv-mut.err; then
    echo "  [ERROR] ${NAMES[$i]}: the mutant could not be built: $(tr -d '\r' </tmp/sdresv-mut.err | head -3)"; survived=$((survived+1)); super "DROP DATABASE $M"; continue
  fi
  OUT="$(OWNER_URL="$(url lab_owner "$M")" RUNTIME_URL="$(url app_runtime_prod "$M")" $TSX "$ROOT/.sdresv/battery.ts" </dev/null 2>&1)"
  rc=$?
  failed="$(echo "$OUT" | tr -d '\r' | grep -oE '^\s+\[FAIL\] [A-Z][0-9]+' | awk '{print $2}' | tr '\n' ' ')"
  if [ $rc -ne 0 ] && [ -n "$failed" ]; then killed=$((killed+1)); echo "  [KILLED] ${NAMES[$i]} — failing: $failed"
  else survived=$((survived+1)); echo "  [SURVIVED] ${NAMES[$i]} (rc $rc) $(echo "$OUT" | tail -2 | tr '\n' ' ')"; fi
  super "DROP DATABASE $M"
done
echo
echo "$killed killed, $survived survived"
test "$survived" = "0"
