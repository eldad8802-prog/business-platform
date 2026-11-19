#!/usr/bin/env bash
# Service Desk — the schema the APPLICATION CODE of this checkout needs, on a lab that proved its own migration first.
#
# Release order is migration-first: the P4 audit journal (20261122090000), 1.3c (#1096, 20261125090000), the case charge
# (#1104, 20261126090000) and M1 tracks (20261127090000) are applied before the code that reads / writes their objects is
# deployed (openCase writes M1's columns on every case). A lab that builds its database only up to its own feature
# (1.3-0, P4, 1.3c, the charge …) and then runs the service code batteries therefore first brings the database to that
# state — AFTER everything it proves about its own migration (pending state, atomicity, evidence) and BEFORE the code.
#
# Each migration that is missing is applied VERBATIM from prisma/migrations (never a copy that could drift), as the owner
# role, in one transaction (psql -1, as `prisma migrate deploy` applies it), in name order. One already in place is left
# as it is, so the script is idempotent and can follow .sdcharge/chain.sh, .sdm1/chain.sh or .sdf/erasure-prereq.sh.
# Each migration's own preconditions still guard it (the charge refuses without P4, M1 without the charge).
#
#   .sdf/code-prereq.sh <db-name | owner-url>        env: PGHOST, PGPORT, LAB_PASSWORD (optional)
set -euo pipefail
ARG="${1:?usage: code-prereq.sh <db-name | owner-url>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
case "$ARG" in
  postgres://*|postgresql://*) OWNER_URL="$ARG" ;;
  *) OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${ARG}" ;;
esac
q() { psql -X -At "$OWNER_URL" -c "$1" | tr -d '\r'; }

# <migration dir> | <SQL that is true when the migration is already in place>
STEPS=(
  "20261122090000_service_desk_audit_journal|SELECT to_regclass('public.\"ServiceSettingsEvent\"') IS NOT NULL"
  "20261125090000_service_desk_handover_owner_confirmed|SELECT to_regclass('public.\"ServiceHandover\"') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ServiceHandover_signed' AND conrelid = 'public.\"ServiceHandover\"'::regclass)"
  "20261126090000_service_desk_case_charge|SELECT to_regclass('public.\"ServiceCaseCharge\"') IS NOT NULL"
  "20261127090000_service_desk_tracks|SELECT to_regclass('public.\"ServiceCompletion\"') IS NOT NULL"
)
applied=()
for s in "${STEPS[@]}"; do
  name="${s%%|*}"; probe="${s#*|}"
  sql="$ROOT/prisma/migrations/$name/migration.sql"
  [ -f "$sql" ] || { echo "CODE PREREQ: $name is not in this checkout — skipped"; continue; }
  if [ "$(q "$probe")" = "t" ]; then echo "CODE PREREQ: $name already in place"; continue; fi
  PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q -1 "$OWNER_URL" -f "$sql"
  [ "$(q "$probe")" = "t" ] || { echo "CODE PREREQ: $name applied but its objects are not in place"; exit 1; }
  echo "CODE PREREQ: $name applied verbatim"
  applied+=("$name")
done
echo "CODE PREREQ READY: ${#applied[@]} applied${applied:+ (${applied[*]})}"
