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
# Case charge (migration 20261126090000): the purge also calls service_case_charge_erase_business(), which reads the
# charge history and the billing links. The lab chain drops their `db push` tables (.sdf/lab.sh), so where the lab does
# not carry the charge, the migration is applied VERBATIM (tables, triggers, policies, grants and function — never a
# copy), on top of P4. A lab that already has the charge tables is left as it is.
CHG="$ROOT/prisma/migrations/20261126090000_service_desk_case_charge/migration.sql"
if [ -f "$CHG" ] && [ "$(psql -X -At "$OWNER_URL" -c "SELECT to_regclass('public.\"ServiceCaseCharge\"') IS NULL")" = "t" ]; then
  PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" -f "$CHG"
  echo "ERASURE PREREQ: case charge applied verbatim from 20261126090000"
fi
# M1 tracks (migration 20261127090000): the purge also calls service_tracks_erase_business(), which blanks M1's columns
# of ServiceCase / ServiceDevice and its two tables, under M1's guards. The lab chain drops their `db push` tables and
# enums (.sdf/lab.sh) and rebuilds the case / device tables from the migrations, so where the lab does not carry M1, the
# migration is applied VERBATIM (types, columns, CHECKs, tables, guards, policies, grants and function — never a copy),
# on top of the charge (its premise). A lab that already has M1's tables is left as it is.
M1="$ROOT/prisma/migrations/20261127090000_service_desk_tracks/migration.sql"
if [ -f "$M1" ] && [ "$(psql -X -At "$OWNER_URL" -c "SELECT to_regclass('public.\"ServiceCompletion\"') IS NULL")" = "t" ]; then
  PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" -f "$M1"
  echo "ERASURE PREREQ: M1 tracks applied verbatim from 20261127090000"
fi
# QA lists (migration 20261129090000): the purge also calls service_qa_lists_erase_business(), which blanks the lists'
# texts and the QA results' notes under the migration's guards. The lab chain drops their `db push` tables and enums
# (.sdf/lab.sh), so where the lab does not carry them the migration is applied VERBATIM (types, tables, CHECKs, guards,
# policies, grants and function — never a copy), on top of M1 (its premise). A lab that already has them is left as it is.
QA="$ROOT/prisma/migrations/20261129090000_service_desk_qa_lists/migration.sql"
if [ -f "$QA" ] && [ "$(psql -X -At "$OWNER_URL" -c "SELECT to_regclass('public.\"ServiceQaList\"') IS NULL")" = "t" ]; then
  PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" -f "$QA"
  echo "ERASURE PREREQ: QA lists applied verbatim from 20261129090000"
fi
echo "ERASURE PREREQ READY: $DB (document_supplier_link_erase_business from 20261103090000, business_documents_erase from 20261114090000, verbatim)"
