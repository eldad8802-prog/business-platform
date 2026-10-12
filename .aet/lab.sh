#!/usr/bin/env bash
# Auth email tokens / migration 20261017090000_auth_email_tokens — Production-topology lab.
#
#   .aet/lab.sh <db-name> [--with-aet | --broken-aet]
#
# Builds on the transactional email lab (.te/lab.sh <db> --with-te): non-superuser CREATEROLE/BYPASSRLS
# owner, NOLOGIN app_runtime + LOGIN app_runtime_prod, NOLOGIN app_auth (the real D2 E4 narrowing on User)
# + LOGIN member te_auth_login, the owner's DEFAULT PRIVILEGES, Business under B4's FORCE RLS, and the
# ledger through M6 + P3-E + transactional email. The migrations main merged after M6 other than those two
# stay out of the lab ledger, exactly as in the TE lab: their objects come from `db push`, and this
# migration names none of them (step 0 of the workflow asserts that). It depends on User, Business and
# AuthSession alone.
#   --with-aet:   `prisma migrate deploy` — the release-migrate mechanism — applies it;
#   --broken-aet: the same with it failing on its last statement (atomicity).
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
M6="20261009090000_m6_acquisition_connections"
P3E="20261013090000_p3e_landing_persistence"
TE="20261015090000_transactional_email_foundation"
AET="20261017090000_auth_email_tokens"
bash "$ROOT/.te/lab.sh" "$DB" --with-te >/dev/null
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
psql_owner() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" "$@"; }
# If schema.prisma models the table / column (the application PR), `db push` built them without the
# migration's policies, functions and grants: remove them so the migration builds them the way Production
# will have them.
psql_owner -c 'DROP TABLE IF EXISTS "AuthEmailToken" CASCADE' -c 'ALTER TABLE "User" DROP COLUMN IF EXISTS "emailVerifiedAt"'

case "$MODE" in
  --with-aet|--broken-aet) ;;
  *) echo "LAB READY: $DB (through M6 + P3-E + TE; auth email tokens pending)"; exit 0 ;;
esac

TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
for d in "$ROOT"/prisma/migrations/*/; do
  name="$(basename "$d")"
  if [[ ! "$name" > "$M6" || "$name" == "$P3E" || "$name" == "$TE" || "$name" == "$AET" ]]; then cp -r "$d" "$TMP/prisma/migrations/$name"; fi
done
if [ "$MODE" = "--broken-aet" ]; then
  printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$TMP/prisma/migrations/$AET/migration.sql"
fi
set +e
( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) > "$TMP/deploy.log" 2>&1
rc=$?
set -e
grep -E "Applying migration|have been successfully applied|Error|error" "$TMP/deploy.log" | head -8
rm -rf "$TMP"
if [ "$MODE" = "--broken-aet" ]; then
  [ $rc -ne 0 ] || { echo "broken migration did NOT fail"; exit 1; }
  echo "LAB READY: $DB (auth email tokens FAILED on its last statement as intended)"; exit 0
fi
[ $rc -eq 0 ] || { echo "auth email tokens deploy failed"; exit 1; }
echo "LAB READY: $DB (auth email tokens applied)"
