#!/usr/bin/env bash
# Service Desk M1 — the application chain of the pending migrations, the way release-migrate.yml applies them:
# `prisma migrate deploy` over a staged directory = every migration the ledger already holds + the approved prefix.
# (Modelled on .sdcharge/chain.sh.)
#
#   .sdm1/chain.sh <db> [extra-migration-dir ...]
#
# On the P4 lab <db> (.sd3p4/lab.sh <db> then --deploy-only). The approved prefix is: the extra dirs given (e.g. #1061's
# 20261123090000, from its branch), then 20261125090000 (#1096), 20261126090000 (#1104), 20261127090000 (M1), in name order.
#   F  fault: on a copy, M1 fails on its final statement → nothing of it exists (one implicit transaction: no table,
#      type, column, enum value, CHECK; the replaced guard and CHECKs are the old ones), the ledger marks it failed;
#      `migrate resolve --rolled-back` + a clean deploy then applies it — the recovery procedure, proven.
#   A  apply: exactly the prefix, in order, each once; nothing failed in the ledger; existing rows unchanged.
#   R  rollback (on copies, after A): rollback.sql refuses while a new column holds data; on a clean copy it removes
#      every object of M1 and its ledger row, restores the original guard and CHECKs; a plain deploy re-applies M1.
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
TRACKS="20261127090000_service_desk_tracks"
PREFIX=("$@" "$ROOT/prisma/migrations/$HANDOVER" "$ROOT/prisma/migrations/$CHARGE" "$ROOT/prisma/migrations/$TRACKS")

q() { psql -X -At "$(owner_url "$1")" -c "$2" | tr -d '\r'; }
stage() { # <target-dir> <db> [fault]: applied (from the ledger) + the prefix; with "fault", M1 fails at its end
  local T="$1" db="$2" fault="${3:-}"
  mkdir -p "$T/prisma/migrations"
  cp "$ROOT/prisma/schema.prisma" "$T/prisma/schema.prisma"
  cp "$ROOT/prisma/migrations/migration_lock.toml" "$T/prisma/migrations/"
  local src d n
  while read -r n; do
    [ -n "$n" ] || continue
    src="$ROOT/prisma/migrations/$n"
    for d in "${PREFIX[@]}"; do [ "$(basename "$d")" = "$n" ] && src="$d"; done
    cp -r "$src" "$T/prisma/migrations/$n"
  done < <(q "$db" "SELECT migration_name FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")
  for d in "${PREFIX[@]}"; do rm -rf "$T/prisma/migrations/$(basename "$d")"; cp -r "$d" "$T/prisma/migrations/$(basename "$d")"; done
  if [ "$fault" = fault ]; then printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$T/prisma/migrations/$TRACKS/migration.sql"; fi
}
deploy() { ( cd "$ROOT" && DATABASE_URL="$(owner_url "$2")" DIRECT_URL="$(owner_url "$2")" node_modules/.bin/prisma migrate deploy --schema "$1/prisma/schema.prisma" ) 2>&1 </dev/null; }
resolve_rb() { ( cd "$ROOT" && DATABASE_URL="$(owner_url "$2")" DIRECT_URL="$(owner_url "$2")" node_modules/.bin/prisma migrate resolve --rolled-back "$3" --schema "$1/prisma/schema.prisma" ) >/dev/null 2>&1 </dev/null; }
gone() { # <db>: nothing of M1 exists, and what it replaced is the original again
  test "$(q "$1" "SELECT (to_regclass('public.\"ServiceCompletion\"') IS NULL AND to_regclass('public.\"ServiceCaseDetailChange\"') IS NULL
    AND to_regtype('\"ServiceWorkType\"') IS NULL AND to_regtype('\"ServiceCompletionType\"') IS NULL
    AND to_regprocedure('public.service_tracks_erase_business()') IS NULL
    AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name IN ('ServiceCase', 'ServiceDevice', 'ServiceSettings')
                      AND column_name IN ('workType', 'siteAddress', 'profileSnapshot', 'subjectKind', 'serviceProfileKey'))
    AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname IN ('ServiceCaseEvent_tracks_in_place', 'ServiceCase_outcome_by_status_v2', 'ServiceSettingsEvent_fields_v2'))
    AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ServiceCase_outcome_by_status')
    AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ServiceSettingsEvent_fields')
    AND position('kind' IN (SELECT prosrc FROM pg_proc WHERE proname = 'service_case_guard')) > 0
    AND position('profileKey' IN (SELECT prosrc FROM pg_proc WHERE proname = 'service_case_guard')) = 0)::text")" = "true"
}
present() { # <db>: M1 is in place
  test "$(q "$1" "SELECT (to_regclass('public.\"ServiceCompletion\"') IS NOT NULL AND to_regclass('public.\"ServiceCaseDetailChange\"') IS NOT NULL
    AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ServiceCase_outcome_by_status_v2')
    AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ServiceCase_outcome_by_status')
    AND position('profileKey' IN (SELECT prosrc FROM pg_proc WHERE proname = 'service_case_guard')) > 0)::text")" = "true"
}
pass=0; fail=0
ok() { if eval "$2"; then pass=$((pass+1)); echo "  [PASS] $1"; else fail=$((fail+1)); echo "  [FAIL] $1"; fi; }

