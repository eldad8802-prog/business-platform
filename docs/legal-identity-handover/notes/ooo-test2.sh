#!/usr/bin/env bash
# Out-of-order proof for 20261128100000 (LOCAL LAB ONLY), step 2: later-named migrations finished first, then this one.
set -uo pipefail
export PATH="/c/Program Files/PostgreSQL/18/bin:$PATH"
R="/c/Users/מחשב/OneDrive/Documents/GitHub/wt-corr-db"
BP="/c/Users/מחשב/OneDrive/Documents/GitHub/business-platform"
DB=lic_ooo; PW=lic_local_synthetic_pw
OWNER_URL="postgresql://lab_owner:$PW@localhost:55441/$DB"
own() { PGOPTIONS="-c client_min_messages=warning" psql -X -q -v ON_ERROR_STOP=1 "$OWNER_URL" "$@"; }
sup() { psql -X -q -v ON_ERROR_STOP=1 -h localhost -p 55441 -U lab_super -d $DB "$@"; }
LIC=20261128100000_legal_identity_correction
SD1123="db/service-desk-ui-erasure-text-v2:20261123090000_service_desk_ui_erasure_text"
MARK=20261215090000_lab_later_marker
SCR="C:/Users/84D7~1/AppData/Local/Temp/claude/6c9ec2bb6eb46f91/fbe09a2d-a0d5-47af-aa18-5b680b88ebed/scratchpad"
mkdir -p "$SCR/ooo-$MARK"; printf 'CREATE TABLE "LabLaterMarker" ("id" INTEGER PRIMARY KEY);\n' > "$SCR/ooo-$MARK/migration.sql"

echo "== lab cleanup: drop the failed Service Desk 20261125 attempt (lab only; it failed on lab fidelity, nothing applied)"
sup -At -c "DELETE FROM \"_prisma_migrations\" WHERE migration_name = '20261125090000_service_desk_handover_owner_confirmed' AND finished_at IS NULL RETURNING migration_name"

mkdirs() {
  local T="$1"; mkdir -p "$T/prisma/migrations"
  cp "$R/prisma/schema.prisma" "$T/prisma/"; cp "$R/prisma/migrations/migration_lock.toml" "$T/prisma/migrations/"
  for n in $(own -At -c 'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL' | sed 's/[^0-9A-Za-z_]//g'); do
    if [ -d "$R/prisma/migrations/$n" ]; then cp -r "$R/prisma/migrations/$n" "$T/prisma/migrations/$n"
    elif [ "$n" = "${SD1123##*:}" ]; then mkdir -p "$T/prisma/migrations/$n"; ( cd "$BP" && MSYS_NO_PATHCONV=1 git show "origin/${SD1123%%:*}:prisma/migrations/$n/migration.sql" ) > "$T/prisma/migrations/$n/migration.sql"
    elif [ "$n" = "$MARK" ]; then cp -r "$SCR/ooo-$MARK" "$T/prisma/migrations/$MARK"
    else echo "UNKNOWN ledger entry $n"; fi
  done
}
deploy() { ( cd "$R" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$1/prisma/schema.prisma" ) 2>&1 | grep -E "Applying|applied|Error|error|P3|up to date" | head -12; }
ledger() { own -At -c "SELECT '$1: finished=' || count(*) FILTER (WHERE finished_at IS NOT NULL) || ' unfinished=' || count(*) FILTER (WHERE finished_at IS NULL) || ' rolled_back=' || count(*) FILTER (WHERE rolled_back_at IS NOT NULL) || ' max=' || max(migration_name) FROM \"_prisma_migrations\""; }

echo "== A. a later-named migration ($MARK) finishes FIRST (also 20261126100000 as in Production)"
TA="$(mktemp -d)"; mkdirs "$TA"
cp -r "$R/prisma/migrations/20261126100000_issuer_declaration" "$TA/prisma/migrations/"; cp -r "$SCR/ooo-$MARK" "$TA/prisma/migrations/$MARK"
deploy "$TA"; rm -rf "$TA"; ledger "after A"

echo "== PREFLIGHT before (expect 9/9)"
own -f "$R/ops/evidence/legal-identity-correction-preflight.sql" | grep -E '^ +[0-9]+ \| (PASS|FAIL)' | tr -s ' ' | tr '\n' ';'; echo

echo "== prisma migrate status sees exactly one pending, sorting BEFORE finished ones"
TS="$(mktemp -d)"; mkdirs "$TS"; cp -r "$R/prisma/migrations/$LIC" "$TS/prisma/migrations/"
( cd "$R" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate status --schema "$TS/prisma/schema.prisma" ) 2>&1 | grep -E "migrations found|not yet been applied|^2026|up to date|drift|order" | head -6

echo "== B. the correction migration LAST"
deploy "$TS"; ledger "after B"
( cd "$R" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate status --schema "$TS/prisma/schema.prisma" ) 2>&1 | grep -E "up to date|not yet|failed" | head -3
rm -rf "$TS"

echo "== EVIDENCE after (expect 14/14)"
own -f "$R/ops/evidence/legal-identity-correction-production-evidence.sql" | grep -cE '^ +[0-9]+ \| PASS'
echo "== #1140 evidence still whole (expect 12/12)"
own -f "$R/ops/evidence/signup-legal-identity-production-evidence.sql" | grep -cE '^ +[0-9]+ \| PASS'
echo "== the later-named objects untouched"
own -At -c "SELECT 'marker table=' || (to_regclass('public.\"LabLaterMarker\"') IS NOT NULL) || ' sd1123 finished=' || (SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name LIKE '20261123%' AND finished_at IS NOT NULL)"
