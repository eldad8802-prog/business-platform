#!/usr/bin/env bash
# Service Desk QA lists — the application of migration 20261129090000 the way release-migrate.yml applies it: `prisma
# migrate deploy` over a staged directory = every migration the ledger already holds + this one. (Modelled on
# .sdm1/chain.sh.)
#
#   .sdqa/chain.sh <db>
#
# On the M1 lab <db> (.sd3p4/lab.sh <db>, --deploy-only, then .sdm1/chain.sh <db>: #1096, #1104 and M1 applied).
#   F  fault: on a copy, the migration fails on its final statement → nothing of it exists (one implicit transaction: no
#      table, type, column, enum value, CHECK, function), the ledger marks it failed; `migrate resolve --rolled-back` + a
#      clean deploy then applies it — the recovery procedure, proven.
#   A  apply: exactly this migration; nothing failed in the ledger; existing cases and events unchanged.
#   R  rollback (on copies, after A): rollback.sql refuses while a new table holds data; on a clean copy it removes every
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
  rm -rf "$T/prisma/migrations/$QA"; cp -r "$ROOT/prisma/migrations/$QA" "$T/prisma/migrations/$QA"
  if [ "$fault" = fault ]; then printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$T/prisma/migrations/$QA/migration.sql"; fi
}
deploy() { ( cd "$ROOT" && DATABASE_URL="$(owner_url "$2")" DIRECT_URL="$(owner_url "$2")" node_modules/.bin/prisma migrate deploy --schema "$1/prisma/schema.prisma" ) 2>&1 </dev/null; }
resolve_rb() { ( cd "$ROOT" && DATABASE_URL="$(owner_url "$2")" DIRECT_URL="$(owner_url "$2")" node_modules/.bin/prisma migrate resolve --rolled-back "$3" --schema "$1/prisma/schema.prisma" ) >/dev/null 2>&1 </dev/null; }
gone() { # <db>: nothing of the migration exists
  test "$(q "$1" "SELECT (to_regclass('public.\"ServiceQaList\"') IS NULL AND to_regclass('public.\"ServiceQaListVersion\"') IS NULL
    AND to_regclass('public.\"ServiceQaListItem\"') IS NULL AND to_regclass('public.\"ServiceQaListEvent\"') IS NULL
    AND to_regclass('public.\"ServiceCaseQaRecord\"') IS NULL AND to_regclass('public.\"ServiceCaseQaItemResult\"') IS NULL
    AND to_regtype('\"ServiceQaResult\"') IS NULL AND to_regtype('\"ServiceQaListAction\"') IS NULL
    AND to_regprocedure('public.service_qa_lists_erase_business()') IS NULL AND to_regprocedure('public.service_qa_in_erasure(oid)') IS NULL
    AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname LIKE 'service\\_qa\\_%' OR proname LIKE 'service\\_case\\_qa\\_%')
    AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ServiceCase' AND column_name IN ('qaListId', 'qaListVersion'))
    AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname LIKE 'ServiceCase\\_qa\\_%')
    AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ServiceCaseEvent_qa_list_in_place'))::text")" = "true"
}
present() { # <db>: the migration is in place
  test "$(q "$1" "SELECT (to_regclass('public.\"ServiceQaList\"') IS NOT NULL AND to_regclass('public.\"ServiceCaseQaItemResult\"') IS NOT NULL
    AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ServiceCaseEvent_qa_list_in_place')
    AND to_regprocedure('public.service_qa_lists_erase_business()') IS NOT NULL
    AND (SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'ServiceCase\\_qa\\_%') = 3)::text")" = "true"
}
pass=0; fail=0
ok() { if eval "$2"; then pass=$((pass+1)); echo "  [PASS] $1"; else fail=$((fail+1)); echo "  [FAIL] $1"; fi; }

test "$(q "$DB" "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '20261127090000_service_desk_tracks' AND finished_at IS NOT NULL")" = "1" \
  || { echo "M1 (20261127090000) is not applied on $DB — run .sdm1/chain.sh first"; exit 1; }

