#!/usr/bin/env bash
# Leads L1 · G-01b / migration 20261108090000_lead_claimed_phone — Production-topology lab.
#
#   .lcp/lab.sh <db-name> [--with-lcp | --broken-lcp | --deploy-only]
#
# Builds on the public booking lab (.bkg/lab.sh <db> --with-bkg): the same roles (non-superuser BYPASSRLS owner,
# NOLOGIN app_runtime + LOGIN app_runtime_prod, app_auth), every migration up to the booking foundation applied or
# recorded. schema.prisma does not model "claimedPhone" yet (migration-first), so `db push` never built it here.
# The ledger is completed with every migration of this checkout that sorts between the booking foundation and this
# one (real sha256), as Production's will be. Pending: only this migration.
#   --with-lcp:    `prisma migrate deploy` — the release-migrate mechanism — applies exactly this one;
#   --broken-lcp:  the same with it failing on its last statement (atomicity);
#   --deploy-only: skip the base lab and the ledger (a lab already built by a plain run, with rows added in between).
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BKG="20261106090000_public_booking_foundation"
LCP="20261108090000_lead_claimed_phone"
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
psql_owner() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" "$@"; }

if [ "$MODE" != "--deploy-only" ]; then
bash "$ROOT/.bkg/lab.sh" "$DB" --with-bkg >/dev/null
# What Production has on "Lead" that `db push` cannot make (RLS + the partial open-phone index).
psql_owner -f "$ROOT/.lcp/prereq.sql"

# Nothing of this migration may pre-exist (it is not in schema.prisma; asserted, not assumed).
psql_owner <<'SQL'
DO $c$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Lead' AND column_name = 'claimedPhone') THEN
    RAISE EXCEPTION 'lab: Lead.claimedPhone exists before the migration';
  END IF;
END $c$;
SQL

LEDGER="$(mktemp)"
for d in "$ROOT"/prisma/migrations/*/; do
  name="$(basename "$d")"
  [[ "$name" > "$BKG" ]] || continue
  [[ "$name" < "$LCP" ]] || continue
  sum="$(sha256sum "$d/migration.sql" | cut -d' ' -f1)"
  echo "INSERT INTO \"_prisma_migrations\" (id, checksum, finished_at, migration_name, applied_steps_count)
        SELECT gen_random_uuid()::text, '$sum', now(), '$name', 1
        WHERE NOT EXISTS (SELECT 1 FROM \"_prisma_migrations\" WHERE migration_name = '$name');" >> "$LEDGER"
done
[ -s "$LEDGER" ] && psql_owner -f "$LEDGER"; rm -f "$LEDGER"
fi

case "$MODE" in
  --with-lcp|--broken-lcp|--deploy-only) ;;
  *) echo "LAB READY: $DB (ledger = every migration before this one; Lead.claimedPhone pending)"; exit 0 ;;
esac

TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
for d in "$ROOT"/prisma/migrations/*/; do [[ "$(basename "$d")" > "$LCP" ]] && continue; cp -r "$d" "$TMP/prisma/migrations/$(basename "$d")"; done
if [ "$MODE" = "--broken-lcp" ]; then
  printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$TMP/prisma/migrations/$LCP/migration.sql"
fi
set +e
( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) > "$TMP/deploy.log" 2>&1
rc=$?
set -e
grep -E "migrations found|Applying migration|have been successfully applied|No pending|Error|error" "$TMP/deploy.log" | head -8
rm -rf "$TMP"
if [ "$MODE" = "--broken-lcp" ]; then
  [ $rc -ne 0 ] || { echo "broken migration did NOT fail"; exit 1; }
  echo "LAB READY: $DB (Lead.claimedPhone FAILED on its last statement as intended)"; exit 0
fi
[ $rc -eq 0 ] || { echo "Lead.claimedPhone deploy failed"; exit 1; }
echo "LAB READY: $DB (Lead.claimedPhone applied)"
