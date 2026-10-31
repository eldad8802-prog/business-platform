#!/usr/bin/env bash
# Migrations 20261109090000_accountant_delivery_permission (G5 M4) and 20261109091000_accountant_link_otp (G5 M5) —
# lab proof on the Production-shaped accountant lab.
#
#   0. baseline = Production today: .acct/lab.sh --with-acct, the console's read role as Production has it, then the
#      link events and the three G5 M1 migrations applied by `prisma migrate deploy`. Every further lab database is a
#      copy of it (CREATE DATABASE … TEMPLATE). M45_BASE_TEMPLATE=<db> reuses an existing "Production today" baseline.
#   1. baseline: the PREFLIGHT passes whole, the proof refuses; .acct/m45-db-battery.ts PHASE=before;
#   2. the two applied by `prisma migrate deploy` over the lab's ledger (the release-migrate mechanism, exactly these two
#      pending): the proof passes whole, the preflight fails exactly its "not there yet" checks (4 5 6 7 8 9); then the
#      battery PHASE=after as the real roles (runtime, console, owner);
#   3. atomicity: each of the two failing on its last statement leaves nothing of itself behind;
#   4. rollback: refused while rows exist; on a fresh copy, M5 → M4 restores the baseline catalog exactly.
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD. Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LE="20261105090000_accountant_link_events"
G5C="20261107092000_accountant_ops_admin_read"
M4="20261109090000_accountant_delivery_permission"
M5="20261109091000_accountant_link_otp"
P="${LAB_PASSWORD:-}"
url() { echo "postgresql://$1${P:+:$P}@${PGHOST}:${PGPORT}/$2"; }
owner_sql() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$(url lab_owner "$1")" "${@:2}"; }
super_sql() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q -U "$SUPER" -d "$1" "${@:2}"; }
pending() { case "$1" in "$LE"|2026110709*|"$M4"|"$M5") return 0 ;; *) return 1 ;; esac; }

