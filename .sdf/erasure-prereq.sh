#!/usr/bin/env bash
# Service Desk 1.2a PR-2 — prerequisites of .sdf/erasure-battery.ts on a lab built by `.sdf/lab.sh <db> --with-sdf`.
#
# The battery runs the REAL account-deletion purge, which calls every module's erasure function. The lab chain
# builds Document ↔ supplier links with `db push` (its PR-2 is merged) and records migration 20261103090000 in the
# ledger without running it, so Production's document_supplier_link_erase_business() is missing here. It is taken
# VERBATIM from that migration — never a copy that could drift — and granted as that migration grants it.
#
#   .sdf/erasure-prereq.sh <db-name>        env: PGHOST, PGPORT, LAB_PASSWORD (optional)
set -euo pipefail
DB="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DSL="$ROOT/prisma/migrations/20261103090000_document_supplier_link/migration.sql"
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
FN="$(sed -n '/^CREATE OR REPLACE FUNCTION public\.document_supplier_link_erase_business()/,/^REVOKE ALL ON FUNCTION public\.document_supplier_link_erase_business() FROM PUBLIC;$/p' "$DSL")"
[ -n "$FN" ] || { echo "document_supplier_link_erase_business() not found in $DSL"; exit 1; }
{ echo "$FN"; echo "GRANT EXECUTE ON FUNCTION public.document_supplier_link_erase_business() TO app_runtime;"; } \
  | PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL"
echo "ERASURE PREREQ READY: $DB (document_supplier_link_erase_business from 20261103090000, verbatim)"
