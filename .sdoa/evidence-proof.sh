#!/usr/bin/env bash
# The read-only preflight / post-apply evidence files of 20261221190000 run on the synthetic lab, READ ONLY (as the
# Production evidence workflow runs them). Synthetic lab only. env: OWNER_URL.
#   pre  : rows 1-13 as expected for the state before the apply (the lab's ledger has no 20261216090000 / 20261221090000:
#          rows 4-5 are reported, not required; the lab's own businesses differ from Production: rows 11, 13 info here)
#   post : rows 1-8 as expected; the privileges + policies fingerprints identical to the preflight's
set -euo pipefail
MODE="$1"
run() { PGOPTIONS='-c default_transaction_read_only=on' psql "$OWNER_URL" -X -q -v ON_ERROR_STOP=1 -A -t -F '|' -f "$1" | grep -E '^[0-9]+\|' ; }
v() { awk -F'|' -v n="$2" '$1==n{print ($3 == "" ? $2 : $3)}' "$1"; }
expect() { local f="$1" n="$2" want="$3"; local got; got="$(v "$f" "$n")"; [ "$got" = "$want" ] || { echo "row $n: expected $want, got $got"; exit 1; }; }
if [ "$MODE" = pre ]; then
  run ops/evidence/service-desk-open-all-preflight.sql | tee /tmp/sdoa-pre.out
  expect /tmp/sdoa-pre.out 1 t; expect /tmp/sdoa-pre.out 2 t; expect /tmp/sdoa-pre.out 3 0; expect /tmp/sdoa-pre.out 6 t
  expect /tmp/sdoa-pre.out 7 t; expect /tmp/sdoa-pre.out 8 t; expect /tmp/sdoa-pre.out 9 t; expect /tmp/sdoa-pre.out 10 f
  expect /tmp/sdoa-pre.out 12 1
  test "$(wc -l < /tmp/sdoa-pre.out)" = "19"
  echo "preflight: rows 1-3, 6-10, 12 as expected (12 = the lab's own DISABLED business); 19 rows, READ ONLY"
else
  run ops/evidence/service-desk-open-all-production-evidence.sql | tee /tmp/sdoa-post.out
  expect /tmp/sdoa-post.out 1 t; expect /tmp/sdoa-post.out 2 0; expect /tmp/sdoa-post.out 3 t; expect /tmp/sdoa-post.out 4 t
  expect /tmp/sdoa-post.out 5 t; expect /tmp/sdoa-post.out 6 f; expect /tmp/sdoa-post.out 8 1
  test "$(v /tmp/sdoa-pre.out 18)" = "$(v /tmp/sdoa-post.out 12)" || { echo "privileges fingerprint changed"; exit 1; }
  test "$(v /tmp/sdoa-pre.out 19)" = "$(v /tmp/sdoa-post.out 13)" || { echo "policies fingerprint changed"; exit 1; }
  test "$(v /tmp/sdoa-pre.out 16)" = "$(v /tmp/sdoa-post.out 10)" || { echo "service cases outside business 9 changed"; exit 1; }
  echo "evidence: rows 1-6, 8 as expected; privileges + policies fingerprints unchanged; no service row written"
fi
