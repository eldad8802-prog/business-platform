#!/usr/bin/env bash
# M7-A / migration 20261013090000_m7a_commerce_telephony_foundation — Production-topology lab.
#
#   .m7a/lab.sh <db-name> [--with-m7a | --broken-m7a]
#
# Production as it will be when M7-A is released: every migration up to and including
# 20261012090000_closed_loop_recommendation_evidence applied, M7-A the ONLY pending migration.
#   1. .m6/lab.sh <db> --with-m6 — Production after M6 (non-superuser CREATEROLE/BYPASSRLS owner,
#      NOLOGIN app_runtime + LOGIN app_runtime_prod, the owner's DEFAULT PRIVILEGES — which hand the
#      runtime DELETE on every new table unless a migration revokes it —, app_auth / app_ctlplane,
#      B4, P2, the P3-A pair, M6 by the real `prisma migrate deploy`);
#   2. every migration after M6 and before M7-A recorded applied with its real checksum (their
#      objects are in the pushed schema, exactly as in Production);
#   3. the DB-only objects M7-A builds on, created exactly as their migrations created them in
#      Production (a `db push` cannot): sec-C's Customer / Lead (businessId, id) keys and the M3 / M4
#      IntakeNormalizedEvent route vocabularies;
#   4. the four M7-A tables the pushed schema already holds are removed (M7-A must create them
#      exactly as Production will);
#   5. --with-m7a: `prisma migrate deploy` up to and including M7-A — which therefore applies exactly
#      M7-A, alone. --broken-m7a: M7-A fails at its last statement (atomicity).
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
M6="20261009090000_m6_acquisition_connections"
M7A="20261013090000_m7a_commerce_telephony_foundation"
bash "$ROOT/.m6/lab.sh" "$DB" --with-m6 >/dev/null
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
q() { psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" "$@"; }

# 2. Production's ledger between M6 and M7-A.
for d in "$ROOT"/prisma/migrations/*/; do
  name="$(basename "$d")"
  [[ "$name" =~ ^[0-9]{14}_ ]] || continue
  [[ "$name" > "$M6" && "$name" < "$M7A" ]] || continue
  sum="$(sha256sum "$d/migration.sql" | cut -d" " -f1)"
  q -c "INSERT INTO \"_prisma_migrations\" (id, checksum, finished_at, migration_name, applied_steps_count) VALUES (gen_random_uuid()::text, '$sum', now(), '$name', 1)"
done

# 3. DB-only objects M7-A builds on, as their migrations created them (sec-C, M3, M4).
q -f "$ROOT/.m7a/prereq.sql"

# 4. The pushed copies of the M7-A tables go; M7-A creates them.
q -c 'DROP TABLE IF EXISTS "CommerceOrderEvent", "CommerceOrderLine", "CommerceOrder", "CallActivity" CASCADE'

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
  --with-m7a) deploy_upto "$M7A" ;;
  --broken-m7a) deploy_upto "$M7A" broken || true ;;
  "") ;;
  *) echo "unknown mode $MODE" >&2; exit 2 ;;
esac