echo "F — a failure inside the migration"
super "DROP DATABASE IF EXISTS ${DB}_fault"; super "CREATE DATABASE ${DB}_fault TEMPLATE $DB OWNER lab_owner"
T="$(mktemp -d)"; stage "$T" "${DB}_fault" fault; OUT="$(deploy "$T" "${DB}_fault" || true)"; rm -rf "$T"
ok "F1 the deploy reports the failure" 'echo "$OUT" | grep -q "division by zero"'
ok "F2 nothing of the failed migration exists (tables, types, columns, triggers, CHECK, functions)" 'gone "${DB}_fault"'
ok "F3 not even its new enum values (one implicit transaction)" \
  'test "$(q "${DB}_fault" "SELECT count(*) FROM pg_enum WHERE enumlabel IN ('"'"'CHOOSE_QA_LIST'"'"', '"'"'qa.list_chosen'"'"')")" = "0"'
ok "F4 the ledger marks exactly that migration failed" \
  'test "$(q "${DB}_fault" "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '"'"'$QA'"'"' AND finished_at IS NULL AND rolled_back_at IS NULL")" = "1"'
T="$(mktemp -d)"; stage "$T" "${DB}_fault"; resolve_rb "$T" "${DB}_fault" "$QA"; OUT="$(deploy "$T" "${DB}_fault")"; rm -rf "$T"
ok "F5 recovery: resolve --rolled-back, then a clean deploy applies it" 'echo "$OUT" | grep -q "Applying migration \`$QA\`" && present "${DB}_fault"'
super "DROP DATABASE ${DB}_fault"

echo "A — the application"
# a legacy case in QA with a recorded checklist (the way P4 records it), before the migration
psql -X -q -v ON_ERROR_STOP=1 "$(owner_url "$DB")" >/dev/null <<'SQL'
BEGIN;
INSERT INTO "Business" (name, "updatedAt") VALUES ('sdqa-legacy', now());
SELECT set_config('app.current_business_id', currval(pg_get_serial_sequence('"Business"', 'id'))::text, true);
INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ('sdqa-legacy-' || currval(pg_get_serial_sequence('"Business"', 'id')) || '@lab.invalid', currval(pg_get_serial_sequence('"Business"', 'id')), now());
INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES (currval(pg_get_serial_sequence('"Business"', 'id')), 'לקוח סינתטי', now());
INSERT INTO "ServiceCase" ("businessId", "caseNumber", kind, "customerId", "problemDescription", "qaChecklist", "qaCompletedAt")
  VALUES (currval(pg_get_serial_sequence('"Business"', 'id')), 1, 'FIELD', currval(pg_get_serial_sequence('"Customer"', 'id')), 'לא עובד',
          '{"template": "FIELD.v1", "results": {"system_tested": "PASS"}}', now());
INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "toStatus", "cancellationRequestedBefore",
                                "cancellationRequestedAfter", actor, "actorUserId", "idempotencyKey")
  VALUES (currval(pg_get_serial_sequence('"Business"', 'id')), currval(pg_get_serial_sequence('"ServiceCase"', 'id')), 1, 'case.opened', 'OPEN', 'OPEN',
          false, false, 'OWNER_USER', currval(pg_get_serial_sequence('"User"', 'id')), 'sdqa-legacy-' || currval(pg_get_serial_sequence('"ServiceCase"', 'id')));
COMMIT;
SQL
SNAP="SELECT md5(coalesce(string_agg(t, '|' ORDER BY t), '')) FROM (SELECT (to_jsonb(c) - ARRAY['qaListId','qaListVersion'])::text t FROM \"ServiceCase\" c UNION ALL SELECT to_jsonb(e)::text FROM \"ServiceCaseEvent\" e) s"
BEFORE="$(psql -X -At "$(owner_url "$DB")" -c "SET row_security = off" -c "$SNAP" | tr -d '\r' | tail -1)"
T="$(mktemp -d)"; stage "$T" "$DB"; OUT="$(deploy "$T" "$DB")"; rm -rf "$T"
APPLIED="$(echo "$OUT" | grep -o 'Applying migration `[^`]*`' | sed 's/Applying migration `//; s/`//' | tr '\n' ' ')"
echo "  applied: $APPLIED"
ok "A1 exactly this migration was applied" 'test "$APPLIED" = "$QA "'
ok "A2 nothing failed or rolled back in the ledger" \
  'test "$(q "$DB" "SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL")" = "0"'
