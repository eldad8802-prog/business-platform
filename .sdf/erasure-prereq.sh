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
# A7 case fields (migration 20261214090000, applied in Production 2026-11-20): the purge also calls
# service_case_fields_erase_business(), which blanks the loans' texts and the case's item-location note. Where the lab
# rebuilt ServiceCase from the migrations (no A7 column), the copies `db push` built from schema.prisma (the loan table,
# Task."serviceCaseId") are dropped and the migration is applied VERBATIM (columns, CHECKs, table, guard, policies,
# grants, functions, Task FK — never a copy), on top of M1 and 1.3-0 (its premises). Where db push already built the
# columns and the table, only the function is taken verbatim and granted as the migration grants it. A lab that already
# has the function is left as it is.
A7="$ROOT/prisma/migrations/20261214090000_service_desk_case_fields/migration.sql"
if [ -f "$A7" ] && [ "$(psql -X -At "$OWNER_URL" -c "SELECT to_regprocedure('public.service_case_fields_erase_business()') IS NULL")" = "t" ]; then
  if [ "$(psql -X -At "$OWNER_URL" -c "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ServiceCase' AND column_name = 'itemLocationNote'")" = "0" ]; then
    psql -X -q -v ON_ERROR_STOP=1 "$OWNER_URL" -c 'DROP TABLE IF EXISTS "ServiceCaseLoaner" CASCADE; ALTER TABLE "Task" DROP COLUMN IF EXISTS "serviceCaseId";' >/dev/null
    PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" -f "$A7"
    echo "ERASURE PREREQ: A7 case fields applied verbatim from 20261214090000"
  else
    A7FN="$(sed -n '/^CREATE OR REPLACE FUNCTION public\.service_case_fields_erase_business()/,/^REVOKE ALL ON FUNCTION public\.service_case_fields_erase_business() FROM PUBLIC;$/p' "$A7")"
    [ -n "$A7FN" ] || { echo "service_case_fields_erase_business() not found in $A7"; exit 1; }
    { echo "$A7FN"; echo "GRANT EXECUTE ON FUNCTION public.service_case_fields_erase_business() TO app_runtime;"; } \
      | PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL"
    echo "ERASURE PREREQ: service_case_fields_erase_business() taken verbatim from 20261214090000"
  fi
fi
# Issuer declaration (#1081, migration 20261126100000): the purge also calls issuer_declaration_erase(). Where the lab has
# no declaration table, the migration is applied VERBATIM; where `db push` already built the table (schema.prisma models
# it), only the function is taken verbatim from the migration and granted as the migration grants it.
ID="$ROOT/prisma/migrations/20261126100000_issuer_declaration/migration.sql"
if [ -f "$ID" ] && [ "$(psql -X -At "$OWNER_URL" -c "SELECT to_regprocedure('public.issuer_declaration_erase()') IS NULL")" = "t" ]; then
  if [ "$(psql -X -At "$OWNER_URL" -c "SELECT to_regclass('public.\"BusinessIssuerDeclaration\"') IS NULL")" = "t" ]; then
    PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" -f "$ID"
    echo "ERASURE PREREQ: issuer declaration applied verbatim from 20261126100000"
  else
    IDFN="$(sed -n '/^CREATE OR REPLACE FUNCTION public\.issuer_declaration_erase()/,/^REVOKE ALL ON FUNCTION public\.issuer_declaration_erase() FROM PUBLIC;$/p' "$ID")"
    [ -n "$IDFN" ] || { echo "issuer_declaration_erase() not found in $ID"; exit 1; }
    { echo "$IDFN"; echo "GRANT EXECUTE ON FUNCTION public.issuer_declaration_erase() TO app_runtime;"; }       | PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL"
    echo "ERASURE PREREQ: issuer_declaration_erase() taken verbatim from 20261126100000"
  fi
fi
echo "ERASURE PREREQ READY: $DB (document_supplier_link_erase_business from 20261103090000, business_documents_erase from 20261114090000, verbatim)"
