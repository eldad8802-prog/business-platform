#!/usr/bin/env bash
# Service Desk loans (migration 20261201090000) — the application chain the way release-migrate.yml applies it
# (`prisma migrate deploy` over a staged directory = every migration the ledger holds + this one). (Modelled on
# .sdhov/chain.sh.)
#
#   .sdloan/chain.sh <db>     on the handover-record lab: .sd3p4/lab.sh <db>, --deploy-only, .sdm1/chain.sh <db>,
#                             .sdhov/chain.sh <db>
#
#   F  fault: on a copy, the migration fails on its final statement → nothing of it exists; the ServiceCase /
#      ServiceHandover triggers and every Service Desk function are byte-identical to before; the ledger marks it failed;
#      resolve --rolled-back + deploy recovers.
#   P  premise: over a chain without the handover record (20261130090000 rolled back) the migration refuses, nothing exists.
#   A  apply: exactly this migration; nothing failed; every existing case / event / handover row byte-identical —
#      including version-2 handovers written before it WITH a loaner exception and no loan (.sdloan/seed-v2-loaner.sql:
#      the new handover rule judges new rows only, existing data never blocks the migration).
#   S  a second application by hand is refused by the premise and changes nothing.
#   R  rollback (copies): refuses while a loan exists; on a clean copy it removes everything, the triggers and functions
#      are byte-identical to before the migration, the ledger row is gone; a plain deploy re-applies.
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="${1:?usage: chain.sh <db>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LAB_PASSWORD="${LAB_PASSWORD:-sd_lab_pw}"
H="${PGHOST:-localhost}:${PGPORT:-5432}"
owner_url() { echo "postgresql://lab_owner:$LAB_PASSWORD@$H/$1"; }
super() { psql -X -q -v ON_ERROR_STOP=1 -d "${2:-postgres}" -U "$SUPER" -c "$1"; }
MIG="20261201090000_service_desk_loans"
q() { psql -X -At "$(owner_url "$1")" -c "$2" | tr -d '\r'; }
stage() { # <target-dir> <db> [fault]
  local T="$1" db="$2" fault="${3:-}" n
  mkdir -p "$T/prisma/migrations"
  cp "$ROOT/prisma/schema.prisma" "$T/prisma/schema.prisma"
  cp "$ROOT/prisma/migrations/migration_lock.toml" "$T/prisma/migrations/"
  while read -r n; do
    [ -n "$n" ] || continue
    cp -r "$ROOT/prisma/migrations/$n" "$T/prisma/migrations/$n"
  done < <(q "$db" "SELECT migration_name FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")
  rm -rf "$T/prisma/migrations/$MIG"; cp -r "$ROOT/prisma/migrations/$MIG" "$T/prisma/migrations/$MIG"
  if [ "$fault" = fault ]; then printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$T/prisma/migrations/$MIG/migration.sql"; fi
}
deploy() { ( cd "$ROOT" && DATABASE_URL="$(owner_url "$2")" DIRECT_URL="$(owner_url "$2")" node node_modules/prisma/build/index.js migrate deploy --schema "$1/prisma/schema.prisma" ) 2>&1 </dev/null; }
resolve_rb() { ( cd "$ROOT" && DATABASE_URL="$(owner_url "$2")" DIRECT_URL="$(owner_url "$2")" node node_modules/prisma/build/index.js migrate resolve --rolled-back "$3" --schema "$1/prisma/schema.prisma" ) >/dev/null 2>&1 </dev/null; }
# every Service Desk function body and every trigger on the two foundation tables this migration adds triggers to
fingerprint() {
  q "$1" "SELECT md5(string_agg(x, '|' ORDER BY x)) FROM (
    SELECT p.proname || ':' || md5(pg_get_functiondef(p.oid)) x FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'service\\_%' AND p.proname NOT LIKE 'service\\_loan\\_%'
    UNION ALL SELECT t.tgrelid::regclass::text || '.' || t.tgname || ':' || md5(pg_get_triggerdef(t.oid)) FROM pg_trigger t
     WHERE t.tgrelid IN ('public.\"ServiceCase\"'::regclass, 'public.\"ServiceHandover\"'::regclass) AND NOT t.tgisinternal
       AND t.tgname NOT IN ('ServiceCase_loan_exit_guard', 'ServiceHandover_loan_guard')) s"
}
gone() {
  test "$(q "$1" "SELECT (to_regclass('public.\"ServiceLoan\"') IS NULL AND to_regclass('public.\"ServiceLoanEvent\"') IS NULL
    AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'service\\_loan\\_%')
    AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typname LIKE 'ServiceLoan%')
    AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN ('ServiceCase_loan_exit_guard', 'ServiceHandover_loan_guard')))::text")" = "true" \
  && test "$(fingerprint "$1")" = "$FP_BEFORE" && test "$(rows_digest "$1")" = "$BEFORE"
}
present() {
  test "$(q "$1" "SELECT (to_regclass('public.\"ServiceLoan\"') IS NOT NULL AND to_regclass('public.\"ServiceLoanEvent\"') IS NOT NULL
    AND (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'service\\_loan\\_%') = 8
    AND (SELECT count(*) FROM pg_trigger WHERE tgname IN ('ServiceCase_loan_exit_guard', 'ServiceHandover_loan_guard')) = 2
    AND (SELECT count(*) FROM pg_class WHERE relname IN ('ServiceLoan', 'ServiceLoanEvent') AND relforcerowsecurity) = 2
    AND EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'ServiceLoan_one_out_per_identifier'))::text")" = "true" \
  && test "$(fingerprint "$1")" = "$FP_BEFORE"
}
rows_digest() { # every existing case, case event and handover row
  q "$1" "SELECT md5(coalesce((SELECT string_agg(to_jsonb(c)::text, '|' ORDER BY c.id) FROM \"ServiceCase\" c), '')
    || coalesce((SELECT string_agg(to_jsonb(e)::text, '|' ORDER BY e.id) FROM \"ServiceCaseEvent\" e), '')
    || coalesce((SELECT string_agg(to_jsonb(h)::text, '|' ORDER BY h.id) FROM \"ServiceHandover\" h), ''))"
}
pass=0; fail=0
ok() { if eval "$2"; then pass=$((pass+1)); echo "  [PASS] $1"; else fail=$((fail+1)); echo "  [FAIL] $1"; fi; }

# version-2 handovers with a loaner exception and no loan, written before the migration (re-run safe)
psql -X -q -v ON_ERROR_STOP=1 "$(owner_url "$DB")" -f "$ROOT/.sdloan/seed-v2-loaner.sql" >/dev/null 2>&1 </dev/null || true
V2X_SQL="SELECT count(*) FROM \"ServiceHandover\" WHERE \"recordVersion\" = 2 AND (\"loanerOverrideReason\" IS NOT NULL OR \"loanerApprovedByUserId\" IS NOT NULL OR \"loanerApprovedAt\" IS NOT NULL)"
V2X="$(q "$DB" "$V2X_SQL")"
FP_BEFORE="$(fingerprint "$DB")"
BEFORE="$(rows_digest "$DB")"
NCASES="$(q "$DB" "SELECT count(*) FROM \"ServiceCase\"")"; NHOV="$(q "$DB" "SELECT count(*) FROM \"ServiceHandover\"")"
echo "  existing rows before the migration: $NCASES cases, $NHOV handovers"

echo "F — a failure inside the migration"
super "DROP DATABASE IF EXISTS ${DB}_fault"; super "CREATE DATABASE ${DB}_fault TEMPLATE $DB OWNER lab_owner"
T="$(mktemp -d)"; stage "$T" "${DB}_fault" fault; OUT="$(deploy "$T" "${DB}_fault" || true)"; rm -rf "$T"
ok "F1 the deploy reports the failure" 'echo "$OUT" | grep -q "division by zero"'
ok "F2 nothing of the failed migration exists; every Service Desk function and the case / handover triggers are byte-identical" 'gone "${DB}_fault"'
ok "F3 the ledger marks exactly that migration failed" \
  'test "$(q "${DB}_fault" "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '"'"'$MIG'"'"' AND finished_at IS NULL AND rolled_back_at IS NULL")" = "1"'
T="$(mktemp -d)"; stage "$T" "${DB}_fault"; resolve_rb "$T" "${DB}_fault" "$MIG"; OUT="$(deploy "$T" "${DB}_fault")"; rm -rf "$T"
ok "F4 recovery: resolve --rolled-back, then a clean deploy applies it" 'echo "$OUT" | grep -q "Applying migration \`$MIG\`" && present "${DB}_fault"'
super "DROP DATABASE ${DB}_fault"

echo "P — the premise: the handover record (20261130090000) must be in place"
super "DROP DATABASE IF EXISTS ${DB}_prem"; super "CREATE DATABASE ${DB}_prem TEMPLATE $DB OWNER lab_owner"
# (copy only) version-2 handovers — the seed's, or any an earlier battery on the lab wrote — make the handover-record
# rollback refuse: remove them first, triggers off (this throwaway copy only proves the premise)
super "SET session_replication_role = replica;
  DELETE FROM \"ServiceHandover\" WHERE \"recordVersion\" <> 1 OR \"overpaidAgorot\" IS NOT NULL;
  DELETE FROM \"ServiceHandover\" WHERE \"businessId\" IN (SELECT id FROM \"Business\" WHERE name = 'loan-pre-v2');
  DELETE FROM \"ServiceCaseEvent\" WHERE \"businessId\" IN (SELECT id FROM \"Business\" WHERE name = 'loan-pre-v2');
  DELETE FROM \"ServiceCase\" WHERE \"businessId\" IN (SELECT id FROM \"Business\" WHERE name = 'loan-pre-v2');
  DELETE FROM \"Customer\" WHERE \"businessId\" IN (SELECT id FROM \"Business\" WHERE name = 'loan-pre-v2');
  DELETE FROM \"User\" WHERE \"businessId\" IN (SELECT id FROM \"Business\" WHERE name = 'loan-pre-v2');
  DELETE FROM \"Business\" WHERE name = 'loan-pre-v2';" "${DB}_prem" >/dev/null
psql -X -q -v ON_ERROR_STOP=1 "$(owner_url "${DB}_prem")" -f "$ROOT/.sdhov/rollback.sql" >/dev/null 2>&1 || true
PREM_READY="$(q "${DB}_prem" "SELECT count(*) FROM information_schema.columns WHERE table_name = 'ServiceHandover' AND column_name = 'loanerApprovedAt'")"
T="$(mktemp -d)"; stage "$T" "${DB}_prem"; OUT="$(deploy "$T" "${DB}_prem" || true)"; rm -rf "$T"
ok "P1 without the handover loaner columns the migration refuses by its premise, and nothing of it exists" \
  'test "$PREM_READY" = "0" && echo "$OUT" | grep -q "the handover record (20261130090000) is not in place" && test "$(q "${DB}_prem" "SELECT to_regclass('"'"'public.\"ServiceLoan\"'"'"') IS NULL")" = "t"'
super "DROP DATABASE ${DB}_prem"

echo "A — apply"
T="$(mktemp -d)"; stage "$T" "$DB"; OUT="$(deploy "$T" "$DB")"; rm -rf "$T"
APPLIED="$(echo "$OUT" | grep -o 'Applying migration `[^`]*`' | sed 's/Applying migration `//; s/`//' | tr '\n' ' ')"
echo "  applied: $APPLIED"
ok "A1 exactly this migration was applied" 'test "$APPLIED" = "$MIG "'
ok "A2 nothing failed or rolled back in the ledger" \
  'test "$(q "$DB" "SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL")" = "0"'
ok "A3 every existing case, case event and handover row ($NCASES / $NHOV) is byte-identical" 'test "$(rows_digest "$DB")" = "$BEFORE"'
ok "A4 its objects exist; no existing function or trigger of the two foundation tables changed" 'present "$DB"'
ok "A5 the version-2 handovers saved before it with a loaner exception and no loan ($V2X) applied through and are kept" \
  'test "$V2X" -ge 1 && test "$(q "$DB" "$V2X_SQL")" = "$V2X"'

echo "S — a second application"
FP_AFTER="$(q "$DB" "SELECT md5(string_agg(pg_get_functiondef(oid), '|' ORDER BY proname)) FROM pg_proc WHERE proname LIKE 'service\\_%'")"
S2="$(psql -X -q -v ON_ERROR_STOP=1 -1 "$(owner_url "$DB")" -f "$ROOT/prisma/migrations/$MIG/migration.sql" 2>&1 || true)"
ok "S1 refused by its premise (already applied), nothing changed" \
  'echo "$S2" | grep -q "SERVICE_LOANS: already applied" && test "$FP_AFTER" = "$(q "$DB" "SELECT md5(string_agg(pg_get_functiondef(oid), '"'"'|'"'"' ORDER BY proname)) FROM pg_proc WHERE proname LIKE '"'"'service\\_%'"'"'")"'

echo "R — rollback script (on copies)"
super "DROP DATABASE IF EXISTS ${DB}_rbx"; super "CREATE DATABASE ${DB}_rbx TEMPLATE $DB OWNER lab_owner"
psql -X -q -v ON_ERROR_STOP=1 "$(owner_url "${DB}_rbx")" >/dev/null <<'SQL'
BEGIN;
SELECT set_config('app.current_business_id', (SELECT id FROM "Business" WHERE name = 'hov-legacy')::text, true);
INSERT INTO "ServiceCase" ("businessId", "caseNumber", kind, "customerId", "problemDescription")
  SELECT b.id, 998, 'IN_SHOP', c.id, 'תקלה סינתטית' FROM "Business" b JOIN "Customer" c ON c."businessId" = b.id WHERE b.name = 'hov-legacy' LIMIT 1;
INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "toStatus", "cancellationRequestedBefore",
                                "cancellationRequestedAfter", actor, "actorUserId", "idempotencyKey")
  SELECT b.id, k.id, 1, 'case.opened', 'OPEN', 'OPEN', false, false, 'OWNER_USER', u.id, 'loan-rbx-' || k.id
    FROM "Business" b JOIN "User" u ON u."businessId" = b.id JOIN "ServiceCase" k ON k."businessId" = b.id AND k."caseNumber" = 998
   WHERE b.name = 'hov-legacy';
UPDATE "ServiceCase" SET status = 'CHECKED_IN', version = 2 WHERE "caseNumber" = 998 AND "businessId" = (SELECT id FROM "Business" WHERE name = 'hov-legacy');
INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "cancellationRequestedBefore",
                                "cancellationRequestedAfter", actor, "idempotencyKey")
  SELECT k."businessId", k.id, 2, 'case.checked_in', 'CHECK_IN', 'OPEN', 'CHECKED_IN', false, false, 'SYSTEM', 'loan-rbx-ci-' || k.id
    FROM "ServiceCase" k JOIN "Business" b ON b.id = k."businessId" WHERE b.name = 'hov-legacy' AND k."caseNumber" = 998;
INSERT INTO "ServiceLoan" ("businessId", "caseId", "itemName", "lentByUserId", "conditionAtLend")
  SELECT k."businessId", k.id, 'טלפון חלופי', u.id, 'GOOD'
    FROM "ServiceCase" k JOIN "Business" b ON b.id = k."businessId" JOIN "User" u ON u."businessId" = b.id WHERE b.name = 'hov-legacy' AND k."caseNumber" = 998;
INSERT INTO "ServiceLoanEvent" ("businessId", "loanId", "caseId", seq, kind, "stateAfter", condition, actor, "actorUserId", "idempotencyKey")
  SELECT l."businessId", l.id, l."caseId", 1, 'LENT', 'OUT', 'GOOD', 'OWNER_USER', l."lentByUserId", 'loan-rbx-l-' || l.id FROM "ServiceLoan" l;
COMMIT;
SQL
RB="$(psql -X -q -v ON_ERROR_STOP=1 "$(owner_url "${DB}_rbx")" -f "$ROOT/.sdloan/rollback.sql" 2>&1 || true)"
ok "R1 the rollback refuses while a loan exists, and changes nothing" 'echo "$RB" | grep -q ROLLBACK_REFUSED && present "${DB}_rbx" && test "$(q "${DB}_rbx" "SELECT count(*) FROM \"ServiceLoan\"")" = "1"'
super "DROP DATABASE ${DB}_rbx"
super "DROP DATABASE IF EXISTS ${DB}_rb"; super "CREATE DATABASE ${DB}_rb TEMPLATE $DB OWNER lab_owner"
psql -X -q -v ON_ERROR_STOP=1 "$(owner_url "${DB}_rb")" -f "$ROOT/.sdloan/rollback.sql" >/dev/null
ok "R2 on a clean copy it removes every object; functions, triggers and existing rows are byte-identical to before" 'gone "${DB}_rb"'
ok "R3 its ledger row went with it" \
  'test "$(q "${DB}_rb" "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '"'"'$MIG'"'"'")" = "0"'
T="$(mktemp -d)"; stage "$T" "${DB}_rb"; OUT="$(deploy "$T" "${DB}_rb")"; rm -rf "$T"
ok "R4 a plain deploy re-applies it" 'echo "$OUT" | grep -q "Applying migration \`$MIG\`" && present "${DB}_rb"'
super "DROP DATABASE ${DB}_rb"

echo
echo "$pass passed, $fail failed"
test "$fail" = "0"
