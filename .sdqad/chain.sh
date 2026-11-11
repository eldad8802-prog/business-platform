#!/usr/bin/env bash
# Service Desk QA track defaults — the application of migration 20261130100000 the way release-migrate.yml applies it:
# `prisma migrate deploy` over a staged directory = every migration the ledger already holds + this one. (Modelled on
# .sdqa/chain.sh.)
#
#   .sdqad/chain.sh <db>
#
# On the QA lists lab <db> (.sd3p4/lab.sh <db>, --deploy-only, .sdm1/chain.sh <db>, .sdqa/chain.sh <db>).
#   P  premise: on a copy WITHOUT the QA lists migration (rolled back by .sdqa/rollback.sql) it refuses, changes nothing.
#   F  fault: on a copy, the migration fails on its final statement → nothing of it exists; the ledger marks it failed;
#      `migrate resolve --rolled-back` + a clean deploy then applies it — the recovery procedure, proven.
#   A  apply: exactly this migration; nothing failed in the ledger; existing cases, events and lists unchanged.
#   R  rollback (on copies, after A): rollback.sql refuses while the table holds a row; on a clean copy it removes every
#      object of the migration and its ledger row; a plain deploy re-applies it.
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="${1:?usage: chain.sh <db>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LAB_PASSWORD="${LAB_PASSWORD:-sd_lab_pw}"
H="${PGHOST:-localhost}:${PGPORT:-5432}"
owner_url() { echo "postgresql://lab_owner:$LAB_PASSWORD@$H/$1"; }
super() { psql -X -q -v ON_ERROR_STOP=1 -d "${2:-postgres}" -U "$SUPER" -c "$1"; }
QD="20261130100000_service_qa_track_defaults"
QA="20261129090000_service_desk_qa_lists"

q() { psql -X -At "$(owner_url "$1")" -c "$2" | tr -d '\r'; }
stage() { # <target-dir> <db> [fault]: applied (from the ledger) + this migration; with "fault", it fails at its end
  local T="$1" db="$2" fault="${3:-}" n
  mkdir -p "$T/prisma/migrations"
  cp "$ROOT/prisma/schema.prisma" "$T/prisma/schema.prisma"
  cp "$ROOT/prisma/migrations/migration_lock.toml" "$T/prisma/migrations/"
  while read -r n; do
    [ -n "$n" ] || continue
    cp -r "$ROOT/prisma/migrations/$n" "$T/prisma/migrations/$n"
  done < <(q "$db" "SELECT migration_name FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")
  rm -rf "$T/prisma/migrations/$QD"; cp -r "$ROOT/prisma/migrations/$QD" "$T/prisma/migrations/$QD"
  if [ "$fault" = fault ]; then printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$T/prisma/migrations/$QD/migration.sql"; fi
}
deploy() { ( cd "$ROOT" && DATABASE_URL="$(owner_url "$2")" DIRECT_URL="$(owner_url "$2")" node_modules/.bin/prisma migrate deploy --schema "$1/prisma/schema.prisma" ) 2>&1 </dev/null; }
resolve_rb() { ( cd "$ROOT" && DATABASE_URL="$(owner_url "$2")" DIRECT_URL="$(owner_url "$2")" node_modules/.bin/prisma migrate resolve --rolled-back "$3" --schema "$1/prisma/schema.prisma" ) >/dev/null 2>&1 </dev/null; }
gone() { # <db>: nothing of the migration exists
  test "$(q "$1" "SELECT (to_regclass('public.\"ServiceQaTrackDefault\"') IS NULL
    AND to_regprocedure('public.service_qa_track_default_guard()') IS NULL
    AND to_regprocedure('public.service_qa_track_defaults_erase_business()') IS NULL
    AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname LIKE 'service\\_qa\\_track\\_%')
    AND NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname LIKE 'service\\_qa\\_track\\_%'))::text")" = "true"
}
present() { # <db>: the migration is in place
  test "$(q "$1" "SELECT (to_regclass('public.\"ServiceQaTrackDefault\"') IS NOT NULL
    AND to_regprocedure('public.service_qa_track_defaults_erase_business()') IS NOT NULL
    AND (SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'ServiceQaTrackDefault\\_%' AND NOT tgisinternal) = 3)::text")" = "true"
}
pass=0; fail=0
ok() { if eval "$2"; then pass=$((pass+1)); echo "  [PASS] $1"; else fail=$((fail+1)); echo "  [FAIL] $1"; fi; }

test "$(q "$DB" "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '$QA' AND finished_at IS NOT NULL")" = "1" \
  || { echo "the QA lists migration ($QA) is not applied on $DB — run .sdqa/chain.sh first"; exit 1; }

echo "P — the premise"
super "DROP DATABASE IF EXISTS ${DB}_noqa"; super "CREATE DATABASE ${DB}_noqa TEMPLATE $DB OWNER lab_owner"
psql -X -q -v ON_ERROR_STOP=1 "$(owner_url "${DB}_noqa")" -f "$ROOT/.sdqa/rollback.sql" >/dev/null
OUT="$(psql -X -q -v ON_ERROR_STOP=1 -1 "$(owner_url "${DB}_noqa")" -f "$ROOT/prisma/migrations/$QD/migration.sql" 2>&1 || true)"
ok "P1 without the QA lists migration it refuses (its premise) and changes nothing" 'echo "$OUT" | grep -q "SERVICE_QA_TRACK_DEFAULTS: the QA lists migration" && gone "${DB}_noqa"'
super "DROP DATABASE ${DB}_noqa"

