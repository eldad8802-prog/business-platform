#!/usr/bin/env bash
# Service Desk 1.2a PR-2 — prerequisites of .sdf/erasure-battery.ts on a lab built by `.sdf/lab.sh <db> --with-sdf`.
#
# The battery runs the REAL account-deletion purge, which calls every module's erasure function. The lab chain
# builds Document ↔ supplier links with `db push` (its PR-2 is merged) and records migration 20261103090000 in the
# ledger without running it, so Production's document_supplier_link_erase_business() is missing here. It is taken
# VERBATIM from that migration — never a copy that could drift — and granted as that migration grants it.
# The same for business_documents_erase() (migration 20261114090000, applied in Production; the purge calls it since
# the business-documents erasure wiring): its tables come from `db push` in this chain, only the function is created.
#
#   .sdf/erasure-prereq.sh <db-name>        env: PGHOST, PGPORT, LAB_PASSWORD (optional)
set -euo pipefail
DB="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DSL="$ROOT/prisma/migrations/20261103090000_document_supplier_link/migration.sql"
BD="$ROOT/prisma/migrations/20261114090000_business_documents_records/migration.sql"
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
FN="$(sed -n '/^CREATE OR REPLACE FUNCTION public\.document_supplier_link_erase_business()/,/^REVOKE ALL ON FUNCTION public\.document_supplier_link_erase_business() FROM PUBLIC;$/p' "$DSL")"
[ -n "$FN" ] || { echo "document_supplier_link_erase_business() not found in $DSL"; exit 1; }
BDFN="$(sed -n '/^CREATE OR REPLACE FUNCTION public\.business_documents_erase()/,/^REVOKE ALL ON FUNCTION public\.business_documents_erase() FROM PUBLIC;$/p' "$BD")"
[ -n "$BDFN" ] || { echo "business_documents_erase() not found in $BD"; exit 1; }
{ echo "$FN"; echo "GRANT EXECUTE ON FUNCTION public.document_supplier_link_erase_business() TO app_runtime;"
  echo "$BDFN"; echo "GRANT EXECUTE ON FUNCTION public.business_documents_erase() TO app_runtime;"; } \
  | PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL"
# P4 (migration 20261122090000): the purge also calls service_settings_journal_erase_business(), which reads the settings
# journal. Where the lab does not carry P4, the migration is applied VERBATIM (its table, triggers, policies, grants and
# function — never a copy), on top of 1.3-0. A lab that already has the journal is left as it is.
P4="$ROOT/prisma/migrations/20261122090000_service_desk_audit_journal/migration.sql"
if [ -f "$P4" ] && [ "$(psql -X -At "$OWNER_URL" -c "SELECT to_regclass('public.\"ServiceSettingsEvent\"') IS NULL")" = "t" ]; then
  PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" -f "$P4"
  echo "ERASURE PREREQ: P4 audit journal applied verbatim from 20261122090000"
fi
echo "ERASURE PREREQ READY: $DB (document_supplier_link_erase_business from 20261103090000, business_documents_erase from 20261114090000, verbatim)"
# A1 (erasure audit 2026-11-10): the purge's terminal transition now also renames the business. Production's runtime
# holds UPDATE ("name") on Business since migration 20261011090100 (applied); this lab chain records that migration in the
# ledger without running it, so the grant is missing here. It is taken VERBATIM from that migration — never widened.
REN="$ROOT/prisma/migrations/20261011090100_signup_consent_business_rename/migration.sql"
NAME_GRANT="$(grep -oF 'GRANT UPDATE ("name") ON "Business" TO app_runtime;' "$REN" | head -1)"
[ -n "$NAME_GRANT" ] || { echo "the Business name grant was not found in $REN"; exit 1; }
if [ "$(psql -X -At "$OWNER_URL" -c "SELECT has_column_privilege('app_runtime', 'public.\"Business\"', 'name', 'UPDATE')")" != "t" ]; then
  echo "$NAME_GRANT" | PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL"
fi
