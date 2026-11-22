#!/usr/bin/env bash
# Apply ONE migration the way release-migrate does it: prisma migrate deploy over a staged directory = every migration the
# ledger already holds + the given one. Exactly one migration must be applied. A7 on a lab whose earlier steps left copies
# of its loan table / Task."serviceCaseId" (built from schema.prisma, without the ServiceCase columns) drops those first.
# Synthetic lab only. env: OWNER_URL.
set -euo pipefail
M="$1"
if [ "$M" = "20261214090000_service_desk_case_fields" ]; then
  if [ "$(psql "$OWNER_URL" -X -tA -c "SELECT count(*) FROM _prisma_migrations WHERE migration_name = '$M' AND finished_at IS NOT NULL" 2>/dev/null || echo 0)" != "0" ]; then
    echo "A7 already in the ledger"; exit 0
  fi
  psql "$OWNER_URL" -X -q -v ON_ERROR_STOP=1 -c 'DROP TABLE IF EXISTS "ServiceCaseLoaner" CASCADE; ALTER TABLE "Task" DROP COLUMN IF EXISTS "serviceCaseId";'
fi
STAGE="$(mktemp -d)"; mkdir -p "$STAGE/prisma/migrations"
cp prisma/schema.prisma "$STAGE/prisma/schema.prisma"
cp prisma/migrations/migration_lock.toml "$STAGE/prisma/migrations/"
for n in $(psql "$OWNER_URL" -At -c 'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL'); do
  [ -d "prisma/migrations/$n" ] && cp -r "prisma/migrations/$n" "$STAGE/prisma/migrations/$n"
done
cp -r "prisma/migrations/$M" "$STAGE/prisma/migrations/"
DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" npx prisma migrate deploy --schema "$STAGE/prisma/schema.prisma" | tee /tmp/deploy.out
grep -qF "Applying migration \`$M\`" /tmp/deploy.out
test "$(grep -c 'Applying migration' /tmp/deploy.out)" = "1"