echo "F — a failure inside the migration"
super "DROP DATABASE IF EXISTS ${DB}_fault"; super "CREATE DATABASE ${DB}_fault TEMPLATE $DB OWNER lab_owner"
T="$(mktemp -d)"; stage "$T" "${DB}_fault" fault; OUT="$(deploy "$T" "${DB}_fault" || true)"; rm -rf "$T"
ok "F1 the deploy reports the failure" 'echo "$OUT" | grep -q "division by zero"'
ok "F2 nothing of the failed migration exists (table, functions, policies)" 'gone "${DB}_fault"'
ok "F3 the ledger marks exactly that migration failed" \
  'test "$(q "${DB}_fault" "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '"'"'$QD'"'"' AND finished_at IS NULL AND rolled_back_at IS NULL")" = "1"'
T="$(mktemp -d)"; stage "$T" "${DB}_fault"; resolve_rb "$T" "${DB}_fault" "$QD"; OUT="$(deploy "$T" "${DB}_fault")"; rm -rf "$T"
ok "F4 recovery: resolve --rolled-back, then a clean deploy applies it" 'echo "$OUT" | grep -q "Applying migration \`$QD\`" && present "${DB}_fault"'
super "DROP DATABASE ${DB}_fault"

echo "A — the application"
SNAP="SELECT md5(coalesce(string_agg(t, '|' ORDER BY t), '')) FROM (SELECT to_jsonb(c)::text t FROM \"ServiceCase\" c UNION ALL SELECT to_jsonb(e)::text FROM \"ServiceCaseEvent\" e
  UNION ALL SELECT to_jsonb(l)::text FROM \"ServiceQaList\" l UNION ALL SELECT to_jsonb(v)::text FROM \"ServiceQaListEvent\" v) s"
BEFORE="$(psql -X -At "$(owner_url "$DB")" -c "SET row_security = off" -c "$SNAP" | tr -d '\r' | tail -1)"
T="$(mktemp -d)"; stage "$T" "$DB"; OUT="$(deploy "$T" "$DB")"; rm -rf "$T"
APPLIED="$(echo "$OUT" | grep -o 'Applying migration `[^`]*`' | sed 's/Applying migration `//; s/`//' | tr '\n' ' ')"
echo "  applied: $APPLIED"
ok "A1 exactly this migration was applied" 'test "$APPLIED" = "$QD "'
ok "A2 nothing failed or rolled back in the ledger" \
  'test "$(q "$DB" "SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL")" = "0"'
AFTER="$(psql -X -At "$(owner_url "$DB")" -c "SET row_security = off" -c "$SNAP" | tr -d '\r' | tail -1)"
ok "A3 existing cases, journal events, QA lists and their journal unchanged; the new table empty" \
  'test -n "$BEFORE" && test "$BEFORE" = "$AFTER" && test "$(psql -X -At "$(owner_url "$DB")" -c "SET row_security = off" -c "SELECT count(*) FROM \"ServiceQaTrackDefault\"" | tr -d "\r" | tail -1)" = "0"'
ok "A4 a second application by hand is refused (its premise: the table exists) and changes nothing" \
  '! psql -X -q -v ON_ERROR_STOP=1 -1 "$(owner_url "$DB")" -f "$ROOT/prisma/migrations/$QD/migration.sql" >/dev/null 2>&1 && present "$DB"'

echo "R — rollback script (on copies)"
super "DROP DATABASE IF EXISTS ${DB}_rbx"; super "CREATE DATABASE ${DB}_rbx TEMPLATE $DB OWNER lab_owner"
psql -X -q -v ON_ERROR_STOP=1 "$(owner_url "${DB}_rbx")" -f "$ROOT/.sdqad/fixture-one-default.sql" >/dev/null
RB="$(psql -X -q -v ON_ERROR_STOP=1 "$(owner_url "${DB}_rbx")" -f "$ROOT/.sdqad/rollback.sql" 2>&1 || true)"
ok "R1 the rollback refuses while the table holds a row (behind FORCE RLS, no tenant context), and changes nothing" 'echo "$RB" | grep -q ROLLBACK_REFUSED && present "${DB}_rbx"'
super "DROP DATABASE ${DB}_rbx"
super "DROP DATABASE IF EXISTS ${DB}_rb"; super "CREATE DATABASE ${DB}_rb TEMPLATE $DB OWNER lab_owner"
psql -X -q -v ON_ERROR_STOP=1 "$(owner_url "${DB}_rb")" -f "$ROOT/.sdqad/rollback.sql" >/dev/null
ok "R2 on a clean copy it removes every object of the migration" 'gone "${DB}_rb"'
ok "R3 its ledger row went with it; the QA lists migration stays" \
  'test "$(q "${DB}_rb" "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '"'"'$QD'"'"'")" = "0" && test "$(q "${DB}_rb" "SELECT to_regclass('"'"'public.\"ServiceQaList\"'"'"') IS NOT NULL")" = "t"'
T="$(mktemp -d)"; stage "$T" "${DB}_rb"; OUT="$(deploy "$T" "${DB}_rb")"; rm -rf "$T"
ok "R4 a plain deploy re-applies it" 'echo "$OUT" | grep -q "Applying migration \`$QD\`" && present "${DB}_rb"'
super "DROP DATABASE ${DB}_rb"

echo
echo "$pass passed, $fail failed"
test "$fail" = "0"
