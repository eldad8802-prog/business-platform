#!/usr/bin/env bash
# The read-only preflight / post-apply evidence files of 20261222090000 run on the synthetic lab, READ ONLY (as the
# Production evidence workflow runs them). Synthetic lab only. env: OWNER_URL.
#   pre  : every preflight row PASS, except rows 5 and 18 (activity_packs / open_all are not in the lab's ledger); keeps rows 12-15, 19
#   post : every evidence row PASS; privileges + policies fingerprints identical to the preflight's, journal rows not fewer,
#          exactly ten enum labels more, the journal history fingerprint (pre 19 = post 16) unchanged
set -euo pipefail
MODE="$1"
run() { PGOPTIONS='-c default_transaction_read_only=on' psql "$OWNER_URL" -X -q -v ON_ERROR_STOP=1 -A -t -F '|' -f "$1" | grep -E '^[0-9]+\|' ; }
if [ "$MODE" = pre ]; then
  run ops/evidence/service-desk-case-records-preflight.sql | tee /tmp/sdcr-pre.out
  bad="$(awk -F'|' '$2=="FAIL" && $1!="5" && $1!="18"' /tmp/sdcr-pre.out)"
  [ -z "$bad" ] || { echo "preflight FAIL rows: $bad"; exit 1; }
  test "$(awk -F'|' '$2=="PASS"' /tmp/sdcr-pre.out | wc -l)" = "12"
  echo "preflight: 12 PASS + rows 5 / 18 (activity_packs / open_all, not in the lab) + 5 INFO"
else
  run ops/evidence/service-desk-case-records-production-evidence.sql | tee /tmp/sdcr-post.out
  test -z "$(awk -F'|' '$2=="FAIL"' /tmp/sdcr-post.out)"
  test "$(awk -F'|' '$2=="PASS"' /tmp/sdcr-post.out | wc -l)" = "10"
  v() { awk -F'|' -v n="$2" '$1==n{print $3}' "$1"; }
  test "$(v /tmp/sdcr-pre.out 12)" = "$(v /tmp/sdcr-post.out 9)"  || { echo "privileges fingerprint changed"; exit 1; }
  test "$(v /tmp/sdcr-pre.out 13)" = "$(v /tmp/sdcr-post.out 10)" || { echo "policies fingerprint changed"; exit 1; }
  test "$(v /tmp/sdcr-post.out 11)" -ge "$(v /tmp/sdcr-pre.out 14)"
  test "$(v /tmp/sdcr-post.out 12)" = "$(( $(v /tmp/sdcr-pre.out 15) + 10 ))"
  test "$(v /tmp/sdcr-pre.out 19)" = "$(v /tmp/sdcr-post.out 16)" || { echo "journal history fingerprint changed"; exit 1; }
  echo "evidence: 10/10 PASS; privileges + policies unchanged; journal rows kept, history fingerprint equal; +10 enum labels"
fi
