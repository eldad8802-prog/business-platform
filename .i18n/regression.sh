#!/usr/bin/env bash
# DB-backed regression: run every DB/service unit test (no Production, ephemeral DB only) on the
# branch and on main against the same database, then compare. A failure counts as NEW only when
# the same test passes on main. Usage: regression.sh <branch-dir> <main-dir>
set -u
BRANCH="$1"; BASE="$2"
case "${DATABASE_URL:-}" in *@localhost:5432/*) ;; *) echo "ABORT: ephemeral local DB only"; exit 2;; esac

LIST=$(cd "$BRANCH" && git ls-files | grep -E '\.test\.tsx?$' \
  | grep -E '(\.db\.test|\.service\.test|read-model\.test|resolver\.test|\.c[12]\.test|lead-.*\.test|purchase-order.*\.test|receiving\.service|supplier.*\.test|conversation-state\.w25|appointment\.qa|tenant-isolation|rls-contract)' \
  | grep -vE '(evidence|proof|production|\.prod\.)')

run() { # dir test → PASS/FAIL
  if (cd "$1" && [ -f "$2" ] && timeout 300 npx tsx "$2" >/tmp/out.$$ 2>&1); then echo PASS; else echo FAIL; fi
}

new=0; pre=0; ok=0; out=""
for t in $LIST; do
  b=$(run "$BRANCH" "$t")
  if [ "$b" = PASS ]; then ok=$((ok+1)); out+="PASS            $t\n"; continue; fi
  m=$(run "$BASE" "$t")
  if [ "$m" = PASS ]; then new=$((new+1)); out+="FAIL (NEW)      $t\n"; tail -20 /tmp/out.$$ || true
  else pre=$((pre+1)); out+="FAIL (main too) $t\n"; fi
done
printf "%b" "$out"
echo "DB regression: $ok pass, $pre fail on main too, $new NEW failures"
[ "$new" -eq 0 ]
