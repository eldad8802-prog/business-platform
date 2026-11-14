#!/usr/bin/env bash
# The release scripts proven on a lab built like Production (db push = today's schema, a ledger):
#   ledger = Production today (… 20261122090000, then #1105 20261126090000 applied alone on 2026-11-14) →
#   preflight → every check PASS (12); apply the migration; production evidence → every check PASS (12, inert).
#   Negatives (the order guard really guards):
#     N-a  a migration sorting AFTER this one already finished → preflight check 3 FAILS;
#     N-b  #1105 (20261126090000) NOT recorded                 → preflight check 12 FAILS;
#     N-c  this migration already recorded                     → preflight check 2 FAILS.
#   usage: evidence-lab.sh <owner url of the server> <scratch db name>        env: PSQL (optional)
set -euo pipefail
BASE="$1"; DB="$2"; PSQL="${PSQL:-psql}"
URL="${BASE%/*}/$DB"
MIG=prisma/migrations/20261126100000_issuer_declaration/migration.sql
"$PSQL" "$BASE" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE $DB"
DATABASE_URL="$URL" DIRECT_URL="$URL" npx prisma db push --skip-generate > /dev/null
[ -f .issuer-declaration/drop-pushed.sql ] && "$PSQL" "$URL" -v ON_ERROR_STOP=1 -q -f .issuer-declaration/drop-pushed.sql > /dev/null 2>&1 || true
"$PSQL" "$URL" -v ON_ERROR_STOP=1 -q \
  -c 'CREATE TABLE "_prisma_migrations" (id varchar(36) PRIMARY KEY, checksum varchar(64) NOT NULL, finished_at timestamptz, migration_name varchar(255) NOT NULL, logs text, rolled_back_at timestamptz, started_at timestamptz NOT NULL DEFAULT now(), applied_steps_count integer NOT NULL DEFAULT 0)' \
  -c "INSERT INTO \"_prisma_migrations\" VALUES ('lab-1','x',now(),'20261122090000_service_desk_audit_journal',NULL,NULL,now(),1)" \
  -c "INSERT INTO \"_prisma_migrations\" VALUES ('lab-1105','x',now(),'20261126090000_auth_issuer_declaration_link',NULL,NULL,now(),1)"
rows() { "$PSQL" "$URL" -X -f "$1" 2>&1 | grep -E '^ +[0-9]+ \| (PASS|FAIL|INFO)'; }
PRE=$(rows ops/evidence/issuer-declaration-preflight.sql); echo "$PRE"
echo "$PRE" | grep -q "| FAIL" && { echo "::error::preflight has a FAIL on a clean lab"; exit 1; }
[ "$(echo "$PRE" | grep -c '| PASS')" -eq 12 ] || { echo "::error::preflight: expected 12 PASS"; exit 1; }
neg() { # <row id> <migration name> <check that must FAIL> <what>
  "$PSQL" "$URL" -v ON_ERROR_STOP=1 -q -c "INSERT INTO \"_prisma_migrations\" VALUES ('$1','x',now(),'$2',NULL,NULL,now(),1)"
  rows ops/evidence/issuer-declaration-preflight.sql | grep -qE "^ +$3 \| FAIL" || { echo "::error::NEGATIVE-PROOF FAIL: preflight did not refuse — $4"; exit 1; }
  "$PSQL" "$URL" -v ON_ERROR_STOP=1 -q -c "DELETE FROM \"_prisma_migrations\" WHERE id = '$1'"
}
# N-a: a later migration already finished (e.g. a Service Desk one) → check 3 refuses
neg lab-neg-a 20261127090000_service_desk_tracks 3 "a later migration applied ahead of this one"
# N-c: this migration already recorded → check 2 refuses
neg lab-neg-c 20261126100000_issuer_declaration 2 "this migration already recorded"
# N-b: #1105 not recorded → check 12 refuses (its row is removed for the probe, then restored)
"$PSQL" "$URL" -v ON_ERROR_STOP=1 -q -c "DELETE FROM \"_prisma_migrations\" WHERE id = 'lab-1105'"
rows ops/evidence/issuer-declaration-preflight.sql | grep -qE '^ +12 \| FAIL' || { echo "::error::NEGATIVE-PROOF FAIL: preflight did not refuse with #1105 missing"; exit 1; }
"$PSQL" "$URL" -v ON_ERROR_STOP=1 -q -c "INSERT INTO \"_prisma_migrations\" VALUES ('lab-1105','x',now(),'20261126090000_auth_issuer_declaration_link',NULL,NULL,now(),1)"
[ "$(rows ops/evidence/issuer-declaration-preflight.sql | grep -c '| PASS')" -eq 12 ] || { echo "::error::preflight not back to 12 PASS after the negatives"; exit 1; }
"$PSQL" "$URL" -v ON_ERROR_STOP=1 -q -f "$MIG"
"$PSQL" "$URL" -v ON_ERROR_STOP=1 -q -c "INSERT INTO \"_prisma_migrations\" VALUES ('lab-2','x',now(),'20261126100000_issuer_declaration',NULL,NULL,now(),1)"
EV=$(rows ops/evidence/issuer-declaration-production-evidence.sql); echo "$EV"
echo "$EV" | grep -q "| FAIL" && { echo "::error::production evidence has a FAIL after the apply"; exit 1; }
[ "$(echo "$EV" | grep -c '| PASS')" -eq 12 ] || { echo "::error::evidence: expected 12 PASS"; exit 1; }
[ "$(echo "$EV" | grep -E '^ +15 \| INFO' | awk -F'|' '{gsub(/ /,"",$3); print $3}')" = "1" ] || { echo "::error::evidence row 15: #1105 not seen as applied"; exit 1; }
echo "release scripts OK — preflight 12/12 (after #1105), evidence 12/12 (inert), and the order guard refuses: a later migration first, #1105 missing, this one already recorded"
