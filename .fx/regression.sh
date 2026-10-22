#!/usr/bin/env bash
# Backward compatibility of 20261025090000_currency_settings_fx_rates: the CURRENT application code (this checkout
# carries no runtime change) runs its DB-backed regression tests against lab databases before / after the
# migration (and after its rollback), and the results are compared test by test.
#
#   .fx/regression.sh run <db> <out>            run every DB-backed test against <db>; one "PASS|FAIL <test>" line each
#   .fx/regression.sh compare <base> <other>    a failure is NEW only when the same test passes in <base>
#
# The test list is the one .i18n/regression.sh selects (DB / service / read-model / RLS-contract tests), so the
# same net that guarded the i18n foundation guards this migration. Each run gets its own fresh database (tests
# leave data behind). Ephemeral local databases only.
set -u
CMD="$1"
list() {
  git ls-files | grep -E '\.test\.tsx?$' \
    | grep -E '(\.db\.test|\.service\.test|read-model\.test|resolver\.test|\.c[12]\.test|lead-.*\.test|purchase-order.*\.test|receiving\.service|supplier.*\.test|conversation-state\.w25|appointment\.qa|tenant-isolation|rls-contract)' \
    | grep -vE '(evidence|proof|production|\.prod\.)'
}
case "$CMD" in
run)
  DB="$2"; OUT="$3"
  URL="postgresql://lab_owner${LAB_PASSWORD:+:${LAB_PASSWORD}}@localhost:${PGPORT:-5432}/${DB}"
  : > "$OUT"
  for t in $(list); do
    if DATABASE_URL="$URL" DIRECT_URL="$URL" AUTH_DATABASE_URL="$URL" TEST_DATABASE_URL="$URL" \
       timeout 300 npx tsx "$t" > /tmp/fxreg.out 2>&1; then
      echo "PASS $t" >> "$OUT"
    else
      echo "FAIL $t" >> "$OUT"
    fi
  done
  echo "$DB: $(grep -c '^PASS' "$OUT") pass, $(grep -c '^FAIL' "$OUT") fail, of $(wc -l < "$OUT")"
  ;;
compare)
  BASE="$2"; OTHER="$3"
  [ "$(wc -l < "$BASE")" = "$(wc -l < "$OTHER")" ] || { echo "different test lists"; exit 1; }
  new=$(join <(sort -k2 "$BASE" | awk '{print $2, $1}') <(sort -k2 "$OTHER" | awk '{print $2, $1}') | awk '$2 == "PASS" && $3 == "FAIL" {print $1}')
  fixed=$(join <(sort -k2 "$BASE" | awk '{print $2, $1}') <(sort -k2 "$OTHER" | awk '{print $2, $1}') | awk '$2 == "FAIL" && $3 == "PASS" {print $1}')
  both=$(join <(sort -k2 "$BASE" | awk '{print $2, $1}') <(sort -k2 "$OTHER" | awk '{print $2, $1}') | awk '$2 == "FAIL" && $3 == "FAIL" {print $1}')
  echo "fail in both (pre-existing): $(echo "$both" | grep -c . || true)"; echo "$both" | sed 's/^/  /'
  [ -z "$fixed" ] || { echo "pass only in $OTHER:"; echo "$fixed" | sed 's/^/  /'; }
  if [ -n "$new" ]; then echo "NEW failures in $OTHER:"; echo "$new" | sed 's/^/  /'; exit 1; fi
  echo "NEW failures: 0 ($(grep -c '^PASS' "$OTHER") pass in $OTHER vs $(grep -c '^PASS' "$BASE") in $BASE)"
  ;;
*) echo "usage: run <db> <out> | compare <base> <other>"; exit 2 ;;
esac