AFTER="$(psql -X -At "$(owner_url "$DB")" -c "SET row_security = off" -c "$SNAP" | tr -d '\r' | tail -1)"
ok "A3 existing cases and journal events unchanged (the two new columns NULL); the new tables empty" \
  'test -n "$BEFORE" && test "$BEFORE" = "$AFTER" && test "$(psql -X -At "$(owner_url "$DB")" -c "SET row_security = off" -c "SELECT (SELECT count(*) FROM \"ServiceQaList\") + (SELECT count(*) FROM \"ServiceCaseQaRecord\") + (SELECT count(*) FROM \"ServiceCase\" WHERE \"qaListId\" IS NOT NULL)" | tr -d "\r" | tail -1)" = "0"'
ok "A4 a second application by hand is refused (the types exist) and changes nothing" \
  '! psql -X -q -v ON_ERROR_STOP=1 -1 "$(owner_url "$DB")" -f "$ROOT/prisma/migrations/$QA/migration.sql" >/dev/null 2>&1 && present "$DB"'

echo "R — rollback script (on copies)"
super "DROP DATABASE IF EXISTS ${DB}_rbx"; super "CREATE DATABASE ${DB}_rbx TEMPLATE $DB OWNER lab_owner"
psql -X -q -v ON_ERROR_STOP=1 "$(owner_url "${DB}_rbx")" >/dev/null <<'SQL'
BEGIN;
INSERT INTO "Business" (name, "updatedAt") VALUES ('sdqa-rollback-refusal', now());
SELECT set_config('app.current_business_id', currval(pg_get_serial_sequence('"Business"', 'id'))::text, true);
INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ('sdqa-rb-' || currval(pg_get_serial_sequence('"Business"', 'id')) || '@lab.invalid', currval(pg_get_serial_sequence('"Business"', 'id')), now());
INSERT INTO "ServiceQaList" ("businessId", "currentVersion", revision) VALUES (currval(pg_get_serial_sequence('"Business"', 'id')), 1, 1);
INSERT INTO "ServiceQaListVersion" ("businessId", "listId", version, name, "itemCount", "requiredCount", "createdByUserId")
  VALUES (currval(pg_get_serial_sequence('"Business"', 'id')), currval(pg_get_serial_sequence('"ServiceQaList"', 'id')), 1, 'בדיקה', 1, 1, currval(pg_get_serial_sequence('"User"', 'id')));
INSERT INTO "ServiceQaListItem" ("businessId", "listId", "listVersion", position, "itemKey", label, required)
  VALUES (currval(pg_get_serial_sequence('"Business"', 'id')), currval(pg_get_serial_sequence('"ServiceQaList"', 'id')), 1, 1, 'works', 'עובד', true);
INSERT INTO "ServiceQaListEvent" ("businessId", "listId", revision, action, "listVersion", "itemCount", "requiredCount", actor, "actorUserId", "idempotencyKey")
  VALUES (currval(pg_get_serial_sequence('"Business"', 'id')), currval(pg_get_serial_sequence('"ServiceQaList"', 'id')), 1, 'CREATE', 1, 1, 1, 'OWNER_USER', currval(pg_get_serial_sequence('"User"', 'id')), 'sdqa-rb-event-1');
COMMIT;
SQL
RB="$(psql -X -q -v ON_ERROR_STOP=1 "$(owner_url "${DB}_rbx")" -f "$ROOT/.sdqa/rollback.sql" 2>&1 || true)"
ok "R1 the rollback refuses while a new table holds data (behind FORCE RLS, no tenant context), and changes nothing" 'echo "$RB" | grep -q ROLLBACK_REFUSED && present "${DB}_rbx"'
super "DROP DATABASE ${DB}_rbx"
super "DROP DATABASE IF EXISTS ${DB}_rb"; super "CREATE DATABASE ${DB}_rb TEMPLATE $DB OWNER lab_owner"
psql -X -q -v ON_ERROR_STOP=1 "$(owner_url "${DB}_rb")" -f "$ROOT/.sdqa/rollback.sql" >/dev/null
ok "R2 on a clean copy it removes every object of the migration" 'gone "${DB}_rb"'
ok "R3 its ledger row went with it" \
  'test "$(q "${DB}_rb" "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '"'"'$QA'"'"'")" = "0"'
T="$(mktemp -d)"; stage "$T" "${DB}_rb"; OUT="$(deploy "$T" "${DB}_rb")"; rm -rf "$T"
ok "R4 a plain deploy re-applies it (the leftover enum values are skipped)" 'echo "$OUT" | grep -q "Applying migration \`$QA\`" && present "${DB}_rb"'
super "DROP DATABASE ${DB}_rb"

echo
echo "$pass passed, $fail failed"
test "$fail" = "0"