echo "F — a failure inside the migration"
super "DROP DATABASE IF EXISTS ${DB}_fault"; super "CREATE DATABASE ${DB}_fault TEMPLATE $DB OWNER lab_owner"
T="$(mktemp -d)"; stage "$T" "${DB}_fault" fault; OUT="$(deploy "$T" "${DB}_fault" || true)"; rm -rf "$T"
ok "F1 the deploy reports the failure" 'echo "$OUT" | grep -q "division by zero"'
ok "F2 nothing of the failed migration exists (tables, types, columns, CHECKs, function); the old guard and CHECKs are in place" 'gone "${DB}_fault"'
ok "F3 not even its new enum values (one implicit transaction)" \
  'test "$(q "${DB}_fault" "SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname LIKE '"'"'Service%'"'"' AND e.enumlabel IN ('"'"'case.details_changed'"'"', '"'"'CHANGE_DETAILS'"'"', '"'"'WORK_DONE'"'"', '"'"'COMPLETED'"'"', '"'"'REMOTE'"'"')")" = "0"'
ok "F4 the ledger marks exactly that migration failed" \
  'test "$(q "${DB}_fault" "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '"'"'$TRACKS'"'"' AND finished_at IS NULL AND rolled_back_at IS NULL")" = "1"'
T="$(mktemp -d)"; stage "$T" "${DB}_fault"; resolve_rb "$T" "${DB}_fault" "$TRACKS"; OUT="$(deploy "$T" "${DB}_fault")"; rm -rf "$T"
ok "F5 recovery: resolve --rolled-back, then a clean deploy applies it" 'echo "$OUT" | grep -q "Applying migration \`$TRACKS\`" && present "${DB}_fault"'
super "DROP DATABASE ${DB}_fault"

echo "A — the chain, in order"
# a legacy-shaped case (opened the way 1.3-0 does: OPEN, version 1, its case.opened event) and device, before M1
psql -X -q -v ON_ERROR_STOP=1 "$(owner_url "$DB")" >/dev/null <<'SQL'
BEGIN;
INSERT INTO "Business" (name, "updatedAt") VALUES ('sdm1-legacy', now());
SELECT set_config('app.current_business_id', currval(pg_get_serial_sequence('"Business"', 'id'))::text, true);
INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ('sdm1-legacy-' || currval(pg_get_serial_sequence('"Business"', 'id')) || '@lab.invalid', currval(pg_get_serial_sequence('"Business"', 'id')), now());
INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES (currval(pg_get_serial_sequence('"Business"', 'id')), 'לקוח סינתטי', now());
INSERT INTO "ServiceDevice" ("businessId", "customerId", brand, model)
  VALUES (currval(pg_get_serial_sequence('"Business"', 'id')), currval(pg_get_serial_sequence('"Customer"', 'id')), 'מותג', 'דגם');
INSERT INTO "ServiceCase" ("businessId", "caseNumber", kind, "customerId", "deviceId", "problemDescription")
  VALUES (currval(pg_get_serial_sequence('"Business"', 'id')), 1, 'IN_SHOP', currval(pg_get_serial_sequence('"Customer"', 'id')),
          currval(pg_get_serial_sequence('"ServiceDevice"', 'id')), 'לא נדלק');
INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "toStatus", "cancellationRequestedBefore",
                                "cancellationRequestedAfter", actor, "actorUserId", "idempotencyKey")
  VALUES (currval(pg_get_serial_sequence('"Business"', 'id')), currval(pg_get_serial_sequence('"ServiceCase"', 'id')), 1, 'case.opened', 'OPEN', 'OPEN',
          false, false, 'OWNER_USER', currval(pg_get_serial_sequence('"User"', 'id')), 'sdm1-legacy-' || currval(pg_get_serial_sequence('"ServiceCase"', 'id')));
