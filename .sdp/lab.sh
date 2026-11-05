#!/usr/bin/env bash
# Service Desk 1.2c / M2 (spare parts) — Production-topology lab. NO M2 MIGRATION EXISTS YET.
#
#   .sdp/lab.sh <db-name>
#
# Builds the 1.2b lab with 20261113090000_service_external_work APPLIED (.sdx/lab.sh <db> --with-sdx): the database
# M2 will be released onto. Then it applies the Production tenant RLS of the inventory / suppliers cluster (migration
# 20260825200000_d2_p7_wave3_tenant_rls, run as-is: idempotent, role-free), which the base lab's `db push` does not
# build — M2's references (InventoryItem, InventoryMovement, PurchaseOrder) must be judged under the same FORCE RLS
# as Production.
#
# When an M2 migration (prisma/migrations/*_service_parts) exists in this checkout — it does not today — the lab
# reports it; deploying it is added together with that migration (M2 PR-1, separate owner approval).
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WAVE3="20260825200000_d2_p7_wave3_tenant_rls"
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
psql_owner() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" "$@"; }

bash "$ROOT/.sdx/lab.sh" "$DB" --with-sdx >/dev/null
psql_owner -f "$ROOT/prisma/migrations/$WAVE3/migration.sql"

M2="$(ls -d "$ROOT"/prisma/migrations/*_service_parts 2>/dev/null | head -1 || true)"
if [ -n "$M2" ]; then
  echo "LAB READY: $DB (1.2b applied, inventory RLS as Production; M2 migration present: $(basename "$M2") — deploy step not wired yet)"
else
  echo "LAB READY: $DB (1.2b applied, inventory RLS as Production; no M2 migration in this checkout — M2 checks will report PENDING)"
fi
