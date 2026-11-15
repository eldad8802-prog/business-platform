#!/usr/bin/env bash
# Service Desk handover record (migration 20261130090000) — the application chain the way release-migrate.yml applies it
# (`prisma migrate deploy` over a staged directory = every migration the ledger holds + this one), with LEGACY data.
# (Modelled on .sdm1/chain.sh.)
#
#   .sdhov/chain.sh <db>      on the M1 lab: .sd3p4/lab.sh <db>, --deploy-only, then .sdm1/chain.sh <db>
#
#   L  legacy: handovers written the pre-migration way (zero balance, an approved debt with only a reason, a NEGATIVE
#      balance = a legacy overpayment, the loaner exception, an erased row) exist BEFORE the migration.
#   F  fault: on a copy, the migration fails on its final statement → nothing of it exists, the replaced function, the
#      completion guard (not touched — approver = actor is M1's own rule) and the same-business trigger are the old ones; the ledger marks it failed; resolve --rolled-back + deploy recovers.
#   A  apply: exactly this migration; nothing failed; every legacy row byte-identical apart from the new columns, which
#      read recordVersion 1 / NULL; every new CHECK VALIDATED (not NOT VALID) although legacy rows exist.
#   P  premise: over an M1 without the approver = actor rule in service_completion_guard the migration refuses.
#   S  a second application by hand is refused by the premise and changes nothing.
#   R  rollback (copies): refuses while a version-2 handover exists; on a clean copy it removes everything, restores the
#      two functions and the trigger byte-for-byte (fingerprints taken before the migration), keeps the legacy rows,
#      drops the ledger row; a plain deploy re-applies.
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="${1:?usage: chain.sh <db>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LAB_PASSWORD="${LAB_PASSWORD:-sd_lab_pw}"
H="${PGHOST:-localhost}:${PGPORT:-5432}"
owner_url() { echo "postgresql://lab_owner:$LAB_PASSWORD@$H/$1"; }
super() { psql -X -q -v ON_ERROR_STOP=1 -d "${2:-postgres}" -U "$SUPER" -c "$1"; }
MIG="20261130090000_service_handover_debt_record"
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
# the objects the migration replaces: function bodies and the same-business trigger, fingerprinted
fingerprint() {
  q "$1" "SELECT md5(string_agg(x, '|' ORDER BY x)) FROM (
    SELECT p.proname || ':' || md5(pg_get_functiondef(p.oid)) x FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('service_handover_guard', 'service_completion_guard')
    UNION ALL SELECT t.tgname || ':' || md5(pg_get_triggerdef(t.oid)) FROM pg_trigger t
     WHERE t.tgrelid = 'public.\"ServiceHandover\"'::regclass AND NOT t.tgisinternal) s"
}
gone() {
  test "$(q "$1" "SELECT (NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ServiceHandover'
        AND column_name IN ('recordVersion', 'overpaidAgorot', 'debtApprovedByUserId', 'debtApprovedAt', 'loanerApprovedByUserId', 'loanerApprovedAt'))
    AND to_regprocedure('public.service_handover_record_guard()') IS NULL
    AND to_regprocedure('public.service_handover_record_erase_business()') IS NULL
    AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname LIKE 'ServiceHandover\\_%' AND conname IN ('ServiceHandover_record_version',
        'ServiceHandover_legacy_shape', 'ServiceHandover_balance', 'ServiceHandover_debt_decided', 'ServiceHandover_loaner_decided',
        'ServiceHandover_debtApprovedByUserId_fkey', 'ServiceHandover_loanerApprovedByUserId_fkey')))::text")" = "true" \
  && test "$(fingerprint "$1")" = "$FP_BEFORE"
}
present() {
  test "$(q "$1" "SELECT (to_regprocedure('public.service_handover_record_guard()') IS NOT NULL
    AND (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.\"ServiceHandover\"'::regclass AND convalidated
          AND conname IN ('ServiceHandover_record_version', 'ServiceHandover_legacy_shape', 'ServiceHandover_balance',
                          'ServiceHandover_debt_decided', 'ServiceHandover_loaner_decided')) = 5
    AND position('SERVICE_APPROVER_NOT_ACTOR' IN (SELECT prosrc FROM pg_proc WHERE proname = 'service_completion_guard')) > 0)::text")" = "true"
}
legacy_digest() { # the legacy rows without the new columns
  q "$1" "SELECT md5(coalesce(string_agg((to_jsonb(h) - ARRAY['recordVersion','overpaidAgorot','debtApprovedByUserId','debtApprovedAt','loanerApprovedByUserId','loanerApprovedAt'])::text, '|' ORDER BY h.id), ''))
            FROM \"ServiceHandover\" h"
}
pass=0; fail=0
ok() { if eval "$2"; then pass=$((pass+1)); echo "  [PASS] $1"; else fail=$((fail+1)); echo "  [FAIL] $1"; fi; }

