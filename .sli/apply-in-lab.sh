#!/usr/bin/env bash
# Apply migration 20261128090000_signup_legal_identity to an EXISTING lab database (.agl/lab.sh and friends), for
# the batteries that sign up through the real routes: since 2026-11-12 the register / Google-complete routes write
# the legal identity inside the account transaction through signup_legal_identity_seed, which this migration adds.
#
#   .sli/apply-in-lab.sh <db-name>
#
# `db push` built the two confirmation columns from the model without the migration's checks, function and
# trigger: they are dropped first, then the shipped file runs verbatim as the lab owner (the definer). Its own
# lab (.sli/lab.sh, signup-legal-identity-lab.yml) proves it through `prisma migrate deploy`; here it is a
# prerequisite only. env: PGHOST, PGPORT, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
DB="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
psql_owner() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" "$@"; }
psql_owner -c 'ALTER TABLE "BusinessProfile" DROP COLUMN IF EXISTS "legalIdentityConfirmedAt", DROP COLUMN IF EXISTS "legalIdentitySource"'
psql_owner -1 -f "$ROOT/prisma/migrations/20261128090000_signup_legal_identity/migration.sql"
echo "signup legal identity applied to $DB"