# `prisma migrate deploy` of every migration up to $2: the pending ones above run (those not applied yet), every other
# one is recorded as applied first (as lab.sh does). $3, optional: the migration that fails on its last statement.
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
copy_of() { super_sql postgres -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1 TEMPLATE $BASE OWNER lab_owner"; }
battery() {
  OWNER_URL="$(url lab_owner "$1")" RUNTIME_URL="$(url app_runtime_prod "$1")" ADMIN_URL="$(url app_admin_lab "$1")" \
    PHASE="$2" SHAPE_BEFORE="${3:-}" npx tsx "$ROOT/.acct/m45-db-battery.ts"
}
PREFLIGHT="$ROOT/ops/evidence/accountant-m4m5-preflight.sql"
EVIDENCE="$ROOT/ops/evidence/accountant-m4m5-production-evidence.sql"
fails_of() { owner_sql "$1" -f "$2" 2>/dev/null | { grep -E '^ +[0-9]+ \| FAIL' || true; } | awk -F'|' '{print $1}' | tr -d ' ' | tr '\n' ' '; }
passes_of() { owner_sql "$1" -f "$2" 2>/dev/null | grep -cE '^ +[0-9]+ \| PASS' || true; }
catalog() {
  owner_sql "$1" -At -c "
    SELECT (SELECT string_agg(relname, ',' ORDER BY relname) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname LIKE 'Accountant%'),
           (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'AccountantWorkflowEvent_type'),
           (SELECT string_agg(tablename || ':' || policyname, ',' ORDER BY tablename, policyname) FROM pg_policies WHERE tablename LIKE 'Accountant%'),
           (SELECT count(*) FROM \"PlatformFeatureDefinition\" WHERE \"key\" = 'accountant_delivery') + (SELECT count(*) FROM \"PlatformFeaturePolicy\" WHERE \"featureKey\" = 'accountant_delivery'),
           (SELECT string_agg(migration_name, ',' ORDER BY migration_name) FROM \"_prisma_migrations\" WHERE migration_name >= '$M4' AND finished_at IS NOT NULL)"
}

echo "== 0. baseline = Production today"
if [ -n "${M45_BASE_TEMPLATE:-}" ]; then
  BASE="$M45_BASE_TEMPLATE"; echo "reusing $BASE"
else
  BASE=m45_base
  bash "$ROOT/.acct/lab.sh" "$BASE" --with-acct | tail -1
  # db push may build tables that later migrations own: they are removed so the migrations build them as in Production.
  owner_sql "$BASE" -c 'DROP TABLE IF EXISTS "AccountantBusinessAlert", "AccountantOpsAlert", "AccountantOpsRun", "AccountantLinkChallenge", "AccountantLinkDevice" CASCADE'
  super_sql "$BASE" <<SQL
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
  deploy "$BASE" "$G5C"
fi
[ "$(owner_sql "$BASE" -At -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name IN ('$LE', '20261107090000_accountant_ops_monitor', '20261107091000_accountant_delivery_complained', '$G5C') AND finished_at IS NOT NULL")" = "4" ] \
  || { echo "the baseline is not Production today (link events + G5 M1 applied)"; exit 1; }
BASE_CATALOG="$(catalog "$BASE")"
copy_of m45_main; copy_of m45_broken_4; copy_of m45_broken_5; copy_of m45_rb

echo "== 1. baseline: preflight whole, the proof refuses"
f="$(fails_of m45_main "$PREFLIGHT")"; n="$(passes_of m45_main "$PREFLIGHT")"
[ -z "$f" ] && [ "$n" = "11" ] && echo "preflight: 11/11 PASS on the baseline" || { echo "preflight on the baseline: $n PASS, failing: $f"; owner_sql m45_main -f "$PREFLIGHT"; exit 1; }
[ "$(passes_of m45_main "$EVIDENCE")" = "15" ] && { echo "the proof passed before the migrations"; exit 1; }
echo "the proof refuses on the baseline"
out="$(battery m45_main before)"; echo "$out" | grep -E "PASS|FAIL|passed"
shape="$(echo "$out" | sed -n 's/^SHAPE=//p')"
echo "$out" | grep -q " 0 failed" || exit 1

echo "== 2. migrate deploy (exactly the two pending), then the battery"
deploy m45_main "$M5"
applied="$(owner_sql m45_main -At -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name IN ('$M4', '$M5') AND finished_at IS NOT NULL")"
[ "$applied" = "2" ] || { echo "not both are recorded as applied ($applied)"; exit 1; }
f="$(fails_of m45_main "$EVIDENCE")"; n="$(passes_of m45_main "$EVIDENCE")"
[ -z "$f" ] && [ "$n" = "15" ] && echo "proof: 15/15 PASS after the release" || { echo "the proof after the release: $n PASS, failing: $f"; owner_sql m45_main -f "$EVIDENCE"; exit 1; }
f="$(fails_of m45_main "$PREFLIGHT")"; [ "$f" = "4 5 6 7 8 9 " ] && echo "preflight after the release fails exactly 4 5 6 7 8 9" || { echo "preflight after: expected '4 5 6 7 8 9 ', got '$f'"; exit 1; }
battery m45_main after "$shape"

echo "== 3. atomicity"
if deploy m45_broken_4 "$M5" "$M4"; then echo "the broken $M4 did NOT fail"; exit 1; fi
[ "$(catalog m45_broken_4)" = "$BASE_CATALOG" ] && echo "$M4 failing: nothing of it (or after it) exists" || { echo "$M4 failing left changes"; exit 1; }
if deploy m45_broken_5 "$M5" "$M5"; then echo "the broken $M5 did NOT fail"; exit 1; fi
t5="$(owner_sql m45_broken_5 -At -c "SELECT (SELECT count(*) FROM pg_class WHERE relname IN ('AccountantLinkChallenge', 'AccountantLinkDevice')) || ':' || (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'AccountantWorkflowEvent_type')")"
tb="$(owner_sql "$BASE" -At -c "SELECT '0:' || (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'AccountantWorkflowEvent_type')")"
[ "$t5" = "$tb" ] && echo "$M5 failing: no table of it, the 2026-11-07 type list intact" || { echo "$M5 failing left changes"; exit 1; }

echo "== 4. rollback"
if owner_sql m45_main -f "$ROOT/.acct/m5-rollback.sql" 2>/dev/null; then echo "the M5 rollback ran while rows exist"; exit 1; fi
echo "the M5 rollback is refused while codes or devices exist"
deploy m45_rb "$M5" >/dev/null
owner_sql m45_rb -f "$ROOT/.acct/m5-rollback.sql"
owner_sql m45_rb -f "$ROOT/.acct/m4-rollback.sql"
[ "$(catalog m45_rb)" = "$BASE_CATALOG" ] && echo "rollback M5 → M4 restores the baseline catalog exactly" || { echo "rollback differs: $(catalog m45_rb)"; exit 1; }
echo "ACCOUNTANT M4 + M5 LAB: PASS"
