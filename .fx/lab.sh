#!/usr/bin/env bash
# Currency settings + FX rates / migration 20261025090000_currency_settings_fx_rates — Production-topology lab.
#
#   .fx/lab.sh build <db>             Production as it is today: the task reminders lab (.trp/lab.sh <db> --with-trp:
#                                     non-superuser CREATEROLE/BYPASSRLS owner whose DEFAULT PRIVILEGES hand new
#                                     tables to the runtime, NOLOGIN NOBYPASSRLS app_runtime + LOGIN app_runtime_prod,
#                                     app_auth, FORCE RLS on Business and the task tables), then the ledger completed
#                                     with EVERY migration on main (real sha256), as Production's ledger is. Pending:
#                                     only this migration.
#   .fx/lab.sh apply <db> [--broken]  `prisma migrate deploy` — the release-migrate mechanism — over ALL migration
#                                     directories of this checkout, which therefore applies exactly this one;
#                                     --broken: a copy failing on its last statement (atomicity).
#
# Production's early history does not replay from an empty database (its ledger is baselined — .c594/lab.sh), so
# "apply all migrations" here means what release-migrate does: every directory present, only the pending applied.
# If schema.prisma already models this migration (the application PR), `db push` built the tables without the
# migration's checks, policies, triggers, functions and grants: they are removed first.
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD (optional). Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
CMD="$1"; DB="$2"; MODE="${3:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FX="20261025090000_currency_settings_fx_rates"
OWNER_URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@${PGHOST}:${PGPORT}/${DB}"
psql_owner() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$OWNER_URL" "$@"; }

case "$CMD" in
build)
  bash "$ROOT/.trp/lab.sh" "$DB" --with-trp >/dev/null
  psql_owner <<'SQL'
DROP TABLE IF EXISTS "UserLocalePreference", "BusinessLocaleSettings", "FxRate" CASCADE;
DROP FUNCTION IF EXISTS public.business_base_currency_locked();
DROP FUNCTION IF EXISTS public.business_locale_base_currency_lock();
DROP FUNCTION IF EXISTS public.business_financial_data_exists(integer);
DROP FUNCTION IF EXISTS public.fx_rate_append_only_guard();
SQL
  LEDGER="$(mktemp)"
  for d in "$ROOT"/prisma/migrations/*/; do
    name="$(basename "$d")"
    [ "$name" = "$FX" ] && continue
    sum="$(sha256sum "$d/migration.sql" | cut -d' ' -f1)"
    echo "INSERT INTO \"_prisma_migrations\" (id, checksum, finished_at, migration_name, applied_steps_count)
          SELECT gen_random_uuid()::text, '$sum', now(), '$name', 1
          WHERE NOT EXISTS (SELECT 1 FROM \"_prisma_migrations\" WHERE migration_name = '$name');" >> "$LEDGER"
  done
  psql_owner -f "$LEDGER"; rm -f "$LEDGER"
  pending=$(psql_owner -At -c "SELECT count(*) FROM \"_prisma_migrations\"")
  echo "LAB READY: $DB (ledger: $pending migrations recorded, every one on main; $FX pending)"
  ;;
apply)
  TMP="$(mktemp -d)"; mkdir -p "$TMP/prisma/migrations"
  cp "$ROOT/prisma/schema.prisma" "$TMP/prisma/schema.prisma"
  cp "$ROOT/prisma/migrations/migration_lock.toml" "$TMP/prisma/migrations/"
  for d in "$ROOT"/prisma/migrations/*/; do cp -r "$d" "$TMP/prisma/migrations/$(basename "$d")"; done
  if [ "$MODE" = "--broken" ]; then
    printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$TMP/prisma/migrations/$FX/migration.sql"
  fi
  set +e
  ( cd "$ROOT" && DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" node_modules/.bin/prisma migrate deploy --schema "$TMP/prisma/schema.prisma" ) > "$TMP/deploy.log" 2>&1
  rc=$?
  set -e
  grep -E "migrations found|Applying migration|have been successfully applied|No pending|Error|error" "$TMP/deploy.log" | head -8
  rm -rf "$TMP"
  if [ "$MODE" = "--broken" ]; then
    [ $rc -ne 0 ] || { echo "broken migration did NOT fail"; exit 1; }
    echo "LAB READY: $DB (currency/fx FAILED on its last statement as intended)"; exit 0
  fi
  [ $rc -eq 0 ] || { echo "currency/fx deploy failed"; exit 1; }
  echo "LAB READY: $DB (currency/fx applied by prisma migrate deploy)"
  ;;
*) echo "usage: .fx/lab.sh build|apply <db> [--broken]"; exit 2 ;;
esac
