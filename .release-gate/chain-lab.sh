#!/usr/bin/env bash
# release-migrate gate — proof on the REAL release mechanism (ephemeral PG17).
#
# Every scenario runs the real gate (scripts/ci/release-migrate-gate.mjs) against a Production-shaped
# database (.c594/lab.sh: baselined ledger, #594 applied by `prisma migrate deploy`) and a "checkout"
# — the set of migration directories a release-migrate run would see at its SHA. Where the gate
# allows, the SAME checkout is applied by `prisma migrate deploy`, exactly as the workflow does.
#
#   A  P2 pending + B4 approved alone          → verify REFUSES (P2 would ride along)
#   B  P2 + B4 both named                      → verify allows (only when both are named)
#   C  a migration merged while a run waits    → verify REFUSES (not in the expected set)
#   D  the controlled chain                    → P2 alone: allowed, deployed, P2 proof 13/13;
#                                                then B4 alone: allowed, deployed, B4 proof 14/14;
#                                                re-running B4 → REFUSED (no longer pending)
#   E  the #594 incident, replayed             → ledger before #594, #594 + P2 pending:
#                                                verify for #594 alone REFUSES (P2 extra);
#                                                nothing was applied
#   F  a half-applied ledger row               → verify REFUSES
#
# env: PGHOST, PGPORT, SUPER, LAB_PASSWORD, B4_SQL (B4 migration file), P2_PROOF, B4_PROOF.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GATE="$ROOT/scripts/ci/release-migrate-gate.mjs"
P2="20261004090000_p2_business_identity"
B4="20261006090000_business_tenant_write_rls"
M594="20261003090000_control_plane_production_privileges"
LATE="20261005120000_lab_merged_while_waiting"
url() { echo "postgresql://lab_owner:${LAB_PASSWORD}@${PGHOST}:${PGPORT}/$1"; }
lab() { PGPASSWORD="$LAB_PASSWORD" psql -X -U lab_owner -d "$1" -v ON_ERROR_STOP=1 "${@:2}"; }

