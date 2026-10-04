#!/usr/bin/env bash
# Owner-bound release sets — proof through the REAL gate CLI (scripts/ci/release-migrate-gate.mjs
# `plan`, the authority step release-migrate runs before and again after approval).
#
# Each scenario is a throwaway git checkout holding synthetic migrations A < B < C < D (plain SQL:
# no authority change, so no preflight run is involved — the binding is what is under test) and
# approval records committed to its history, exactly as records land on main. Offline: no database,
# no network, no secret.
#
#   S1  no record binds                                  → [A,B] allowed (generic prefix untouched)
#   S2  B binds [A,B,C]                                  → [A,B,C] allowed; [A,B] and [A] refused
#                                                          (subset); [A,B,C,D] refused (beyond)
#   S3  only C's record binds [A,B,C], [A] requested     → refused (every binding record is read,
#                                                          not only those of requested migrations)
#   S4  B binds [A,B,C], A binds [A,B]                   → [A,B,C] and [A,B] refused (conflict)
#   S5  B's binding changed to [A,B] with no supersedes  → refused (also after a later edit that keeps
#                                                          it — the change is judged against the last
#                                                          DIFFERENT binding); with supersedes = the old
#                                                          decision and a new decision → [A,B]
#                                                          allowed, [A,B,C] refused
#   S6  a malformed binding (out of order / unknown / duplicate / own migration missing) → refused
#   S7  an approval record that is not valid JSON        → refused (it could hide a binding)
#   S8  no readable git history for a binding record     → refused (supersession undecidable)
#
#   .release-gate/release-set-lab.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GATE="$ROOT/scripts/ci/release-migrate-gate.mjs"
A="20300101090000_lab_a"; B="20300101090100_lab_b"; C="20300101090200_lab_c"; D="20300101090300_lab_d"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL: $*"; exit 1; }

repo() {  # repo <dir>: a checkout with A..D and no records, one commit
  rm -rf "$1"; mkdir -p "$1/prisma/migrations" "$1/ops/release-approvals"
  for m in "$A" "$B" "$C" "$D"; do mkdir -p "$1/prisma/migrations/$m"; printf -- '-- lab\nSELECT 1;\n' > "$1/prisma/migrations/$m/migration.sql"; done
  ( cd "$1" && git init -q && git config core.autocrlf false && git -c user.email=lab@example.test -c user.name=lab add -A && git -c user.email=lab@example.test -c user.name=lab commit -qm base )
}
record() {  # record <dir> <migration> <json-tail> : write + commit ops/release-approvals/<m>.json
  printf '{"migration":"%s","sha256":"%s","decision":"%s","approvedBy":"lab","preflightRun":1,"preflightFile":"ops/evidence/lab.sql"%s}\n' \
    "$2" "$(printf '0%.0s' $(seq 64))" "${DECISION:-https://github.com/lab/lab/pull/1#decision-1}" "$3" > "$1/ops/release-approvals/$2.json"
  ( cd "$1" && git -c user.email=lab@example.test -c user.name=lab add -A && git -c user.email=lab@example.test -c user.name=lab commit -qm "record $2" )
}
plan() {  # plan <dir> <expected> → exit code; output in $T/out
  set +e; ( cd "$1" && node "$GATE" plan --expected "$2" ) > "$T/out" 2>&1; local rc=$?; set -e
  sed 's/^/      | /' "$T/out"; return $rc
}
allow()  { echo "  $1"; plan "$2" "$3" || fail "$1: refused"; echo "    → allowed"; }
refuse() { echo "  $1"; if plan "$2" "$3"; then fail "$1: allowed"; fi; grep -q -- "$4" "$T/out" || fail "$1: refused, but not for: $4"; echo "    → refused ($4)"; }
set3() { printf ',"releaseSet":["%s"]' "$(IFS=,; echo "$*" | sed 's/,/","/g')"; }

echo "S1 no binding record"
repo "$T/s1"
allow  "S1 [A,B] (a prefix; nothing binds)"                 "$T/s1" "$A,$B"

echo "S2 B binds [A,B,C]"
repo "$T/s2"; record "$T/s2" "$B" "$(set3 "$A" "$B" "$C")"
allow  "S2 [A,B,C] (the bound set)"                          "$T/s2" "$A,$B,$C"
grep -q "owner-bound release set detected" "$T/out" || fail "S2: the bound set was not printed"
refuse "S2 [A,B]"                                            "$T/s2" "$A,$B"        "only a subset of the owner-approved release set"
refuse "S2 [A]"                                              "$T/s2" "$A"           "only a subset"
refuse "S2 [A,B,C,D]"                                        "$T/s2" "$A,$B,$C,$D"  "beyond the owner-approved release set"

echo "S3 the binding lives only in a record of a migration that was left out"
repo "$T/s3"; record "$T/s3" "$C" "$(set3 "$A" "$B" "$C")"
refuse "S3 [A]"                                              "$T/s3" "$A"           "only a subset"

echo "S4 conflicting bindings"
repo "$T/s4"; record "$T/s4" "$B" "$(set3 "$A" "$B" "$C")"; record "$T/s4" "$A" "$(set3 "$A" "$B")"
refuse "S4 [A,B,C]"                                          "$T/s4" "$A,$B,$C"     "DIFFERENT release sets"
refuse "S4 [A,B]"                                            "$T/s4" "$A,$B"        "DIFFERENT release sets"

echo "S5 the owner changes their mind: [A,B,C] → [A,B]"
repo "$T/s5"; record "$T/s5" "$B" "$(set3 "$A" "$B" "$C")"
record "$T/s5" "$B" "$(set3 "$A" "$B")"
refuse "S5 [A,B] after an edit without supersedes"          "$T/s5" "$A,$B"        "supersedes"
record "$T/s5" "$B" "$(set3 "$A" "$B"),\"approvedAt\":\"later\""
refuse "S5 [A,B] after a further edit that leaves the changed binding in place" "$T/s5" "$A,$B" "supersedes"
DECISION="https://github.com/lab/lab/pull/2#decision-2" record "$T/s5" "$B" "$(set3 "$A" "$B"),\"supersedes\":\"https://github.com/lab/lab/pull/1#decision-1\""
allow  "S5 [A,B] under the new decision"                     "$T/s5" "$A,$B"
refuse "S5 [A,B,C] under the new decision"                   "$T/s5" "$A,$B,$C"     "beyond the owner-approved release set"

echo "S6 malformed bindings"
for bad in "$(set3 "$B" "$A" "$C")|Prisma order" "$(set3 "$A" "$B" "20300101099900_lab_ghost")|do not exist" "$(set3 "$A" "$B" "$B")|twice" "$(set3 "$A" "$C")|own migration"; do
  repo "$T/s6"; record "$T/s6" "$B" "${bad%%|*}"
  refuse "S6 ${bad##*|}"                                     "$T/s6" "$D"           "${bad##*|}"
done

echo "S7 an unreadable approval record"
repo "$T/s7"; echo '{ not json' > "$T/s7/ops/release-approvals/$C.json"; ( cd "$T/s7" && git -c user.email=lab@example.test -c user.name=lab add -A && git -c user.email=lab@example.test -c user.name=lab commit -qm bad )
refuse "S7 [A]"                                              "$T/s7" "$A"           "not valid JSON"

echo "S8 no git history"
repo "$T/s8"; record "$T/s8" "$B" "$(set3 "$A" "$B" "$C")"; rm -rf "$T/s8/.git"
refuse "S8 [A,B,C]"                                          "$T/s8" "$A,$B,$C"     "cannot read the git history"

echo "RELEASE-SET LAB: PASS"