COMMIT;
SQL
BEFORE="$(q "$DB" "SELECT md5(coalesce(string_agg(t, '|' ORDER BY t), '')) FROM (SELECT to_jsonb(c)::text t FROM \"ServiceCase\" c UNION ALL SELECT to_jsonb(d)::text FROM \"ServiceDevice\" d) s")"
T="$(mktemp -d)"; stage "$T" "$DB"; OUT="$(deploy "$T" "$DB")"; rm -rf "$T"
APPLIED="$(echo "$OUT" | grep -o 'Applying migration `[^`]*`' | sed 's/Applying migration `//; s/`//' | tr '\n' ' ')"
EXPECTED="$(for d in "${PREFIX[@]}"; do basename "$d"; done | sort | tr '\n' ' ')"
echo "  applied: $APPLIED"
ok "A1 exactly the approved prefix was applied, in name order" 'test "$APPLIED" = "$EXPECTED"'
ok "A2 nothing failed or rolled back in the ledger" \
  'test "$(q "$DB" "SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL")" = "0"'
AFTER="$(q "$DB" "SELECT md5(coalesce(string_agg(t, '|' ORDER BY t), '')) FROM (SELECT (to_jsonb(c) - ARRAY['workType','serviceLocation','appointmentId','siteAddress','siteNotes','completionType','completedAt','profileKey','profileSnapshot','returnReason','afterSaleResolution','originalSaleRef'])::text t FROM \"ServiceCase\" c UNION ALL SELECT (to_jsonb(d) - ARRAY['subjectKind','displayName','attributes'])::text FROM \"ServiceDevice\" d) s")"
ok "A3 existing rows unchanged ($(q "$DB" "SELECT count(*) FROM \"ServiceCase\"") case(s) before M1: cases and devices identical apart from the new NULL / default columns); new tables empty" \
  'test "$BEFORE" = "$AFTER" && test "$(q "$DB" "SELECT (SELECT count(*) FROM \"ServiceCompletion\") + (SELECT count(*) FROM \"ServiceCaseDetailChange\") + (SELECT count(*) FROM \"ServiceCase\" WHERE \"workType\" IS NOT NULL) + (SELECT count(*) FROM \"ServiceDevice\" WHERE \"subjectKind\" <> '"'"'ITEM'"'"')")" = "0"'

echo "R — rollback script (on copies)"
super "DROP DATABASE IF EXISTS ${DB}_rbx"; super "CREATE DATABASE ${DB}_rbx TEMPLATE $DB OWNER lab_owner"
psql -X -q -v ON_ERROR_STOP=1 "$(owner_url "${DB}_rbx")" >/dev/null <<'SQL'
BEGIN;
INSERT INTO "Business" (name, "updatedAt") VALUES ('sdm1-rollback-refusal', now());
SELECT set_config('app.current_business_id', currval(pg_get_serial_sequence('"Business"', 'id'))::text, true);
INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES (currval(pg_get_serial_sequence('"Business"', 'id')), 'לקוח סינתטי', now());
INSERT INTO "ServiceDevice" ("businessId", "customerId", "displayName")
  VALUES (currval(pg_get_serial_sequence('"Business"', 'id')), currval(pg_get_serial_sequence('"Customer"', 'id')), 'נושא סינתטי');
COMMIT;
SQL
RB="$(psql -X -q -v ON_ERROR_STOP=1 "$(owner_url "${DB}_rbx")" -f "$ROOT/.sdm1/rollback.sql" 2>&1 || true)"
ok "R1 the rollback refuses while a new column holds data, and changes nothing" 'echo "$RB" | grep -q ROLLBACK_REFUSED && present "${DB}_rbx"'
super "DROP DATABASE ${DB}_rbx"
super "DROP DATABASE IF EXISTS ${DB}_rb"; super "CREATE DATABASE ${DB}_rb TEMPLATE $DB OWNER lab_owner"
psql -X -q -v ON_ERROR_STOP=1 "$(owner_url "${DB}_rb")" -f "$ROOT/.sdm1/rollback.sql" >/dev/null
ok "R2 on a clean copy it removes every object of M1 and restores the original guard and CHECKs" 'gone "${DB}_rb"'
ok "R3 its ledger row went with it" \
  'test "$(q "${DB}_rb" "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '"'"'$TRACKS'"'"'")" = "0"'
T="$(mktemp -d)"; stage "$T" "${DB}_rb"; OUT="$(deploy "$T" "${DB}_rb")"; rm -rf "$T"
ok "R4 a plain deploy re-applies M1 (the leftover enum values are skipped)" 'echo "$OUT" | grep -q "Applying migration \`$TRACKS\`" && present "${DB}_rb"'
super "DROP DATABASE ${DB}_rb"

echo
echo "$pass passed, $fail failed"
test "$fail" = "0"
