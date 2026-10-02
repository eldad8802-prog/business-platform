#!/usr/bin/env bash
# Business runtime-columns forensic — PostgreSQL lab.
#
#   .bizcols/lab.sh <db-name>
#
# Production topology from .c594/lab.sh (non-superuser CREATEROLE/BYPASSRLS
# owner, NOLOGIN app_runtime group + LOGIN app_runtime_prod, the owner's default
# ACL, baselined ledger, #594 applied), plus the REAL D2 E4 narrowing migration
# 20260908180000_d2_user_business_privilege_narrowing (which Production applied
# ~2026-09-08 19:21Z) — so the runtime holds exactly the Business privileges that
# migration defines: column SELECT (id, name, createdAt, deletionRequestedAt,
# deletedAt), column UPD (deletionRequestedAt, deletedAt, archivedAt,
# archivedByUserId, updatedAt), no table-level privilege, and Business has NO RLS.
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only.
set -euo pipefail
DB="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# The pre-#594 Production baseline (no migration deploy at all): Business exactly as the
# D2 E4 narrowing left it. #594 does not touch the runtime's Business privileges.
bash "$ROOT/.c594/lab.sh" "$DB" --without-594 >/dev/null
psql -X -v ON_ERROR_STOP=1 -q -U "$SUPER" -d postgres -c \
  "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_auth') THEN CREATE ROLE app_auth NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END \$\$"
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" -f "$ROOT/prisma/migrations/20260908180000_d2_user_business_privilege_narrowing/migration.sql"
echo "LAB READY: $DB (+ D2 E4 Business/User narrowing)"
