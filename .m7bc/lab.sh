#!/usr/bin/env bash
# M7-B/C / migration 20261014090000_m7bc_commerce_demand_and_line_labels — Production-topology lab.
#
#   .m7bc/lab.sh <db-name> [--with-m7bc | --broken-m7bc]
#
# Production as it is now and will be when this migration is released: M7-A applied (D10, release-migrate
# 37510820420), then P3-E applied alone (release-migrate 37526326039, 2026-10-06) — and this migration the ONLY
# one applied next.
#   1. .m7a/lab.sh <db> --with-m7a — Production after M7-A (non-superuser CREATEROLE/BYPASSRLS owner, NOLOGIN
#      app_runtime + LOGIN app_runtime_prod, DEFAULT PRIVILEGES, app_auth / app_ctlplane, B4, P2, P3-A, M6 and
#      M7-A by the real `prisma migrate deploy`; sec-C / M3 / M4 / P1 DB-only objects by .m7a/prereq.sql);
#   2. what the pushed schema already holds of THIS migration is removed (it must create it as Production will):
#      OfferingDemandSignal."commerceOrderLineId" and the OfferingDemandSource 'COMMERCE' value (the type is
#      rebuilt with the two Production values); P1's OfferingDemandSignal RLS + runtime privileges, verbatim
#      (.m7bc/prereq.sql);
#   3. P3-E as Production applied it: its pushed tables / types are dropped and `prisma migrate deploy` applies
#      every migration through P3-E (only P3-E is pending at that point) — its policies, triggers and grants real;
#   4. --with-m7bc: `prisma migrate deploy` through this migration — which therefore applies exactly it, alone.
#      --broken-m7bc: it fails at its last statement (atomicity).
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
P3E="20261013090000_p3e_landing_persistence"
M7BC="20261014090000_m7bc_commerce_demand_and_line_labels"
bash "$ROOT/.m7a/lab.sh" "$DB" --with-m7a >/dev/null
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
q() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" "$@"; }

# 2. The pushed copies of what this migration adds go; it creates them.
q -c 'ALTER TABLE "OfferingDemandSignal" DROP COLUMN IF EXISTS "commerceOrderLineId"' \
  -c 'DROP INDEX IF EXISTS "CommerceOrderLine_id_businessId_key"'
if [ "$(q -Atc "SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'OfferingDemandSource' AND e.enumlabel = 'COMMERCE'")" = "1" ]; then
  q -c 'ALTER TABLE "OfferingDemandSignal" DROP CONSTRAINT IF EXISTS "OfferingDemandSignal_identity"' \
    -c 'ALTER TYPE "OfferingDemandSource" RENAME TO "OfferingDemandSource_pushed"' \
    -c "CREATE TYPE \"OfferingDemandSource\" AS ENUM ('APPOINTMENT', 'SALE')" \
    -c 'ALTER TABLE "OfferingDemandSignal" ALTER COLUMN "source" TYPE "OfferingDemandSource" USING "source"::text::"OfferingDemandSource"' \
    -c 'DROP TYPE "OfferingDemandSource_pushed"'
  q -f "$ROOT/.m7a/prereq.sql"   # the P1 identity CHECK again, verbatim
fi
# P1's row-level security and runtime privileges on OfferingDemandSignal, verbatim (Production has them).
q -f "$ROOT/.m7bc/prereq.sql"

deploy_upto() {  # deploy_upto <last-migration-name> [broken]
  local TMP; TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
  cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
  cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
  for d in "$ROOT"/prisma/migrations/*/; do
    local name; name="$(basename "$d")"
    [[ "$name" > "$1" ]] && continue
    cp -r "$d" "$TMP/prisma/migrations/$name"
  done
  if [ "${2:-}" = "broken" ]; then
    printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$TMP/prisma/migrations/$1/migration.sql"
  fi
  set +e
  ( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) > "$TMP/deploy.log" 2>&1
  local rc=$?
  set -e
  grep -E "Applying migration|have been successfully applied|Error|error" "$TMP/deploy.log" | head -6
  if [ $rc -ne 0 ] && [ "${2:-}" != "broken" ]; then echo "--- migrate deploy log (rc=$rc) ---" >&2; tail -40 "$TMP/deploy.log" >&2; fi
  rm -rf "$TMP"
  return $rc
}

# 3. P3-E, as Production applied it (alone, after M7-A).
q -c 'DROP TABLE IF EXISTS "LandingPageVersion", "LandingPage" CASCADE' \
  -c 'DROP TYPE IF EXISTS "LandingVersionStatus", "LandingVersionAuthority" CASCADE'
deploy_upto "$P3E" >/dev/null

case "$MODE" in
  --with-m7bc) deploy_upto "$M7BC" ;;
  --broken-m7bc) deploy_upto "$M7BC" broken || true ;;
  "") ;;
  *) echo "unknown mode $MODE" >&2; exit 2 ;;
esac
