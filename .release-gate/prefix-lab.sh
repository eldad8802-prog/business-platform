#!/usr/bin/env bash
# release-migrate APPROVED PREFIX — proof on the REAL release path (ephemeral PG17).
#
# Every apply here is the production path, step for step:
#   gate `stage` (pinned commit, authority re-checked against the real GitHub runs API, ledger read,
#   prefix invariant, staged directory) → `prisma migrate deploy --schema <staged>` → gate `confirm`.
# Every verdict is followed by the ACTUAL ledger and the actual objects, never the gate's word alone.
#
# Production today (.p3a/lab.sh): 168 applied; pending [P3A1, P3A2, M6] in Prisma order.
#
#    1  expected [P3A1,P3A2]            → applied; M6 stays pending (no ledger row, no table)
#    2  expected [M6]                   → REFUSED (P3-A unapproved and runs before it)
#    3  expected [P3A1,M6]              → REFUSED (P3A2 unapproved inside the run)
#    4  expected [P3A2]                 → REFUSED (P3A1 unapproved before it)
#    5  expected [P3A2,P3A1]            → REFUSED (wrong order)
#    6  P3A2 authority: no record; a record whose preflight reported FAIL; a record naming another
#       evidence file                   → REFUSED
#    7  P3A2 file differs from its record's checksum → REFUSED
#    8  a migration merged to main while the run waits: a checkout that is not the dispatch commit
#       → REFUSED; the dispatch commit's run applies P3-A and the late migration gets no ledger row;
#       the same migration merged BEFORE dispatch, sorting inside the run → REFUSED
#    9  P3A2 fails mid-apply            → P3A1 applied, P3A2 failed row, M6 NEVER runs; confirm fails;
#                                          the next stage refuses (unfinished row)
#   10  re-run after P3-A applied       → REFUSED (not pending); with M6 added → REFUSED; ledger unchanged
#   11  then expected [M6] alone, with M6's own (real) record and preflight → applied normally
#   12  the exact set [P3A1,P3A2,M6]    → applied, nothing held (the pre-prefix behaviour)
#
# P3A2 is authority-changing and has no Production approval record yet; this lab gives it a LAB record
# (approvedBy "lab-synthetic") naming the real passing P3-A preflight run (P3A_PREFLIGHT_RUN). M6 uses
# its REAL record (ops/release-approvals/20261009090000_m6_acquisition_connections.json).
#
# env: PGHOST, PGPORT, SUPER, PGPASSWORD (super), LAB_PASSWORD, GITHUB_TOKEN, GITHUB_REPOSITORY,
#      P3A_PREFLIGHT_RUN. Synthetic database only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
A1="20261008090000_p3a_identity_enum_values"
A2="20261008090100_p3a_trust_claims"
M6="20261009090000_m6_acquisition_connections"
LATE_IN="20261008090050_lab_merged_while_waiting"   # sorts between P3A1 and P3A2
LATE_AFTER="20261010090000_lab_merged_after_dispatch"
P3A_PRE="ops/evidence/p3a-trust-conversion-preflight.sql"
FAIL_RUN=37223983716   # the real P3-A preflight that reported 18/19 (check 3 FAIL)
: "${P3A_PREFLIGHT_RUN:?the real passing P3-A preflight run id}"
T="$(mktemp -d)"
url() { echo "postgresql://lab_owner:${LAB_PASSWORD}@${PGHOST}:${PGPORT}/$1"; }
lab() { PGPASSWORD="$LAB_PASSWORD" psql -X -U lab_owner -d "$1" -v ON_ERROR_STOP=1 -Atq "${@:2}"; }
fail() { echo "FAIL: $*"; exit 1; }

