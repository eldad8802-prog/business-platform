#!/usr/bin/env bash
# Business documents records / migration 20261114090000_business_documents_records — Production-topology lab.
#
#   .business-documents/lab.sh <db-name> [--with-bd | --broken-bd]
#
# Builds on the public booking lab (.bkg/lab.sh <db> --with-bkg → appointments → accountant → Daily Tasks chain):
# non-superuser CREATEROLE/BYPASSRLS owner (lab_owner), NOLOGIN app_runtime + LOGIN app_runtime_prod, the owner's
# DEFAULT PRIVILEGES, FORCE RLS where Production has it. schema.prisma models the business-documents tables, so the
# `db push` inside the base lab built them without the migration's constraints, triggers, functions, policies and
# grants: they are removed here so the migration builds them the way Production will.
# The ledger is completed with every migration of this checkout that sorts between the public booking foundation and
# this one (real sha256). Pending: only this migration.
#   --with-bd:   `prisma migrate deploy` — the release-migrate mechanism — applies exactly this one;
#   --broken-bd: the same with it failing on its last statement (atomicity: nothing of it may remain).
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"; MODE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BKG="20261106090000_public_booking_foundation"
BD="20261114090000_business_documents_records"
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
psql_owner() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" "$@"; }

bash "$ROOT/.bkg/lab.sh" "$DB" --with-bkg >/dev/null

psql_owner <<'SQL'
DROP TABLE IF EXISTS "QuoteShareEvent", "QuoteShareCopy", "BusinessLetter", "BusinessDocumentRequest",
  "BusinessDocumentErasure", "BusinessDocumentFile" CASCADE;
DROP TYPE IF EXISTS "BusinessDocumentFilePurpose", "BusinessDocumentFileState", "BusinessDocumentOperation",
  "BusinessDocumentRequestState", "QuoteShareEventKind", "QuoteShareChannel", "BusinessLetterRecipientKind",
  "BusinessDocumentErasureState";
DELETE FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'business_documents';
DELETE FROM "PlatformFeatureDefinition" WHERE "key" = 'business_documents';
SQL

LEDGER="$(mktemp)"
for d in "$ROOT"/prisma/migrations/*/; do
  name="$(basename "$d")"
  [[ "$name" > "$BKG" ]] || continue
  [[ "$name" < "$BD" ]] || continue
  sum="$(sha256sum "$d/migration.sql" | cut -d' ' -f1)"
  echo "INSERT INTO \"_prisma_migrations\" (id, checksum, finished_at, migration_name, applied_steps_count)
        SELECT gen_random_uuid()::text, '$sum', now(), '$name', 1
        WHERE NOT EXISTS (SELECT 1 FROM \"_prisma_migrations\" WHERE migration_name = '$name');" >> "$LEDGER"
done
[ -s "$LEDGER" ] && psql_owner -f "$LEDGER"; rm -f "$LEDGER"

case "$MODE" in
  --with-bd|--broken-bd) ;;
  *) echo "LAB READY: $DB (ledger = every migration before this one; business documents records pending)"; exit 0 ;;
esac

TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
for d in "$ROOT"/prisma/migrations/*/; do [[ "$(basename "$d")" > "$BD" ]] && continue; cp -r "$d" "$TMP/prisma/migrations/$(basename "$d")"; done
if [ "$MODE" = "--broken-bd" ]; then
  printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$TMP/prisma/migrations/$BD/migration.sql"
fi
set +e
( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) > "$TMP/deploy.log" 2>&1
rc=$?
set -e
grep -E "migrations found|Applying migration|have been successfully applied|No pending|Error|error" "$TMP/deploy.log" | head -8
rm -rf "$TMP"
if [ "$MODE" = "--broken-bd" ]; then
  [ $rc -ne 0 ] || { echo "broken migration did NOT fail"; exit 1; }
  echo "LAB READY: $DB (business documents records FAILED on its last statement as intended)"; exit 0
fi
[ $rc -eq 0 ] || { echo "business documents records deploy failed"; exit 1; }
echo "LAB READY: $DB (business documents records applied)"
