#!/usr/bin/env bash
# Signup legal identity / migrations 20261128090000_signup_legal_identity and 20261128100000_legal_identity_correction
# — Production-topology lab.
#
#   .sli/lab.sh <db-name> [--with-sli | --broken-sli | --with-correction | --broken-correction]
#
# Builds on the issuer-declaration link lab (.agl/lab.sh <db> --with-issuer: non-superuser BYPASSRLS owner, NOLOGIN
# app_runtime + LOGIN app_runtime_prod, NOLOGIN app_auth + LOGIN te_auth_login with the real column grants on
# Business, the ledger through 20261126090000). `db push` builds BusinessProfile without Production's policy and
# grants, so the two migrations that give it them in Production are replayed (both idempotent): FORCE RLS with the
# tenant policy (20260825120000) and the runtime's SELECT/INSERT/UPDATE (20260915120000).
#   (no flag)            baseline: the signup legal identity migration pending;
#   --with-sli:          `prisma migrate deploy` — the release-migrate mechanism — applies 20261128090000;
#   --broken-sli:        the same with it failing on its last statement (atomicity);
#   --with-correction:   one `migrate deploy` applies 20261128090000 then 20261128100000 (the correction requests);
#   --broken-correction: the same with the correction migration failing on its last statement (atomicity: the
#                        signup migration before it commits, the correction leaves nothing).
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SLI="20261128090000_signup_legal_identity"
LIC="20261128100000_legal_identity_correction"
bash "$ROOT/.agl/lab.sh" "$DB" --with-issuer >/dev/null
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
psql_owner() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" "$@"; }
psql_owner -f "$ROOT/prisma/migrations/20260825120000_d2_p7_wave1_businessprofile_rls/migration.sql"
psql_owner -f "$ROOT/prisma/migrations/20260915120000_businessprofile_runtime_grants/migration.sql"
# If schema.prisma models the columns / the table (the application PRs), `db push` built them without the
# migrations' constraints, policies and triggers: remove them so the migrations build them the way Production will.
psql_owner -c 'ALTER TABLE "BusinessProfile" DROP COLUMN IF EXISTS "legalIdentityConfirmedAt", DROP COLUMN IF EXISTS "legalIdentitySource"'
psql_owner -c 'DROP TABLE IF EXISTS "LegalIdentityCorrectionRequest" CASCADE'

case "$MODE" in
  --with-sli|--broken-sli|--with-correction|--broken-correction) ;;
  *) echo "LAB READY: $DB (through 20261126090000; signup legal identity pending)"; exit 0 ;;
esac

# The platform-admin read plane, as Production has it: NOLOGIN app_admin (NOBYPASSRLS; reads through its p7adm_read
# policies) + a LOGIN member for the battery. Created before the correction migration so its role-guarded block runs.
if [[ "$MODE" == --*-correction ]]; then
  psql_owner -c "DO \$\$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin') THEN CREATE ROLE app_admin NOLOGIN NOBYPASSRLS; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lic_admin_login') THEN
      CREATE ROLE lic_admin_login LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${LAB_PASSWORD:-}' IN ROLE app_admin; END IF;
  END \$\$;"
  psql_owner -c "GRANT USAGE ON SCHEMA public TO app_admin"
fi

# The migrations directory = exactly the lab ledger + the migration(s) under test, so `migrate deploy` applies only them.
TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
WANT="$SLI"
if [[ "$MODE" == --*-correction ]]; then WANT="$SLI $LIC"; fi
for name in $(psql_owner -At -c 'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL') $WANT; do
  cp -r "$ROOT/prisma/migrations/$name" "$TMP/prisma/migrations/$name"
done
if [ "$MODE" = "--broken-sli" ]; then
  printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$TMP/prisma/migrations/$SLI/migration.sql"
fi
if [ "$MODE" = "--broken-correction" ]; then
  printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$TMP/prisma/migrations/$LIC/migration.sql"
fi
set +e
( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) > "$TMP/deploy.log" 2>&1
rc=$?
set -e
grep -E "Applying migration|have been successfully applied|Error|error" "$TMP/deploy.log" | head -8
rm -rf "$TMP"
if [[ "$MODE" == --broken-* ]]; then
  [ $rc -ne 0 ] || { echo "broken migration did NOT fail"; exit 1; }
  echo "LAB READY: $DB ($MODE: the migration FAILED on its last statement as intended)"; exit 0
fi
[ $rc -eq 0 ] || { echo "legal identity deploy failed"; exit 1; }
if [ "$MODE" = "--with-correction" ]; then echo "LAB READY: $DB (signup legal identity + correction requests applied)"; exit 0; fi
echo "LAB READY: $DB (signup legal identity applied)"