# ── ledger and objects (the truth after every step) ────────────────────────────────────────────
finished() { lab "$1" -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL"; }
rows()     { lab "$1" -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '$2'"; }
done_()    { lab "$1" -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '$2' AND finished_at IS NOT NULL AND rolled_back_at IS NULL"; }
rel()      { lab "$1" -c "SELECT (to_regclass('public.\"$2\"') IS NOT NULL)::int"; }
ledger()   {  # ledger <db> <expected finished> <A1> <A2> <M6> <trust table> <acq table>  (row counts / 0|1)
  local got; got="$(finished "$1") $(rows "$1" "$A1") $(rows "$1" "$A2") $(rows "$1" "$M6") $(rel "$1" BusinessTrustClaim) $(rel "$1" AcquisitionConnection)"
  echo "    ledger: finished=$(echo "$got" | cut -d' ' -f1) rows[P3A1,P3A2,M6]=$(echo "$got" | cut -d' ' -f2-4) tables[trust,acq]=$(echo "$got" | cut -d' ' -f5-6)"
  [ "$got" = "${*:2}" ] || fail "ledger/objects on $1: got '$got', want '${*:2}'"
}

# ── databases: build Production-today once, clone it per case ───────────────────────────────────
bash "$ROOT/.p3a/lab.sh" pfx_base >/dev/null
ledger pfx_base 168 0 0 0 0 0
clone() { psql -X -q -v ON_ERROR_STOP=1 -U "$SUPER" -d postgres -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1 TEMPLATE pfx_base OWNER lab_owner"; }

# ── checkouts: git worktrees at a COMMITTED sha (pinning and merge times are real) ──────────────
wt() {  # wt <name> [mutator]: a worktree of HEAD, the mutator applied and committed; prints nothing
  local d="$T/$1"
  git -C "$ROOT" worktree add -q --detach "$d" HEAD
  ln -s "$ROOT/node_modules" "$d/node_modules"
  if [ -n "${2:-}" ]; then
    ( cd "$d" && "$2" )
    git -C "$d" add -A
    git -C "$d" -c user.name=lab -c user.email=lab@localhost commit -q -m "lab: $1"
  fi
}
sum() { sha256sum "$1" | cut -d' ' -f1; }
record() {  # record <run> <file>: a LAB approval record for P3A2 matching the file in this checkout
  printf '{"migration":"%s","sha256":"%s","decision":"https://github.com/%s/blob/main/docs/security/RELEASE_MIGRATE_AUTHORITY_GATE.md","approvedBy":"lab-synthetic","preflightRun":%s,"preflightFile":"%s"}\n' \
    "$A2" "$(sum "prisma/migrations/$A2/migration.sql")" "$GITHUB_REPOSITORY" "$1" "$2" > "ops/release-approvals/$A2.json"
}
m_record()        { record "$P3A_PREFLIGHT_RUN" "$P3A_PRE"; }
m_record_failrun(){ record "$FAIL_RUN" "$P3A_PRE"; }
m_record_otherfile(){ record "$P3A_PREFLIGHT_RUN" "ops/evidence/m6-acquisition-connections-preflight.sql"; }
m_tamper()        { m_record; printf '\n-- lab: changed after approval\n' >> "prisma/migrations/$A2/migration.sql"; }
m_broken()        { printf '\n-- lab fault: the last statement fails\nSELECT 1 / 0;\n' >> "prisma/migrations/$A2/migration.sql"; m_record; }
m_late_in()       { m_record; mkdir -p "prisma/migrations/$LATE_IN"; printf -- '-- lab: merged to main\nSELECT 1;\n' > "prisma/migrations/$LATE_IN/migration.sql"; }
m_late_after()    { mkdir -p "prisma/migrations/$LATE_AFTER"; printf -- '-- lab: merged to main after the dispatch\nCREATE TABLE "LabLate" (id int);\n' > "prisma/migrations/$LATE_AFTER/migration.sql"; }

wt plain                      # main as it is: no P3-A record (M6 has its real one)
wt rec m_record               # + the lab P3A2 record (the "approved" checkout)
wt failrun m_record_failrun
wt otherfile m_record_otherfile
wt tamper m_tamper
wt broken m_broken
wt latein m_late_in
DISPATCH="$(git -C "$T/rec" rev-parse HEAD)"
# "main moved on": a commit on top of the dispatch commit adds a late migration
git -C "$T/rec" worktree add -q --detach "$T/moved" "$DISPATCH"; ln -s "$ROOT/node_modules" "$T/moved/node_modules"
( cd "$T/moved" && m_late_after && git add -A && git -c user.name=lab -c user.email=lab@localhost commit -q -m "lab: merged while waiting" )

# ── the release path ─────────────────────────────────────────────────────────────────────────────
stage() {  # stage <db> <checkout> <expected> [pinned] → rc; output /tmp/stage.out; staged dir $T/out-<db>
  local pinned="${4:-$(git -C "$2" rev-parse HEAD)}"
  set +e
  ( cd "$2" && DIRECT_URL="$(url "$1")" node scripts/ci/release-migrate-gate.mjs stage --expected "$3" --pinned-sha "$pinned" --out "$T/out-$1" ) > /tmp/stage.out 2>&1
  local rc=$?; set -e
  sed 's/^/    | /' /tmp/stage.out
  return $rc
}
deploy() {  # deploy <db> → rc (the workflow's apply step, against the staged directory only)
  set +e
  ( cd "$ROOT" && DATABASE_URL="$(url "$1")" DIRECT_URL="$(url "$1")" node_modules/.bin/prisma migrate deploy --schema "$T/out-$1/prisma/schema.prisma" ) > /tmp/deploy.out 2>&1
  local rc=$?; set -e
  grep -E "Applying migration|successfully applied|No pending|Error|P3018" /tmp/deploy.out | sed 's/^/    | /' | head -8
  return $rc
}
confirm() {
  set +e
  ( cd "$ROOT" && DIRECT_URL="$(url "$1")" node scripts/ci/release-migrate-gate.mjs confirm --expected "$2" --out "$T/out-$1" ) > /tmp/confirm.out 2>&1
  local rc=$?; set -e
  sed 's/^/    | /' /tmp/confirm.out
  return $rc
}
refused() {  # refused <db> <checkout> <expected> <why-regex> [pinned]
  rm -rf "$T/out-$1"
  if stage "$1" "$2" "$3" "${5:-}"; then fail "stage allowed [$3]"; fi
  grep -qE "$4" /tmp/stage.out || fail "refused for another reason (wanted: $4)"
  [ ! -e "$T/out-$1/release-manifest.json" ] || fail "a refused stage left a manifest"
}
release() {  # release <db> <checkout> <expected>: stage → deploy → confirm, all must pass
  stage "$1" "$2" "$3" || fail "stage refused [$3]"
  deploy "$1" || fail "deploy failed"
  ( cd "$ROOT" && DATABASE_URL="$(url "$1")" DIRECT_URL="$(url "$1")" node_modules/.bin/prisma migrate status --schema "$T/out-$1/prisma/schema.prisma" ) >/dev/null 2>&1 || fail "staged status is not up to date"
  confirm "$1" "$3" || fail "confirm failed"
}

echo; echo "1. expected [P3A1,P3A2] → P3-A applied, M6 stays pending"
clone pfx
release pfx "$T/rec" "$A1,$A2"
grep -q "stays pending, NOT staged: $M6" /tmp/stage.out || fail "M6 not reported as held"
[ ! -d "$T/out-pfx/prisma/migrations/$M6" ] || fail "M6 was staged"
grep -q "Applying migration \`$M6\`" /tmp/deploy.out && fail "deploy applied M6"
ledger pfx 170 1 1 0 1 0

echo; echo "2.-5. refusals on Production today (nothing written)"
clone pfx_ref
echo "  2. [M6]";          refused pfx_ref "$T/rec" "$M6" "NOT approved, and it would have to run before $M6: $A1, $A2"
echo "  3. [P3A1,M6]";     refused pfx_ref "$T/rec" "$A1,$M6" "NOT approved, and it would have to run before $M6: $A2"
echo "  4. [P3A2]";        refused pfx_ref "$T/rec" "$A2" "NOT approved, and it would have to run before $A2: $A1"
echo "  5. [P3A2,P3A1]";   refused pfx_ref "$T/rec" "$A2,$A1" "not in Prisma order"
ledger pfx_ref 168 0 0 0 0 0

echo; echo "6. P3A2 authority → REFUSED"
echo "  no approval record";                       refused pfx_ref "$T/plain" "$A1,$A2" "no approval record ops/release-approvals/$A2.json"
echo "  a record naming the real 18/19 preflight"; refused pfx_ref "$T/failrun" "$A1,$A2" "preflight run $FAIL_RUN: its evidence reports 1 FAIL row"
echo "  a record naming another evidence file";    refused pfx_ref "$T/otherfile" "$A1,$A2" "does not name ops/evidence/m6-acquisition-connections-preflight.sql"
ledger pfx_ref 168 0 0 0 0 0

echo; echo "7. P3A2 changed after its record → REFUSED (checksum)"
refused pfx_ref "$T/tamper" "$A1,$A2" "record checksum .* ≠ file"
ledger pfx_ref 168 0 0 0 0 0

echo; echo "8. a migration merged to main while the run waits cannot hitchhike"
echo "  a checkout that is not the dispatch commit → REFUSED"
refused pfx_ref "$T/moved" "$A1,$A2" "not the dispatch commit $DISPATCH" "$DISPATCH"
echo "  merged BEFORE the dispatch and sorting inside the run → REFUSED"
refused pfx_ref "$T/latein" "$A1,$A2" "NOT approved, and it would have to run before $A2: $LATE_IN"
ledger pfx_ref 168 0 0 0 0 0
echo "  the dispatch commit's run: P3-A applied, the late migration never touches the ledger"
release pfx_ref "$T/rec" "$A1,$A2"
ledger pfx_ref 170 1 1 0 1 0
[ "$(rows pfx_ref "$LATE_AFTER")" = "0" ] && [ "$(rel pfx_ref LabLate)" = "0" ] || fail "the late migration ran"

echo; echo "9. P3A2 fails mid-apply → M6 never runs"
clone pfx_fail
stage pfx_fail "$T/broken" "$A1,$A2" || fail "stage refused the (recorded) broken file"
if deploy pfx_fail; then fail "the broken P3A2 deployed"; fi
ledger pfx_fail 169 1 1 0 0 0
[ "$(done_ pfx_fail "$A1")" = "1" ] && [ "$(done_ pfx_fail "$A2")" = "0" ] || fail "want P3A1 finished, P3A2 not finished"
if confirm pfx_fail "$A1,$A2"; then fail "confirm passed a failed release"; fi
echo "  the next stage refuses while the failed row stands"
refused pfx_fail "$T/rec" "$A2" "unfinished or rolled-back ledger rows: $A2"
ledger pfx_fail 169 1 1 0 0 0

echo; echo "10. re-run after P3-A applied (pfx) → REFUSED, ledger unchanged"
refused pfx "$T/rec" "$A1,$A2" "approved but not pending .*$A1"
refused pfx "$T/rec" "$A1,$A2,$M6" "approved but not pending"
ledger pfx 170 1 1 0 1 0

echo; echo "11. then [M6] alone, with M6's own record and preflight → applied"
release pfx "$T/plain" "$M6"
grep -q "$M6 | AUTHORITY .* approved by eldad8802-prog" /tmp/stage.out || fail "M6 not authorized by its own record"
ledger pfx 171 1 1 1 1 1

echo; echo "12. the exact set [P3A1,P3A2,M6] → all applied, nothing held"
clone pfx_exact
release pfx_exact "$T/rec" "$A1,$A2,$M6"
grep -q "stays pending, NOT staged: (none)" /tmp/stage.out || fail "the exact set held something"
ledger pfx_exact 171 1 1 1 1 1

for d in "$T"/*/; do git -C "$ROOT" worktree remove --force "$d" 2>/dev/null || true; done
rm -rf "$T"
echo; echo "release-migrate approved-prefix lab: ALL 12 CASES AS EXPECTED (ledger verified after each)"
