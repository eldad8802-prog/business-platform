#!/usr/bin/env bash
# sec-B lab — a FRESH database built by `prisma migrate deploy` (never db push).
#
# Usage: OWNER_URL=postgresql://owner@host:port/db bash .secb/build-lab.sh
#
# The repository's migration history is not replayable from empty exactly as
# ordered: 20260210120000_billing_invoice_profile_fields is back-dated before
# the init that creates "BusinessProfile" (known baseline debt, see
# d2-cutover-3a-ci.yml). It is idempotent (ADD COLUMN IF NOT EXISTS), so the lab
# marks it applied, deploys EVERY other migration in order, then executes its
# SQL — the same end state Production reached. Nothing else is special-cased.
#
# Roles the shipped privilege migrations GRANT/REVOKE against are created first
# (NOLOGIN, NOBYPASSRLS), as they exist in Production before those migrations ran.
set -euo pipefail
: "${OWNER_URL:?OWNER_URL is required}"
export DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL"
BACKDATED=20260210120000_billing_invoice_profile_fields

psql "$OWNER_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['app_runtime','app_auth','app_admin','app_control_plane','app_erasure','app_reader'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOBYPASSRLS', r);
    END IF;
  END LOOP;
END $$;
SQL

npx prisma migrate resolve --applied "$BACKDATED" >/dev/null
npx prisma migrate deploy
psql "$OWNER_URL" -v ON_ERROR_STOP=1 -q -f "prisma/migrations/$BACKDATED/migration.sql"
npx prisma migrate status
echo "LAB BUILT FROM MIGRATIONS"
