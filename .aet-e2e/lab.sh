#!/usr/bin/env bash
# Builds the aet_e2e lab DB on the local PG18 lab cluster (127.0.0.1:55531). Synthetic only.
set -euo pipefail
ROOT=C:/dev/bp-auth-rec
PSQL="C:/Program Files/PostgreSQL/18/bin/psql"
export PGPASSWORD=aet_ci_synthetic_super_pw
OWNER_URL="postgresql://lab_super:aet_ci_synthetic_super_pw@127.0.0.1:55531/aet_e2e"
cd "$ROOT"
OWNER_URL="$OWNER_URL" npx tsx .aet-e2e/setup-lab.ts
for m in 20261015090000_transactional_email_foundation 20261017090000_auth_email_tokens; do
  echo "applying $m verbatim (psql -1 -f)"
  "$PSQL" -X -h 127.0.0.1 -p 55531 -U lab_super -d aet_e2e -v ON_ERROR_STOP=1 -q -1 -f "prisma/migrations/$m/migration.sql"
done
echo "LAB READY (aet_e2e)"
