#!/usr/bin/env bash
# Mutation test of 20261124090000_service_user_same_business_fix: each mutant weakens ONE rule of the fixed guard on a
# copy of <template> (the lab with the legacy rows seeded and the fix applied, the battery NOT yet run on it), then
# runs .sdusb/battery.ts there. Every mutant must be KILLED (the battery fails, naming the checks meant for it); a
# surviving mutant fails this script.
#
#   .sdusb/mutate.sh <template-db>
#
# Not a mutant: dropping `TG_OP = 'UPDATE'` from the exception is EQUIVALENT (on an INSERT old_row is NULL, so the
# unchanged-value condition is already false); it is kept in the text for the reader.
#
# env: PGHOST, PGPORT, SUPER, PGPASSWORD (the superuser's), LAB_PASSWORD. Synthetic only.
set -uo pipefail
DB="${1:?usage: mutate.sh <template-db>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
H="${PGHOST:-localhost}:${PGPORT:-5432}"
url() { echo "postgresql://$1:$2@$H/$3"; }
super() { psql -X -q -v ON_ERROR_STOP=1 -d postgres -U "$SUPER" -c "$1" >/dev/null; }
TSX="${TSX:-node node_modules/tsx/dist/cli.mjs}"

# replace_in <needle> <replacement>: the guard re-created with one text change (refused if the needle is not found)
replace_in() {
  cat <<SQL
DO \$m\$
DECLARE src text;
BEGIN
  SELECT prosrc INTO src FROM pg_proc WHERE oid = 'public.service_user_same_business()'::regprocedure;
  IF position(\$n\$$1\$n\$ IN src) = 0 THEN RAISE EXCEPTION 'mutation needle not found'; END IF;
  EXECUTE format('CREATE OR REPLACE FUNCTION public.service_user_same_business() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS %L',
                 replace(src, \$n\$$1\$n\$, \$n\$$2\$n\$));
END
\$m\$;
SQL
}
declare -a NAMES SQLS
add() { NAMES+=("$1"); SQLS+=("$2"); }
add "M1 no exception at all (the 20261112 behaviour: a user in two columns cannot be deleted)" \
  "$(replace_in "CONTINUE WHEN TG_OP = 'UPDATE'" "CONTINUE WHEN false AND TG_OP = 'UPDATE'")"
add "M2 the exception without the nested-trigger condition" "$(replace_in "AND pg_trigger_depth() > 1" "")"
add "M3 the exception at any trigger depth (> 0 instead of > 1)" "$(replace_in "pg_trigger_depth() > 1" "pg_trigger_depth() > 0")"
add "M4 the exception without the unchanged-value condition" "$(replace_in "AND (old_row ->> col)::integer = uid" "")"
add "M5 the exception without the user-missing condition" \
  "$(replace_in 'AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = uid);' ';')"
add "M6 'missing' read as 'not a user of THIS business' (a user of another business passes)" \
  "$(replace_in 'AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = uid);' 'AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = uid AND u."businessId" = NEW."businessId");')"
add "M7 any existing user passes (the business comparison dropped)" \
  "$(replace_in 'CONTINUE WHEN EXISTS (SELECT 1 FROM "User" u WHERE u."id" = uid AND u."businessId" = NEW."businessId");' 'CONTINUE WHEN EXISTS (SELECT 1 FROM "User" u WHERE u."id" = uid);')"
add "M8 only CHANGED columns are checked (an unchanged value is never re-judged)" \
  "$(replace_in "    CONTINUE WHEN uid IS NULL;" "    CONTINUE WHEN uid IS NULL;
    CONTINUE WHEN TG_OP = 'UPDATE' AND (old_row ->> col) IS NOT DISTINCT FROM (new_row ->> col);")"
add "M9 a mistyped column passes as NULL" "$(replace_in "IF NOT (new_row ? col) THEN" "IF false THEN")"
add "M10 the guard runs with the owner's rights (SECURITY DEFINER)" 'ALTER FUNCTION public.service_user_same_business() SECURITY DEFINER;'
add "M11 the quote's guard trigger dropped" 'DROP TRIGGER "ServiceQuote_user_same_business" ON "ServiceQuote";'
add "M12 the text's guard trigger checks INSERT only" 'DROP TRIGGER "ServiceTextVersion_user_same_business" ON "ServiceTextVersion";
CREATE TRIGGER "ServiceTextVersion_user_same_business" BEFORE INSERT ON "ServiceTextVersion"
  FOR EACH ROW EXECUTE FUNCTION public.service_user_same_business('"'createdByUserId'"', '"'legallyApprovedByUserId'"');'

killed=0; survived=0
for i in "${!NAMES[@]}"; do
  M="${DB}_mut$i"
  super "DROP DATABASE IF EXISTS $M"; super "CREATE DATABASE $M TEMPLATE $DB OWNER lab_owner"
  if ! printf '%s\n' "${SQLS[$i]}" | psql -X -q -v ON_ERROR_STOP=1 "$(url lab_owner "$LAB_PASSWORD" "$M")" >/dev/null 2>/tmp/sdusb-mut.err; then
    echo "  [ERROR] ${NAMES[$i]}: the mutant could not be built: $(tr -d '\r' </tmp/sdusb-mut.err | head -3)"; survived=$((survived+1)); super "DROP DATABASE $M"; continue
  fi
  OUT="$(OWNER_URL="$(url lab_owner "$LAB_PASSWORD" "$M")" RUNTIME_URL="$(url app_runtime_prod "$LAB_PASSWORD" "$M")" \
         SUPER_URL="$(url "$SUPER" "$PGPASSWORD" "$M")" $TSX "$ROOT/.sdusb/battery.ts" </dev/null 2>&1)"
  rc=$?
  failed="$(echo "$OUT" | tr -d '\r' | grep -oE '^\s+\[FAIL\] [A-Z][0-9]+' | awk '{print $2}' | tr '\n' ' ')"
  if [ $rc -ne 0 ] && [ -n "$failed" ]; then killed=$((killed+1)); echo "  [KILLED] ${NAMES[$i]} — failing: $failed"
  else survived=$((survived+1)); echo "  [SURVIVED] ${NAMES[$i]} (rc $rc) $(echo "$OUT" | tail -2 | tr '\n' ' ')"; fi
  super "DROP DATABASE $M"
done
echo
echo "$killed killed, $survived survived"
test "$survived" = "0"