# checkout <dir> <extra...>: main's migrations + the named extras, as a run's checkout would hold them.
checkout() {
  local dir="$1"; shift
  rm -rf "$dir"; mkdir -p "$dir/prisma/migrations"
  cp "$ROOT/prisma/schema.prisma" "$dir/prisma/"
  cp "$ROOT/prisma/migrations/migration_lock.toml" "$dir/prisma/migrations/"
  for d in "$ROOT"/prisma/migrations/*/; do cp -r "$d" "$dir/prisma/migrations/"; done
  for x in "$@"; do
    mkdir -p "$dir/prisma/migrations/$x"
    case "$x" in
      "$B4") cp "$B4_SQL" "$dir/prisma/migrations/$x/migration.sql" ;;
      "$LATE") printf -- '-- lab: a plain migration merged to main while a release run waited for approval\nCREATE TABLE "LabMergedWhileWaiting" (id int);\n' > "$dir/prisma/migrations/$x/migration.sql" ;;
    esac
  done
}
# verify <db> <checkout> <expected> → exit code; output in /tmp/gate.out
verify() {
  set +e
  ( cd "$2" && DIRECT_URL="$(url "$1")" node "$GATE" verify --expected "$3" ) > /tmp/gate.out 2>&1
  local rc=$?; set -e
  sed 's/^/    | /' /tmp/gate.out
  return $rc
}
deploy() { ( cd "$ROOT" && DATABASE_URL="$(url "$1")" DIRECT_URL="$(url "$1")" node_modules/.bin/prisma migrate deploy --schema "$2/prisma/schema.prisma" ) 2>&1 | grep -E "Applying migration|successfully applied|No pending" | sed 's/^/    | /'; }
applied() { lab "$1" -Atc "SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL"; }
has() { lab "$1" -Atc "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '$2'"; }
expect_refused() { if verify "$@"; then echo "FAIL: the gate allowed [$3]"; exit 1; fi; }
proof_all_pass() {
  local out; out="$(lab "$1" -At -F'|' -f "$2")"
  local fails; fails="$(echo "$out" | awk -F'|' '($2=="FAIL"||$3=="FAIL"){print $1}' | tr '\n' ' ')"
  local passes; passes="$(echo "$out" | awk -F'|' '($2=="PASS"||$3=="PASS")' | wc -l)"
  echo "    proof $(basename "$2"): $passes PASS, fails: [${fails}]"
  [ -z "$fails" ] && [ "$passes" = "$3" ]
}
setup_today() {  # Production today: 163 applied (#594 last), P2 pending; app_auth + D2 E4 (B4's prerequisites)
  bash "$ROOT/.c594/lab.sh" "$1" >/dev/null
  psql -X -v ON_ERROR_STOP=1 -q -U "$SUPER" -d postgres -c \
    "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_auth') THEN CREATE ROLE app_auth NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END \$\$"
  lab "$1" -q -f "$ROOT/prisma/migrations/20260908180000_d2_user_business_privilege_narrowing/migration.sql"
}

T="$(mktemp -d)"
setup_today chain
echo "Production-today lab: $(applied chain) applied; P2 recorded: $(has chain "$P2")"
test "$(applied chain)" = "163" && test "$(has chain "$P2")" = "0"

echo; echo "A. P2 pending, B4 approved alone → REFUSED"
checkout "$T/a" "$B4"
expect_refused chain "$T/a" "$B4"
grep -q "NOT approved for this run: $P2" /tmp/gate.out
test "$(applied chain)" = "163"

echo; echo "B. P2 + B4 named together → allowed (and only then)"
verify chain "$T/a" "$P2,$B4"

echo; echo "C. a migration merged while the run waited → REFUSED"
checkout "$T/c" "$B4" "$LATE"
expect_refused chain "$T/c" "$P2"
grep -q "NOT approved for this run: .*$LATE" /tmp/gate.out && grep -q "NOT approved for this run: .*$B4" /tmp/gate.out

echo; echo "D. the controlled chain: P2 alone, then B4 alone"
checkout "$T/d1"
verify chain "$T/d1" "$P2"
deploy chain "$T/d1"
test "$(applied chain)" = "164" && test "$(has chain "$P2")" = "1" && test "$(has chain "$B4")" = "0"
proof_all_pass chain "$P2_PROOF" 13
checkout "$T/d2" "$B4"
verify chain "$T/d2" "$B4"
deploy chain "$T/d2"
test "$(applied chain)" = "165" && test "$(has chain "$B4")" = "1"
proof_all_pass chain "$B4_PROOF" 14
echo "  P2 x B4: after both, the runtime still writes its own P2 row (FK into Business, now under FORCE RLS) and not another's"
biz() { lab chain -Atqc "INSERT INTO \"Business\" (name, \"updatedAt\") VALUES ('$1', now()) RETURNING id" | head -1; }
BA=$(biz chain-A); BB=$(biz chain-B)
rtp2() { PGPASSWORD="$LAB_PASSWORD" psql -X -U app_runtime_prod -d chain -v ON_ERROR_STOP=1 -Atq \
  -c "BEGIN" -c "SELECT set_config('app.current_business_id', '$1', true)" \
  -c "INSERT INTO \"BusinessIdentityStatement\" (\"businessId\",\"dimension\",\"text\",\"source\",\"updatedAt\") VALUES ($2,'SPECIALIZATION','x','OWNER_INPUT',now())" -c "COMMIT"; }
rtp2 "$BA" "$BA" >/dev/null || { echo "FAIL: own P2 write refused after B4"; exit 1; }
if rtp2 "$BA" "$BB" >/dev/null 2>&1; then echo "FAIL: cross-tenant P2 write allowed"; exit 1; fi
test "$(lab chain -Atc "SELECT count(*) FROM \"BusinessIdentityStatement\" WHERE \"businessId\" IN ($BA, $BB)")" = "1"
echo "    own write: ok; cross-tenant write: refused"
echo "  re-running B4 → REFUSED (already applied)"
expect_refused chain "$T/d2" "$B4"
grep -q "approved but not pending" /tmp/gate.out

echo; echo "E. the #594 incident replayed: #594 + P2 pending, #594 approved alone → REFUSED, nothing applied"
bash "$ROOT/.c594/lab.sh" incident --without-594 >/dev/null
checkout "$T/e"
expect_refused incident "$T/e" "$M594"
grep -q "NOT approved for this run: $P2" /tmp/gate.out
test "$(has incident "$M594")" = "0" && test "$(has incident "$P2")" = "0"

echo; echo "F. a half-applied ledger row → REFUSED"
lab incident -q -c "INSERT INTO \"_prisma_migrations\" (id, checksum, migration_name, applied_steps_count) VALUES (gen_random_uuid()::text, repeat('0',64), '$M594', 0)"
expect_refused incident "$T/e" "$M594,$P2"
grep -q "unfinished or rolled-back" /tmp/gate.out

rm -rf "$T"
echo; echo "release-migrate gate chain lab: ALL SCENARIOS AS EXPECTED"
