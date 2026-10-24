#!/usr/bin/env bash
# OAuth identity foundation / migration 20261030090000_oauth_identity_foundation — Production-topology lab.
#
#   .agl/lab.sh <db-name> [--with-agl | --broken-agl]
#
# Builds on the auth email tokens lab (.aet/lab.sh <db> --with-aet): non-superuser CREATEROLE/BYPASSRLS
# owner, NOLOGIN app_runtime + LOGIN app_runtime_prod, NOLOGIN app_auth (the real D2 E4 narrowing on User)
# + LOGIN member te_auth_login, the owner's DEFAULT PRIVILEGES, Business under B4's FORCE RLS, and the
# ledger through M6 + P3-E + TE + AET. The migrations main merged after M6 other than those stay out of
# the lab ledger, exactly as in the AET lab: their objects come from `db push`, and this migration names
# none of them (step 0 of the workflow asserts that). It depends on User and Business alone.
#   --with-agl:   `prisma migrate deploy` — the release-migrate mechanism — applies it;
#   --broken-agl: the same with it failing on its last statement (atomicity).
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
M6="20261009090000_m6_acquisition_connections"
P3E="20261013090000_p3e_landing_persistence"
TE="20261015090000_transactional_email_foundation"
AET="20261017090000_auth_email_tokens"
AGL="20261030090000_oauth_identity_foundation"
bash "$ROOT/.aet/lab.sh" "$DB" --with-aet >/dev/null
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
psql_owner() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" "$@"; }
# If schema.prisma models the tables / the optional password (the application PR), `db push` built them
# without the migration's policies, functions and grants: put them back the way Production has them today
# so the migration builds them the way Production will have them.
psql_owner -c 'DROP TABLE IF EXISTS "UserIdentity" CASCADE' -c 'DROP TABLE IF EXISTS "OAuthSignupTicket" CASCADE' \
  -c 'ALTER TABLE "User" ALTER COLUMN "password" SET NOT NULL'

case "$MODE" in
  --with-agl|--broken-agl) ;;
  *) echo "LAB READY: $DB (through M6 + P3-E + TE + AET; oauth identity pending)"; exit 0 ;;
esac

TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
for d in "$ROOT"/prisma/migrations/*/; do
  name="$(basename "$d")"
  if [[ ! "$name" > "$M6" || "$name" == "$P3E" || "$name" == "$TE" || "$name" == "$AET" || "$name" == "$AGL" ]]; then
    cp -r "$d" "$TMP/prisma/migrations/$name"
  fi
done
if [ "$MODE" = "--broken-agl" ]; then
  printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$TMP/prisma/migrations/$AGL/migration.sql"
fi
set +e
( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) > "$TMP/deploy.log" 2>&1
rc=$?
set -e
grep -E "Applying migration|have been successfully applied|Error|error" "$TMP/deploy.log" | head -8
rm -rf "$TMP"
if [ "$MODE" = "--broken-agl" ]; then
  [ $rc -ne 0 ] || { echo "broken migration did NOT fail"; exit 1; }
  echo "LAB READY: $DB (oauth identity FAILED on its last statement as intended)"; exit 0
fi
[ $rc -eq 0 ] || { echo "oauth identity deploy failed"; exit 1; }
echo "LAB READY: $DB (oauth identity applied)"
