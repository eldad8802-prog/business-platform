#!/usr/bin/env bash
# Beta cohort enrollment / migration 20261017090000_beta_cohort_enrollment — Production-topology lab.
#
#   .beta/lab.sh <db-name> [--with-beta | --broken-beta]
#
# Production as it is now: everything through M7-B/C (.m7bc/lab.sh --with-m7bc builds exactly that, by the
# real `prisma migrate deploy`, with Production's roles, default privileges and RLS), then the two migrations
# released after it, each applied on its own as release-migrate did (TransactionalEmail, payments core), then
# this migration the ONLY one applied next. (.paycore/lab.sh is not reused: since the application PR of the
# transactional email modelled its table, `db push` builds it before its migration runs; it is dropped here,
# exactly as .te/lab.sh does, so the migration builds it the way Production has it.)
#   --with-beta:   `prisma migrate deploy` — the release-migrate mechanism — applies it, alone;
#   --broken-beta: the same with it failing on its last statement (atomicity).
# A LOGIN member of app_auth (beta_auth_login) is created so the battery can act as the signup plane.
# If schema.prisma models the table (the application PR), `db push` built it without the migration's
# policies and grants: it is dropped so the migration builds it the way Production will have it.
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BETA="20261017090000_beta_cohort_enrollment"
bash "$ROOT/.m7bc/lab.sh" "$DB" --with-m7bc >/dev/null
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
psql_owner() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" "$@"; }
psql_owner -c 'DROP TABLE IF EXISTS "TransactionalEmail" CASCADE' -c 'DROP TABLE IF EXISTS "BusinessBetaEnrollment" CASCADE'
# Likewise the payments core's objects (its application PR modelled them): the migration creates them itself.
psql_owner -c 'DROP INDEX IF EXISTS "BusinessPaymentConnection_one_default_per_business"' \
  -c 'ALTER TABLE "BusinessPaymentConnection" DROP COLUMN IF EXISTS "documentIssuer", DROP COLUMN IF EXISTS "isDefault"' \
  -c 'DROP TYPE IF EXISTS "PaymentDocumentIssuer"'
# Production's row-level security on the payments core's table, verbatim (a db push omits it).
psql_owner -f "$ROOT/.paycore/prereq.sql"
# The signup-plane login the battery acts as (Production: app_auth_prod). Created by the superuser:
# granting membership in app_auth needs ADMIN on it, which lab_owner (like Production's owner) lacks.
psql_super() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q -U "$SUPER" -d "$DB" "$@"; }
psql_super -c "DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'beta_auth_login') THEN
    CREATE ROLE beta_auth_login LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${LAB_PASSWORD:-}' IN ROLE app_auth;
  END IF; END \$\$"

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
  grep -E "Applying migration|have been successfully applied|Error|error" "$TMP/deploy.log" | head -8
  if [ $rc -ne 0 ] && [ "${2:-}" != "broken" ]; then echo "--- migrate deploy log (rc=$rc) ---" >&2; tail -40 "$TMP/deploy.log" >&2; fi
  rm -rf "$TMP"
  return $rc
}

# The two released after M7-B/C, each alone, in order.
deploy_upto "20261015090000_transactional_email_foundation" >/dev/null
deploy_upto "20261016090000_payments_core_connection_config" >/dev/null

case "$MODE" in
  --with-beta)
    deploy_upto "$BETA" || { echo "beta cohort enrollment deploy failed"; exit 1; }
    echo "LAB READY: $DB (beta cohort enrollment applied)" ;;
  --broken-beta)
    if deploy_upto "$BETA" broken; then echo "broken migration did NOT fail"; exit 1; fi
    echo "LAB READY: $DB (beta cohort enrollment FAILED on its last statement as intended)" ;;
  "") echo "LAB READY: $DB (through the payments core; beta cohort enrollment pending)" ;;
  *) echo "unknown mode $MODE" >&2; exit 2 ;;
esac
