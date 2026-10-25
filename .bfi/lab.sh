#!/usr/bin/env bash
# Bank file import (milestone B1) — Production-topology lab.
#
#   .bfi/lab.sh <db-name>
#
# Builds on the revenue truth lab (.rev/lab.sh <db>: the daily tasks lab with its non-superuser CREATEROLE /
# BYPASSRLS owner, NOLOGIN app_runtime + LOGIN app_runtime_prod, the owner's DEFAULT PRIVILEGES, and
# ExternalTransaction / BillingDocument under FORCE RLS), then .bfi/prereq.sql adds what Production has on
# the other tables this path touches and `db push` cannot make: FORCE RLS + tenant policies on
# BusinessBankAccount, ImportRun, ImportRunRow and PayablesAuditEvent, and ExternalTransaction's
# facts-immutable trigger. B1 adds no table and no column; the only database change it ships is the
# feature row (a separate data migration), which the battery inserts itself.
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
bash "$ROOT/.rev/lab.sh" "$DB" >/dev/null
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" -f "$ROOT/.bfi/prereq.sql"
echo "LAB READY: $DB (bank file import: RLS on the touched tables, ExternalTransaction facts immutable)"
