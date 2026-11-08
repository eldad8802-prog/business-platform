#!/usr/bin/env bash
# Appointments open for every business / migration 20261115100000_appointments_open_all — on a lab already built by
# `.bkg/lab.sh <db> --with-bkg` (and seeded): the release exactly as Production will run it.
#
#   .appt/open-all-lab.sh <db-name>
#
#   1. The read-only preflight (ops/evidence/appointments-open-all-preflight.sql), as the evidence lane runs it: not
#      recorded yet, ledger clean, both rows present and OFF, emergency OFF, public_booking OFF globally.
#   2. The ledger is completed with every migration of this checkout that sorts between the public booking foundation
#      and this one (real sha256), as Production's will be — pending: only this migration.
#   3. `prisma migrate deploy` — the release-migrate mechanism — applies exactly this one.
#   4. The read-only proof (ops/evidence/appointments-open-all-production-evidence.sql): recorded once with the pinned
#      checksum, appointments ON, public_booking untouched, and every override count and the switched-on booking links
#      identical to the preflight's — the migration added and changed no business decision.
#
# env: PGHOST, PGPORT, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BKG="20261106090000_public_booking_foundation"
OPEN="20261115100000_appointments_open_all"
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
psql_owner() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" "$@"; }
# n|flag|count rows only (the \echo legend is dropped).
evidence() { psql_owner -At -F'|' -f "$1" | grep -E '^[0-9]+\|' ; }
val() { awk -F'|' -v n="$2" '$1 == n { print ($3 != "" ? $3 : $2) }' <<<"$1"; }
expect() { local got; got="$(val "$1" "$2")"; [ "$got" = "$3" ] || { echo "FAIL $4: check $2 = '$got', expected '$3'"; exit 1; }; echo "  [PASS] $4 (check $2 = $3)"; }

echo "1. preflight"
PRE="$(evidence "$ROOT/ops/evidence/appointments-open-all-preflight.sql")"
echo "$PRE"
expect "$PRE" 1 t "the lab owner reads past RLS, as the evidence role does"
expect "$PRE" 2 t "the migration is not recorded yet"
expect "$PRE" 3 0 "the ledger is clean"
expect "$PRE" 4 t "one definition row and one policy row"
expect "$PRE" 5 t "both are still OFF"
expect "$PRE" 6 f "the emergency switch is OFF"
expect "$PRE" 10 t "public_booking is OFF globally"

echo "2. ledger"
LEDGER="$(mktemp)"
for d in "$ROOT"/prisma/migrations/*/; do
  name="$(basename "$d")"
  [[ "$name" > "$BKG" ]] || continue
  [[ "$name" < "$OPEN" ]] || continue
  sum="$(sha256sum "$d/migration.sql" | cut -d' ' -f1)"
  echo "INSERT INTO \"_prisma_migrations\" (id, checksum, finished_at, migration_name, applied_steps_count)
        SELECT gen_random_uuid()::text, '$sum', now(), '$name', 1
        WHERE NOT EXISTS (SELECT 1 FROM \"_prisma_migrations\" WHERE migration_name = '$name');" >> "$LEDGER"
done
[ -s "$LEDGER" ] && psql_owner -f "$LEDGER"; rm -f "$LEDGER"

echo "3. migrate deploy"
TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
for d in "$ROOT"/prisma/migrations/*/; do [[ "$(basename "$d")" > "$OPEN" ]] && continue; cp -r "$d" "$TMP/prisma/migrations/$(basename "$d")"; done
( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) > "$TMP/deploy.log" 2>&1 \
  || { cat "$TMP/deploy.log"; exit 1; }
grep -E "migrations found|Applying migration|have been successfully applied|No pending" "$TMP/deploy.log" | head -6
applied="$(grep -cE "Applying migration" "$TMP/deploy.log" || true)"
[ "$applied" = "1" ] && grep -q "Applying migration \`$OPEN\`" "$TMP/deploy.log" \
  || { echo "FAIL: expected exactly $OPEN to be applied, got $applied"; cat "$TMP/deploy.log"; exit 1; }
rm -rf "$TMP"
echo "  [PASS] migrate deploy applied exactly $OPEN"

echo "4. proof"
POST="$(evidence "$ROOT/ops/evidence/appointments-open-all-production-evidence.sql")"
echo "$POST"
expect "$POST" 2 t "recorded once, finished, with the pinned checksum"
expect "$POST" 3 0 "nothing pending or rolled back"
expect "$POST" 4 t "appointments: definition ON, policy ON, emergency OFF"
expect "$POST" 5 t "public_booking untouched (OFF by default, OFF globally, emergency OFF)"
expect "$POST" 6 "$(val "$PRE" 7)" "appointments ENABLED overrides unchanged"
expect "$POST" 7 "$(val "$PRE" 8)" "appointments DISABLED overrides unchanged"
expect "$POST" 8 "$(val "$PRE" 11)" "public_booking ENABLED overrides unchanged"
expect "$POST" 9 "$(val "$PRE" 12)" "switched-on booking links unchanged"
echo "OPEN-ALL LAB READY: $DB ($OPEN applied)"
