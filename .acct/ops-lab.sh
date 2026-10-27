#!/usr/bin/env bash
# Migrations 20261107090000_accountant_ops_monitor, 20261107091000_accountant_delivery_complained and
# 20261107092000_accountant_ops_admin_read — lab proof on the Production-shaped accountant lab.
#
#   0. baseline = Production today: .acct/lab.sh --with-acct, the console's read role as Production has it (app_admin
#      NOLOGIN group with schema USAGE, a LOGIN member), then 20261105090000_accountant_link_events applied by
#      `prisma migrate deploy`. Every further lab database is a copy of it (CREATE DATABASE … TEMPLATE).
#   1. baseline: the PREFLIGHT passes whole, the proof refuses; .acct/ops-db-battery.ts PHASE=before;
#   2. the three applied by `prisma migrate deploy` over the lab's ledger (the release-migrate mechanism, exactly
#      these three pending): the proof passes whole, the preflight fails exactly its "not there yet" checks
#      (4 5 6 7 8); then the battery PHASE=after as the real roles (runtime, console, owner);
#   3. atomicity: each of the three failing on its last statement leaves nothing of itself behind;
#   4. rollback: refused while rows exist; on a fresh copy, C → B → A restores the baseline catalog exactly.
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD. Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LE="20261105090000_accountant_link_events"
A="20261107090000_accountant_ops_monitor"
B="20261107091000_accountant_delivery_complained"
C="20261107092000_accountant_ops_admin_read"
P="${LAB_PASSWORD:-}"
url() { echo "postgresql://$1${P:+:$P}@${PGHOST}:${PGPORT}/$2"; }
owner_sql() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$(url lab_owner "$1")" "${@:2}"; }
super_sql() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q -U "$SUPER" -d "$1" "${@:2}"; }
pending() { case "$1" in "$LE"|"$A"|"$B"|"$C") return 0 ;; *) return 1 ;; esac; }

