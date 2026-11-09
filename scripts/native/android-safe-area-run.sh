#!/usr/bin/env bash
# DIAGNOSTIC ONLY (branch diag/android-safe-area) — issue 2.
# Inside the booted emulator: serves the app on the runner (localhost:3000,
# reached from the device via `adb reverse`), first WITHOUT the fix (.next-before)
# then WITH it (.next-after), and sweeps every route in the real Capacitor
# WebView with scripts/native/android-safe-area-sweep.mjs.
#
# v4: routes run in chunks with a fresh app process per chunk, every node and
# adb call has an external timeout, and results are written per route — two
# earlier runs stalled after ~285 page loads with no in-process timeout firing.
set -uo pipefail
OUT="native-evidence"; PKG="il.co.promaxgroup.dubiz"; SHOTS="${SWEEP_SHOTS:-all}"
mkdir -p "$OUT"
R="$OUT/report.txt"
log() { echo "$(date -u +%H:%M:%S) $*" | tee -a "$R"; }
A() { timeout 60 adb "$@"; }

log "sdk=$(A shell getprop ro.build.version.sdk | tr -d '\r') release=$(A shell getprop ro.build.version.release | tr -d '\r')"
log "webview=$(A shell dumpsys webviewupdate 2>/dev/null | grep -m1 'Current WebView package' | tr -s ' ')"
log "screen=$(A shell wm size | tr -d '\r' | tail -1) density=$(A shell wm density | tr -d '\r' | tail -1)"

find app -name page.tsx | sed -E 's|^app||; s|/page.tsx$||; s|/\([^)]+\)||g; s|^$|/|' | sort -u > "$OUT/routes.txt"
log "routes=$(wc -l < "$OUT/routes.txt")"
split -l 45 -d "$OUT/routes.txt" "$OUT/chunk-"
printf '/home\n/payables\n/documents\n/forgot-password\n' > "$OUT/routes-landscape.txt"
: > "$OUT/routes-empty.txt"

A install -r -t android/app/build/outputs/apk/debug/app-debug.apk > /dev/null 2>&1 && log "apk installed"
A reverse tcp:3000 tcp:3000
A shell settings put system accelerometer_rotation 0
A shell settings put system user_rotation 0

serve() { # dist-dir name
  rm -rf .next && cp -r "$1" .next
  (npx next start -p 3000 > "$OUT/server-$2.log" 2>&1 &)
  for i in $(seq 1 60); do curl -s -m 5 -o /dev/null http://localhost:3000/login && return 0; sleep 2; done
  return 1
}
stop_server() { pkill -f "next start -p 3000" || true; pkill -f "next-server" || true; sleep 3; }
launch() {
  A shell am force-stop "$PKG"; sleep 2
  A shell am start -n "$PKG/.MainActivity" > /dev/null 2>&1; sleep 12
}
sweep() { # mode routes-file [extras]
  launch
  SWEEP_EXTRAS="${3:-0}" timeout 1500 node scripts/native/android-safe-area-sweep.mjs "$1" "$2" "$OUT" --shots "$SHOTS" > "$OUT/sweep-$1.log" 2>&1
  local rc=$?
  log "$1 exit=$rc lines=$(grep -c '^\[' "$OUT/sweep-$1.log") last: $(grep '^\[' "$OUT/sweep-$1.log" | tail -1 | cut -c1-120)"
}

for mode in before after; do
  log "== $mode =="
  serve ".next-$mode" "$mode" || { log "server $mode did not start"; continue; }
  A exec-out screencap -p > "$OUT/$mode-launch.png"
  for c in "$OUT"/chunk-*; do sweep "$mode-$(basename "$c" | sed 's/chunk-//')" "$c"; done
  sweep "$mode-extras" "$OUT/routes-empty.txt" 1
  if [ "$mode" = after ]; then
    A shell settings put system user_rotation 1; sleep 4
    sweep "after-landscape" "$OUT/routes-landscape.txt"
    A shell settings put system user_rotation 0; sleep 3
  fi
  stop_server
done

timeout 60 adb logcat -d > "$OUT/logcat.txt" 2>&1
grep -qE "FATAL EXCEPTION|ANR in $PKG" "$OUT/logcat.txt" && log "!! crash/ANR in logcat" || log "no crash/ANR in logcat"
exit 0
