#!/usr/bin/env bash
# Revenue report uploads (Z reports, settlement reports) — Production-topology lab. docs/revenue-report-uploads.md
#
#   .rru/lab.sh <db-name>
#
# 1. the revenue truth lab WITH the real revenue truth migration (.rev/lab.sh <db> --with-rev): non-superuser
#    CREATEROLE / BYPASSRLS owner, NOLOGIN app_runtime + LOGIN app_runtime_prod, the owner's DEFAULT PRIVILEGES,
#    the Revenue* tables exactly as Production has them (FORCE RLS, SELECT / INSERT only for the runtime,
#    append-only triggers);
# 2. .bfi/prereq.sql: FORCE RLS + tenant policies on ImportRun / ImportRunRow (the run ledger) and the other
#    tables bank file import touches, as Production has them;
# 3. the feature rows of this milestone, through its own data migration file (both OFF).
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
psql_owner() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" "$@"; }

bash "$ROOT/.rev/lab.sh" "$DB" --with-rev
psql_owner -f "$ROOT/.bfi/prereq.sql"
psql_owner -f "$ROOT/prisma/migrations/20261111090000_revenue_report_upload_features/migration.sql"
# Twice: the data migration is idempotent.
psql_owner -f "$ROOT/prisma/migrations/20261111090000_revenue_report_upload_features/migration.sql"
echo "LAB READY: $DB (revenue truth applied, run ledger under RLS, z_report_upload / settlement_report_upload OFF)"