echo "L — legacy handovers, written before the migration"
psql -X -q -v ON_ERROR_STOP=1 "$(owner_url "$DB")" -f "$ROOT/.sdhov/seed-legacy.sql" >/dev/null
ok "L1 five legacy handovers exist (zero, debt+reason only, negative balance, loaner, erased)" \
  'test "$(q "$DB" "SELECT count(*) FROM \"ServiceHandover\" h JOIN \"Business\" b ON b.id = h.\"businessId\" WHERE b.name = '"'"'hov-legacy'"'"'")" = "5"'
FP_BEFORE="$(fingerprint "$DB")"
BEFORE="$(legacy_digest "$DB")"
NROWS="$(q "$DB" "SELECT count(*) FROM \"ServiceHandover\"")"

echo "F — a failure inside the migration"
super "DROP DATABASE IF EXISTS ${DB}_fault"; super "CREATE DATABASE ${DB}_fault TEMPLATE $DB OWNER lab_owner"
T="$(mktemp -d)"; stage "$T" "${DB}_fault" fault; OUT="$(deploy "$T" "${DB}_fault" || true)"; rm -rf "$T"
ok "F1 the deploy reports the failure" 'echo "$OUT" | grep -q "division by zero"'
ok "F2 nothing of the failed migration exists; the replaced functions and trigger are byte-identical to before" 'gone "${DB}_fault"'
ok "F3 the legacy rows are untouched" 'test "$(legacy_digest "${DB}_fault")" = "$BEFORE"'
ok "F4 the ledger marks exactly that migration failed" \
  'test "$(q "${DB}_fault" "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '"'"'$MIG'"'"' AND finished_at IS NULL AND rolled_back_at IS NULL")" = "1"'
T="$(mktemp -d)"; stage "$T" "${DB}_fault"; resolve_rb "$T" "${DB}_fault" "$MIG"; OUT="$(deploy "$T" "${DB}_fault")"; rm -rf "$T"
ok "F5 recovery: resolve --rolled-back, then a clean deploy applies it" 'echo "$OUT" | grep -q "Applying migration \`$MIG\`" && present "${DB}_fault"'
super "DROP DATABASE ${DB}_fault"

echo "P — the premise: approver = actor on the work completion is M1's own rule"
super "DROP DATABASE IF EXISTS ${DB}_prem"; super "CREATE DATABASE ${DB}_prem TEMPLATE $DB OWNER lab_owner"
PF="$(mktemp)"
node -e '
const s = require("fs").readFileSync(process.argv[1], "utf8");
const m = s.match(/CREATE OR REPLACE FUNCTION public\.service_completion_guard\(\)[\s\S]*?\$fn\$;/);
const a = `IF NEW."debtApprovedByUserId" IS NOT NULL AND NEW."debtApprovedByUserId" <> NEW."actorUserId" THEN`;
if (!m || !m[0].includes(a)) { console.error("M1 rule not found"); process.exit(1); }
process.stdout.write(m[0].replace(a, "IF false THEN").replace("SERVICE_APPROVER_NOT_ACTOR", "REMOVED_FOR_THE_LAB"));
' "$ROOT/prisma/migrations/20261127090000_service_desk_tracks/migration.sql" > "$PF"
psql -X -q -v ON_ERROR_STOP=1 "$(owner_url "${DB}_prem")" -f "$PF" >/dev/null; rm -f "$PF"
T="$(mktemp -d)"; stage "$T" "${DB}_prem"; OUT="$(deploy "$T" "${DB}_prem" || true)"; rm -rf "$T"
ok "P1 over an M1 whose completion guard lacks the approver = actor rule the migration refuses by its premise, and nothing of it exists" \
  'echo "$OUT" | grep -q "without the approver = actor rule" && test "$(q "${DB}_prem" "SELECT count(*) FROM information_schema.columns WHERE table_name = '"'"'ServiceHandover'"'"' AND column_name = '"'"'recordVersion'"'"'")" = "0"'
super "DROP DATABASE ${DB}_prem"

echo "A — apply over legacy data"
T="$(mktemp -d)"; stage "$T" "$DB"; OUT="$(deploy "$T" "$DB")"; rm -rf "$T"
APPLIED="$(echo "$OUT" | grep -o 'Applying migration `[^`]*`' | sed 's/Applying migration `//; s/`//' | tr '\n' ' ')"
echo "  applied: $APPLIED"
ok "A1 exactly this migration was applied" 'test "$APPLIED" = "$MIG "'
ok "A2 nothing failed or rolled back in the ledger" \
  'test "$(q "$DB" "SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL")" = "0"'
ok "A3 every legacy row ($NROWS) is byte-identical apart from the new columns" 'test "$(legacy_digest "$DB")" = "$BEFORE"'
ok "A4 the legacy rows read recordVersion 1 and NULL in every new column" \
  'test "$(q "$DB" "SELECT count(*) FROM \"ServiceHandover\" WHERE \"recordVersion\" = 1 AND \"overpaidAgorot\" IS NULL AND \"debtApprovedByUserId\" IS NULL
     AND \"debtApprovedAt\" IS NULL AND \"loanerApprovedByUserId\" IS NULL AND \"loanerApprovedAt\" IS NULL")" = "$NROWS"'
