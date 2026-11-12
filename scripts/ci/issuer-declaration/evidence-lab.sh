#!/usr/bin/env bash
# The release scripts proven on a lab built like Production (db push = today's schema, a ledger):
#   preflight → every check PASS; apply the migration; production evidence → every check PASS (and inert).
#   Negative: with #1105 (20261126090000) recorded first, preflight check 3 FAILS (release order guard).
#   usage: evidence-lab.sh <owner url of the server> <scratch db name>        env: PSQL (optional)
set -euo pipefail
BASE="$1"; DB="$2"; PSQL="${PSQL:-psql}"
URL="${BASE%/*}/$DB"
MIG=prisma/migrations/20261123090000_issuer_declaration/migration.sql
"$PSQL" "$BASE" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE $DB"
DATABASE_URL="$URL" DIRECT_URL="$URL" npx prisma db push --skip-generate > /dev/null
[ -f .issuer-declaration/drop-pushed.sql ] && "$PSQL" "$URL" -v ON_ERROR_STOP=1 -q -f .issuer-declaration/drop-pushed.sql > /dev/null 2>&1 || true
"$PSQL" "$URL" -v ON_ERROR_STOP=1 -q \
  -c 'CREATE TABLE "_prisma_migrations" (id varchar(36) PRIMARY KEY, checksum varchar(64) NOT NULL, finished_at timestamptz, migration_name varchar(255) NOT NULL, logs text, rolled_back_at timestamptz, started_at timestamptz NOT NULL DEFAULT now(), applied_steps_count integer NOT NULL DEFAULT 0)' \
  -c "INSERT INTO \"_prisma_migrations\" VALUES ('lab-1','x',now(),'20261122090000_service_desk_audit_journal',NULL,NULL,now(),1)"
rows() { "$PSQL" "$URL" -X -f "$1" 2>&1 | grep -E '^ +[0-9]+ \| (PASS|FAIL|INFO)'; }
PRE=$(rows ops/evidence/issuer-declaration-preflight.sql); echo "$PRE"
echo "$PRE" | grep -q "| FAIL" && { echo "::error::preflight has a FAIL on a clean lab"; exit 1; }
[ "$(echo "$PRE" | grep -c '| PASS')" -eq 11 ] || { echo "::error::preflight: expected 11 PASS"; exit 1; }
# negative: #1105 (20261126090000) applied alone first → the preflight refuses (check 3); the row is then removed
"$PSQL" "$URL" -v ON_ERROR_STOP=1 -q -c "INSERT INTO \"_prisma_migrations\" VALUES ('lab-neg','x',now(),'20261126090000_auth_issuer_declaration_link',NULL,NULL,now(),1)"
rows ops/evidence/issuer-declaration-preflight.sql | grep -qE '^ +3 \| FAIL' || { echo "::error::NEGATIVE-PROOF FAIL: preflight did not refuse #1105 applied first"; exit 1; }
"$PSQL" "$URL" -v ON_ERROR_STOP=1 -q -c "DELETE FROM \"_prisma_migrations\" WHERE id = 'lab-neg'"
"$PSQL" "$URL" -v ON_ERROR_STOP=1 -q -f "$MIG"
"$PSQL" "$URL" -v ON_ERROR_STOP=1 -q -c "INSERT INTO \"_prisma_migrations\" VALUES ('lab-2','x',now(),'20261123090000_issuer_declaration',NULL,NULL,now(),1)"
EV=$(rows ops/evidence/issuer-declaration-production-evidence.sql); echo "$EV"
echo "$EV" | grep -q "| FAIL" && { echo "::error::production evidence has a FAIL after the apply"; exit 1; }
[ "$(echo "$EV" | grep -c '| PASS')" -eq 12 ] || { echo "::error::evidence: expected 12 PASS"; exit 1; }
echo "release scripts OK — preflight 11/11, evidence 12/12 (inert), and the order guard refuses #1105 applied first"
