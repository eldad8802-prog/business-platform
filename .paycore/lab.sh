#!/usr/bin/env bash
# Payments core / migration 20261016090000_payments_core_connection_config — Production-topology lab.
#
#   .paycore/lab.sh <db-name> [--with-paycore | --broken-paycore]
#
# Production as it will be when this migration is released: everything through M7-B/C applied
# (.m7bc/lab.sh --with-m7bc builds exactly that, by the real `prisma migrate deploy`, with
# Production's roles, default privileges and RLS), and this migration the ONLY one applied next.
#   --with-paycore:   `prisma migrate deploy` through this migration — it applies exactly it, alone.
#   --broken-paycore: it fails at its last statement (atomicity).
#
# This PR adds no schema.prisma change, so the pushed schema holds nothing of this migration and
# nothing needs removing before it runs.
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PAYCORE="20261016090000_payments_core_connection_config"
bash "$ROOT/.m7bc/lab.sh" "$DB" --with-m7bc >/dev/null
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
# Production's row-level security on the table this migration widens, verbatim (a db push omits it).
PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" -f "$ROOT/.paycore/prereq.sql"

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

case "$MODE" in
  --with-paycore) deploy_upto "$PAYCORE" ;;
  --broken-paycore) deploy_upto "$PAYCORE" broken || true ;;
  "") ;;
  *) echo "unknown mode $MODE" >&2; exit 2 ;;
esac