ok "A5 the five new CHECKs are VALIDATED over the legacy rows (incl. a negative balance and a debt without approver)" 'present "$DB"'
ok "A6 the column default is a constant (no table rewrite): recordVersion DEFAULT 1, NOT NULL" \
  'test "$(q "$DB" "SELECT column_default || '"'"'/'"'"' || is_nullable FROM information_schema.columns WHERE table_name = '"'"'ServiceHandover'"'"' AND column_name = '"'"'recordVersion'"'"'")" = "1/NO"'

echo "S — a second application"
FP_AFTER="$(q "$DB" "SELECT md5(string_agg(pg_get_functiondef(oid), '|' ORDER BY proname)) FROM pg_proc WHERE proname LIKE 'service_handover%' OR proname = 'service_completion_guard'")"
S2="$(psql -X -q -v ON_ERROR_STOP=1 -1 "$(owner_url "$DB")" -f "$ROOT/prisma/migrations/$MIG/migration.sql" 2>&1 || true)"
ok "S1 refused by its premise (already applied), nothing changed" \
  'echo "$S2" | grep -q "SERVICE_HANDOVER_RECORD: already applied" && test "$FP_AFTER" = "$(q "$DB" "SELECT md5(string_agg(pg_get_functiondef(oid), '"'"'|'"'"' ORDER BY proname)) FROM pg_proc WHERE proname LIKE '"'"'service_handover%'"'"' OR proname = '"'"'service_completion_guard'"'"'")" && test "$(legacy_digest "$DB")" = "$BEFORE"'

echo "R — rollback script (on copies)"
super "DROP DATABASE IF EXISTS ${DB}_rbx"; super "CREATE DATABASE ${DB}_rbx TEMPLATE $DB OWNER lab_owner"
psql -X -q -v ON_ERROR_STOP=1 "$(owner_url "${DB}_rbx")" >/dev/null <<'SQL'
BEGIN;
SELECT set_config('app.current_business_id', (SELECT id FROM "Business" WHERE name = 'hov-legacy')::text, true);
INSERT INTO "ServiceCase" ("businessId", "caseNumber", kind, "customerId", "problemDescription")
  SELECT b.id, 999, 'IN_SHOP', c.id, 'תקלה סינתטית' FROM "Business" b JOIN "Customer" c ON c."businessId" = b.id WHERE b.name = 'hov-legacy' LIMIT 1;
INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "toStatus", "cancellationRequestedBefore",
                                "cancellationRequestedAfter", actor, "actorUserId", "idempotencyKey")
  SELECT b.id, k.id, 1, 'case.opened', 'OPEN', 'OPEN', false, false, 'OWNER_USER', u.id, 'hov-rbx-' || k.id
    FROM "Business" b JOIN "User" u ON u."businessId" = b.id JOIN "ServiceCase" k ON k."businessId" = b.id AND k."caseNumber" = 999
   WHERE b.name = 'hov-legacy';
INSERT INTO "ServiceHandover" ("businessId", "caseId", "signatureCaptured", "recordVersion", "openBalanceAgorot", "overpaidAgorot", "actorUserId")
  SELECT b.id, (SELECT id FROM "ServiceCase" WHERE "businessId" = b.id AND "caseNumber" = 999), false, 2, 0, 0, u.id
    FROM "Business" b JOIN "User" u ON u."businessId" = b.id WHERE b.name = 'hov-legacy';
COMMIT;
SQL
RB="$(psql -X -q -v ON_ERROR_STOP=1 "$(owner_url "${DB}_rbx")" -f "$ROOT/.sdhov/rollback.sql" 2>&1 || true)"
ok "R1 the rollback refuses while a version-2 handover exists, and changes nothing" 'echo "$RB" | grep -q ROLLBACK_REFUSED && present "${DB}_rbx"'
super "DROP DATABASE ${DB}_rbx"
super "DROP DATABASE IF EXISTS ${DB}_rb"; super "CREATE DATABASE ${DB}_rb TEMPLATE $DB OWNER lab_owner"
psql -X -q -v ON_ERROR_STOP=1 "$(owner_url "${DB}_rb")" -f "$ROOT/.sdhov/rollback.sql" >/dev/null
ok "R2 on a copy with legacy rows only it removes every object and restores the functions and trigger byte-for-byte" 'gone "${DB}_rb"'
ok "R3 the legacy rows survive the rollback unchanged" 'test "$(legacy_digest "${DB}_rb")" = "$BEFORE"'
ok "R4 its ledger row went with it" \
  'test "$(q "${DB}_rb" "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '"'"'$MIG'"'"'")" = "0"'
T="$(mktemp -d)"; stage "$T" "${DB}_rb"; OUT="$(deploy "$T" "${DB}_rb")"; rm -rf "$T"
ok "R5 a plain deploy re-applies it" 'echo "$OUT" | grep -q "Applying migration \`$MIG\`" && present "${DB}_rb"'
super "DROP DATABASE ${DB}_rb"

echo
echo "$pass passed, $fail failed"
test "$fail" = "0"