# `prisma migrate deploy` of every migration up to $2: the four above run (those not applied yet), every other one
# is recorded as applied first (as lab.sh does). $3, optional: the migration that fails on its last statement.
deploy() {
  local db="$1" upto="$2" broken="${3:-}" tmp ledger; tmp="$(mktemp -d)"; mkdir -p "$tmp/prisma/migrations"
  cp "$ROOT/prisma/schema.prisma" "$tmp/prisma/schema.prisma"
  cp "$ROOT/prisma/migrations/migration_lock.toml" "$tmp/prisma/migrations/"
  ledger="$(mktemp)"
  for d in "$ROOT"/prisma/migrations/*/; do
    local n; n="$(basename "$d")"
    [[ "$n" > "$upto" ]] && continue
    cp -r "$d" "$tmp/prisma/migrations/$n"
    pending "$n" && continue
    echo "INSERT INTO \"_prisma_migrations\" (id, checksum, finished_at, migration_name, applied_steps_count)
          SELECT gen_random_uuid()::text, '$(sha256sum "$d/migration.sql" | cut -d' ' -f1)', now(), '$n', 1
          WHERE NOT EXISTS (SELECT 1 FROM \"_prisma_migrations\" WHERE migration_name = '$n');" >> "$ledger"
  done
  owner_sql "$db" -f "$ledger"; rm -f "$ledger"
  [ -n "$broken" ] && printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$tmp/prisma/migrations/$broken/migration.sql"
  set +e
  ( cd "$ROOT" && DATABASE_URL="$(url lab_owner "$db")" DIRECT_URL="$(url lab_owner "$db")" node_modules/.bin/prisma migrate deploy --schema "$tmp/prisma/schema.prisma" ) > "$tmp/deploy.log" 2>&1
  local rc=$?; set -e
  grep -E "migrations found|Applying migration|successfully applied|No pending|Error" "$tmp/deploy.log" | head -6
  rm -rf "$tmp"; return $rc
}
copy_of() { super_sql postgres -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1 TEMPLATE ops_base OWNER lab_owner"; }
battery() {
  OWNER_URL="$(url lab_owner "$1")" RUNTIME_URL="$(url app_runtime_prod "$1")" ADMIN_URL="$(url app_admin_lab "$1")" \
    PHASE="$2" SHAPE_BEFORE="${3:-}" npx tsx "$ROOT/.acct/ops-db-battery.ts"
}
PREFLIGHT="$ROOT/ops/evidence/accountant-ops-preflight.sql"
EVIDENCE="$ROOT/ops/evidence/accountant-ops-production-evidence.sql"
fails_of() { owner_sql "$1" -f "$2" 2>/dev/null | { grep -E '^ +[0-9]+ \| FAIL' || true; } | awk -F'|' '{print $1}' | tr -d ' ' | tr '\n' ' '; }
passes_of() { owner_sql "$1" -f "$2" 2>/dev/null | grep -cE '^ +[0-9]+ \| PASS' || true; }
# The catalog the three migrations may touch: tables, the trail's type list, accountant policies, grants to app_admin.
catalog() {
  owner_sql "$1" -At -c "
    SELECT (SELECT string_agg(relname, ',' ORDER BY relname) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname LIKE 'Accountant%'),
           (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'AccountantWorkflowEvent_type'),
           (SELECT string_agg(tablename || ':' || policyname, ',' ORDER BY tablename, policyname) FROM pg_policies WHERE tablename LIKE 'Accountant%'),
           (SELECT count(*) FROM information_schema.role_table_grants WHERE grantee = 'app_admin' AND table_name LIKE 'Accountant%'),
           (SELECT string_agg(migration_name, ',' ORDER BY migration_name) FROM \"_prisma_migrations\" WHERE migration_name >= '$A' AND finished_at IS NOT NULL)"
}

echo "== 0. baseline = Production today"
bash "$ROOT/.acct/lab.sh" ops_base --with-acct | tail -1
# schema.prisma may model the monitoring tables (the application PR): `db push` inside the base lab then built them
# without the migration's checks, indexes, RLS and grants. They are removed so the migration builds them as in Production.
owner_sql ops_base -c 'DROP TABLE IF EXISTS "AccountantBusinessAlert", "AccountantOpsAlert", "AccountantOpsRun" CASCADE'
super_sql ops_base <<SQL
DO \$do\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin') THEN
    CREATE ROLE app_admin NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin_lab') THEN
    CREATE ROLE app_admin_lab LOGIN NOSUPERUSER NOBYPASSRLS ${P:+PASSWORD '$P'} IN ROLE app_admin;
  END IF;
END
\$do\$;
GRANT USAGE ON SCHEMA public TO app_admin;
SQL
deploy ops_base "$LE"
[ "$(owner_sql ops_base -At -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '$LE' AND finished_at IS NOT NULL")" = "1" ] \
  || { echo "the link events migration is not applied on the baseline"; exit 1; }
BASE_CATALOG="$(catalog ops_base)"
copy_of ops_main; copy_of ops_broken_a; copy_of ops_broken_b; copy_of ops_broken_c; copy_of ops_rb

echo "== 1. baseline: preflight whole, the proof refuses"
f="$(fails_of ops_main "$PREFLIGHT")"; n="$(passes_of ops_main "$PREFLIGHT")"
[ -z "$f" ] && [ "$n" = "11" ] && echo "preflight: 11/11 PASS on the baseline" || { echo "preflight on the baseline: $n PASS, failing: $f"; exit 1; }
[ "$(passes_of ops_main "$EVIDENCE")" = "17" ] && { echo "the proof passed before the migrations"; exit 1; }
echo "the proof refuses on the baseline"
out="$(battery ops_main before)"; echo "$out" | grep -E "PASS|FAIL|passed"
shape="$(echo "$out" | sed -n 's/^SHAPE=//p')"
echo "$out" | grep -q " 0 failed" || exit 1

echo "== 2. migrate deploy (exactly the three pending), then the battery"
deploy ops_main "$C"
applied="$(owner_sql ops_main -At -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name IN ('$A', '$B', '$C') AND finished_at IS NOT NULL")"
[ "$applied" = "3" ] || { echo "not all three are recorded as applied ($applied)"; exit 1; }
f="$(fails_of ops_main "$EVIDENCE")"; n="$(passes_of ops_main "$EVIDENCE")"
[ -z "$f" ] && [ "$n" = "17" ] && echo "proof: 17/17 PASS after the release" || { echo "the proof after the release: $n PASS, failing: $f"; owner_sql ops_main -f "$EVIDENCE"; exit 1; }
f="$(fails_of ops_main "$PREFLIGHT")"; [ "$f" = "4 5 6 7 8 " ] && echo "preflight after the release fails exactly 4 5 6 7 8" || { echo "preflight after: expected '4 5 6 7 8 ', got '$f'"; exit 1; }
battery ops_main after "$shape"

echo "== 3. atomicity"
if deploy ops_broken_a "$C" "$A"; then echo "the broken $A did NOT fail"; exit 1; fi
[ "$(owner_sql ops_broken_a -At -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '$A' AND finished_at IS NULL")" = "1" ]   && echo "$A failing: recorded by the release as FAILED (not finished) — release-migrate stops there" || { echo "$A failing: no failed ledger row"; exit 1; }
[ "$(catalog ops_broken_a)" = "$BASE_CATALOG" ] && echo "$A failing: nothing of it (or after it) exists" || { echo "$A failing left changes"; exit 1; }
if deploy ops_broken_b "$C" "$B"; then echo "the broken $B did NOT fail"; exit 1; fi
tb="$(owner_sql ops_broken_b -At -c "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'AccountantWorkflowEvent_type'")"
ta="$(owner_sql ops_base -At -c "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'AccountantWorkflowEvent_type'")"
[ "$tb" = "$ta" ] && [ "$(owner_sql ops_broken_b -At -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '$B' AND finished_at IS NOT NULL")" = "0" ] \
  && echo "$B failing: the 2026-11-05 type list is intact, $B not recorded as applied" || { echo "$B failing changed the constraint"; exit 1; }
if deploy ops_broken_c "$C" "$C"; then echo "the broken $C did NOT fail"; exit 1; fi
adm="$(owner_sql ops_broken_c -At -c "SELECT (SELECT count(*) FROM pg_policies WHERE tablename = 'AccountantBusinessAlert' AND policyname = 'p7adm_read') + (SELECT count(*) FROM information_schema.role_table_grants WHERE grantee = 'app_admin' AND table_name LIKE 'Accountant%')")"
[ "$adm" = "0" ] && echo "$C failing: no admin policy, no admin grant" || { echo "$C failing left $adm admin items"; exit 1; }

echo "== 4. rollback"
if owner_sql ops_main -f "$ROOT/.acct/ops-rollback.sql" 2>/dev/null; then echo "the ops rollback ran while rows exist"; exit 1; fi
echo "the ops rollback is refused while the monitoring tables hold rows"
if owner_sql ops_main -f "$ROOT/.acct/complained-rollback.sql" 2>/dev/null; then echo "the complaint rollback ran while a complaint exists"; exit 1; fi
echo "the complaint rollback is refused while a complaint is recorded"
deploy ops_rb "$C" >/dev/null
owner_sql ops_rb -f "$ROOT/.acct/ops-admin-read-rollback.sql"
owner_sql ops_rb -f "$ROOT/.acct/complained-rollback.sql"
owner_sql ops_rb -f "$ROOT/.acct/ops-rollback.sql"
[ "$(catalog ops_rb)" = "$BASE_CATALOG" ] && echo "rollback C → B → A restores the baseline catalog exactly" || { echo "rollback differs: $(catalog ops_rb)"; exit 1; }
echo "ACCOUNTANT OPS LAB: PASS"
