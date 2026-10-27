#!/usr/bin/env bash
# Migration 20261105090000_accountant_link_events — lab proof (the accountant workflow applied first, then this).
#
#   1. baseline (.acct/lab.sh --with-acct): the PREFLIGHT passes whole, the proof refuses; the new types are
#      refused, the old ones accepted;
#   2. this migration applied by `prisma migrate deploy` over the lab's ledger (the release-migrate mechanism,
#      with exactly this one migration pending): the proof passes whole and the preflight fails exactly its
#      "not there yet" checks (4 7 8); then .acct/link-events-battery.ts PHASE=after;
#   3. atomicity: the migration failing on its last statement leaves the 2026-10-27 constraint in place;
#   4. rollback: refused while a row uses a new value; on a fresh lab it restores the 2026-10-27 list.
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD. Synthetic only. ZERO secrets. ZERO network.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIG="20261105090000_accountant_link_events"
P="${LAB_PASSWORD:-}"
url() { echo "postgresql://$1${P:+:$P}@${PGHOST}:${PGPORT}/$2"; }
owner_sql() { PGOPTIONS="-c client_min_messages=warning" psql -X -v ON_ERROR_STOP=1 -q "$(url lab_owner "$1")" "${@:2}"; }

# Applies MIG with `prisma migrate deploy`: every other migration up to it recorded as applied (as lab.sh does).
deploy() {
  local db="$1" broken="${2:-}" tmp; tmp="$(mktemp -d)"; mkdir -p "$tmp/prisma/migrations"
  cp "$ROOT/prisma/schema.prisma" "$tmp/prisma/schema.prisma"
  cp "$ROOT/prisma/migrations/migration_lock.toml" "$tmp/prisma/migrations/"
  local ledger; ledger="$(mktemp)"
  for d in "$ROOT"/prisma/migrations/*/; do
    local n; n="$(basename "$d")"
    [[ "$n" > "$MIG" ]] && continue
    cp -r "$d" "$tmp/prisma/migrations/$n"
    [ "$n" = "$MIG" ] && continue
    echo "INSERT INTO \"_prisma_migrations\" (id, checksum, finished_at, migration_name, applied_steps_count)
          SELECT gen_random_uuid()::text, '$(sha256sum "$d/migration.sql" | cut -d' ' -f1)', now(), '$n', 1
          WHERE NOT EXISTS (SELECT 1 FROM \"_prisma_migrations\" WHERE migration_name = '$n');" >> "$ledger"
  done
  owner_sql "$db" -f "$ledger"; rm -f "$ledger"
  [ -n "$broken" ] && printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "$tmp/prisma/migrations/$MIG/migration.sql"
  set +e
  ( cd "$ROOT" && DATABASE_URL="$(url lab_owner "$db")" DIRECT_URL="$(url lab_owner "$db")" node_modules/.bin/prisma migrate deploy --schema "$tmp/prisma/schema.prisma" ) > "$tmp/deploy.log" 2>&1
  local rc=$?; set -e
  grep -E "migrations found|Applying migration|successfully applied|No pending|Error" "$tmp/deploy.log" | head -5
  rm -rf "$tmp"; return $rc
}
battery() { OWNER_URL="$(url lab_owner "$1")" RUNTIME_URL="$(url app_runtime_prod "$1")" PHASE="$2" SHAPE_BEFORE="${3:-}" npx tsx "$ROOT/.acct/link-events-battery.ts"; }
PREFLIGHT="$ROOT/ops/evidence/accountant-link-events-preflight.sql"
EVIDENCE="$ROOT/ops/evidence/accountant-link-events-production-evidence.sql"
fails_of() { owner_sql "$1" -f "$2" | { grep -E '^ +[0-9]+ \| FAIL' || true; } | awk -F'|' '{print $1}' | tr -d ' ' | tr '\n' ' '; }
passes_of() { owner_sql "$1" -f "$2" | grep -cE '^ +[0-9]+ \| PASS' || true; }
typedef() { owner_sql "$1" -At -c "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'AccountantWorkflowEvent_type'"; }

echo "== 1. baseline"
bash "$ROOT/.acct/lab.sh" lev_main --with-acct | tail -1
f="$(fails_of lev_main "$PREFLIGHT")"; [ -z "$f" ] && echo "preflight: 11/11 PASS on the baseline" || { echo "preflight fails on the baseline: $f"; exit 1; }
[ "$(passes_of lev_main "$EVIDENCE")" = "11" ] && { echo "the proof passed before the migration"; exit 1; }
echo "the proof refuses on the baseline (failing: $(fails_of lev_main "$EVIDENCE"))"
out="$(battery lev_main before)"; echo "$out" | grep -E "PASS|FAIL|passed"
shape="$(echo "$out" | sed -n 's/^SHAPE=//p')"
echo "$out" | grep -q " 0 failed" || exit 1

echo "== 2. migrate deploy, then the battery"
deploy lev_main
pending="$(owner_sql lev_main -At -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '$MIG' AND finished_at IS NOT NULL")"
[ "$pending" = "1" ] || { echo "the migration is not recorded as applied"; exit 1; }
f="$(fails_of lev_main "$EVIDENCE")"; [ -z "$f" ] && [ "$(passes_of lev_main "$EVIDENCE")" = "11" ] && echo "proof: 11/11 PASS after the release" || { echo "the proof fails after the release: $f"; exit 1; }
f="$(fails_of lev_main "$PREFLIGHT")"; [ "$f" = "4 7 8 " ] && echo "preflight after the release fails exactly 4 7 8" || { echo "preflight after: expected '4 7 8 ', got '$f'"; exit 1; }
battery lev_main after "$shape"

echo "== 3. atomicity"
bash "$ROOT/.acct/lab.sh" lev_broken --with-acct | tail -1
before="$(typedef lev_broken)"
if deploy lev_broken broken; then echo "the broken migration did NOT fail"; exit 1; fi
[ "$(typedef lev_broken)" = "$before" ] && echo "after a failed migration the 2026-10-27 constraint is intact" || { echo "the constraint changed"; exit 1; }

echo "== 4. rollback"
if owner_sql lev_main -f "$ROOT/.acct/link-events-rollback.sql" 2>/dev/null; then echo "rollback ran while new events exist"; exit 1; fi
echo "rollback refused while a new event exists"
bash "$ROOT/.acct/lab.sh" lev_rb --with-acct | tail -1
orig="$(typedef lev_rb)"
deploy lev_rb >/dev/null
owner_sql lev_rb -f "$ROOT/.acct/link-events-rollback.sql"
[ "$(typedef lev_rb)" = "$orig" ] && echo "rollback restores the 2026-10-27 constraint exactly" || { echo "rollback differs"; exit 1; }
echo "LINK EVENTS LAB: PASS"
