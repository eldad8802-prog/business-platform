#!/usr/bin/env bash
# SEC-E — one negative (or mutation-must-stay-green) proof, recorded in six fields.
#
#   bash .sec-e/prove.sh <MUTATION-ID> <red|green> <expected-label-regex> <reason> -- <command...>
#
#   1. the tree must be clean before (a proof never runs on someone else's leftovers);
#   2. the mutation is applied (node .sec-e/mutate.mjs asserts every anchor once) and the
#      touched files are PROVEN changed (sha256 differs from HEAD);
#   3. the command runs; a SETUP CRASH is a failure of the proof, never a red;
#   4. red:   exit != 0 AND the specific label/key line is present;
#      green: exit == 0 AND the label line is present;
#   5. restore with git checkout, and prove byte-identical to HEAD (sha256).
# Post-restore green is proven once, by the workflow's final unmutated run.
set -uo pipefail
ID="$1"; MODE="$2"; EXPECT="$3"; REASON="$4"; shift 4
[ "$1" = "--" ] && shift
OUT="${RUNNER_TEMP:-/tmp}/sec-e-${ID}.out"

if ! git diff --quiet; then echo "PROOF $ID FAIL: tree dirty before mutation"; git diff --stat; exit 1; fi

MUT="$(node .sec-e/mutate.mjs "$ID")" || { echo "PROOF $ID FAIL: mutation did not apply"; exit 1; }
echo "$MUT"
FILES="$(echo "$MUT" | sed -n 's/.*-> //p')"
[ -n "$FILES" ] || { echo "PROOF $ID FAIL: mutation reported no files"; exit 1; }
for f in $FILES; do
  a="$(git show "HEAD:$f" | sha256sum | cut -d' ' -f1)"; b="$(sha256sum "$f" | cut -d' ' -f1)"
  [ "$a" != "$b" ] || { echo "PROOF $ID FAIL: $f unchanged by the mutation"; exit 1; }
done

"$@" > "$OUT" 2>&1; rc=$?

restore_ok=1
git checkout -- $FILES
for f in $FILES; do
  a="$(git show "HEAD:$f" | sha256sum | cut -d' ' -f1)"; b="$(sha256sum "$f" | cut -d' ' -f1)"
  [ "$a" = "$b" ] || restore_ok=0
done

ACTUAL="$(grep -E "$EXPECT" "$OUT" | head -3)"
echo "MUTATION      = $ID ($FILES)"
echo "EXPECTED      = $MODE: $EXPECT"
echo "ACTUAL        = exit=$rc; ${ACTUAL:-<label absent>}"
echo "INTENDED      = $REASON"
echo "RESTORE       = $([ $restore_ok = 1 ] && echo 'sha256 byte-identical to HEAD' || echo 'NOT IDENTICAL')"

if grep -q "SETUP CRASH" "$OUT"; then echo "PROOF $ID FAIL: setup crashed — a crash is not a red"; tail -30 "$OUT"; exit 1; fi
[ $restore_ok = 1 ] || { echo "PROOF $ID FAIL: restore not byte-identical"; exit 1; }
if [ "$MODE" = red ]; then
  if [ $rc -ne 0 ] && [ -n "$ACTUAL" ]; then echo "PROOF $ID = PASS (red for the intended reason)"; exit 0; fi
else
  if [ $rc -eq 0 ] && [ -n "$ACTUAL" ]; then echo "PROOF $ID = PASS (stayed green under the mutation)"; exit 0; fi
fi
echo "PROOF $ID FAIL"; tail -40 "$OUT"; exit 1
