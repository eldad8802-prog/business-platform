#!/usr/bin/env bash
# Document ↔ supplier link / migration 20261103090000_document_supplier_link — Production-topology lab.
#
#   .dsl/lab.sh <db-name> [--with-dsl | --broken-dsl]
#
# Builds on the appointments lab (.appt/lab.sh <db> --with-appt, itself on the accountant / task reminders / Daily
# Tasks chain): non-superuser CREATEROLE/BYPASSRLS owner, NOLOGIN app_runtime + LOGIN app_runtime_prod, NOLOGIN
# app_auth, the owner's DEFAULT PRIVILEGES, Business under FORCE RLS, every lab migration of that chain applied by
# `prisma migrate deploy`. Then .dsl/prereq.sql adds what Production has and `db push` cannot make (the
# Supplier (businessId, id) unique constraint of 20261018090000).
# The ledger is completed with EVERY other migration on this checkout that sorts before this one (real sha256), as
# Production's is (20261102090000_oauth_identity_link, the last one applied in Production, included). Pending: only
# this migration. Any migration sorting after it is left out of ledger and deploy — release-migrate applies an
# approved prefix only.
# schema.prisma may model the new tables and columns (the application PR), so the `db push` inside the base lab may
# have built them without the migration's constraints, policies, triggers, functions and grants: they are removed
# here so the migration builds them the way Production will have them.
#   --with-dsl:   `prisma migrate deploy` — the release-migrate mechanism — over every migration directory up to and
#                 including this one, which therefore applies exactly this one;
#   --broken-dsl: the same with it failing on its last statement (atomicity);
#   --redeploy:   on an EXISTING lab database (after a rollback), only the staged `prisma migrate deploy`.
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DSL="20261103090000_document_supplier_link"
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
psql_owner() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" "$@"; }

if [ "$MODE" != "--redeploy" ]; then
bash "$ROOT/.appt/lab.sh" "$DB" --with-appt >/dev/null

psql_owner <<'SQL'
DROP TABLE IF EXISTS "DocumentSupplierLinkEvent", "DocumentSupplierLink" CASCADE;
ALTER TABLE "ExtractedData"
  DROP CONSTRAINT IF EXISTS "ExtractedData_issuerCheck_shape",
  DROP CONSTRAINT IF EXISTS "ExtractedData_issuerCheck",
  DROP CONSTRAINT IF EXISTS "ExtractedData_issuerTaxId_together",
  DROP CONSTRAINT IF EXISTS "ExtractedData_issuerTaxIdSource",
  DROP CONSTRAINT IF EXISTS "ExtractedData_issuerTaxId_shape",
  DROP COLUMN IF EXISTS "issuerTaxId", DROP COLUMN IF EXISTS "issuerTaxIdSource", DROP COLUMN IF EXISTS "issuerTaxIdValid",
  DROP COLUMN IF EXISTS "issuerCheck", DROP COLUMN IF EXISTS "ownBusinessExcluded";
DROP FUNCTION IF EXISTS public.document_supplier_link_erase_business();
DROP FUNCTION IF EXISTS public.document_supplier_link_event_guard();
DROP FUNCTION IF EXISTS public.document_supplier_link_user_same_business();
DELETE FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'document_supplier_linking';
DELETE FROM "PlatformFeatureDefinition" WHERE "key" = 'document_supplier_linking';
SQL
psql_owner -f "$ROOT/.dsl/prereq.sql"

# Production's ledger: every migration of this checkout that sorts before this one is recorded and finished.
LEDGER="$(mktemp)"
for d in "$ROOT"/prisma/migrations/*/; do
  name="$(basename "$d")"
  [ "$name" = "$DSL" ] && continue
  [[ "$name" > "$DSL" ]] && continue
  sum="$(sha256sum "$d/migration.sql" | cut -d' ' -f1)"
  echo "INSERT INTO \"_prisma_migrations\" (id, checksum, finished_at, migration_name, applied_steps_count)
        SELECT gen_random_uuid()::text, '$sum', now(), '$name', 1
        WHERE NOT EXISTS (SELECT 1 FROM \"_prisma_migrations\" WHERE migration_name = '$name');" >> "$LEDGER"
done
psql_owner -f "$LEDGER"; rm -f "$LEDGER"
fi

case "$MODE" in
  --with-dsl|--broken-dsl|--redeploy) ;;
  *) echo "LAB READY: $DB (ledger = every migration before this one; document supplier link pending)"; exit 0 ;;
esac

TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
for d in "$ROOT"/prisma/migrations/*/; do [[ "$(basename "$d")" > "$DSL" ]] && continue; cp -r "$d" "$TMP/prisma/migrations/$(basename "$d")"; done
if [ "$MODE" = "--broken-dsl" ]; then
  printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$TMP/prisma/migrations/$DSL/migration.sql"
fi
set +e
( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) > "$TMP/deploy.log" 2>&1
rc=$?
set -e
grep -E "migrations found|Applying migration|have been successfully applied|No pending|Error|error" "$TMP/deploy.log" | head -8
rm -rf "$TMP"
if [ "$MODE" = "--broken-dsl" ]; then
  [ $rc -ne 0 ] || { echo "broken migration did NOT fail"; exit 1; }
  echo "LAB READY: $DB (document supplier link FAILED on its last statement as intended)"; exit 0
fi
[ $rc -eq 0 ] || { echo "document supplier link deploy failed"; exit 1; }
echo "LAB READY: $DB (document supplier link applied)"
