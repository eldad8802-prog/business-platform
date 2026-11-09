#!/usr/bin/env bash
# DIAGNOSTIC ONLY (branch diag/android-safe-area) — issue 2.
# Inside the booted emulator: serves the app on the runner (localhost:3000,
# reached from the device via `adb reverse`), first WITHOUT the fix (.next-before)
# then WITH it (.next-after), and sweeps every route in the real Capacitor
# WebView with scripts/native/android-safe-area-sweep.mjs.
set -uo pipefail
OUT="native-evidence"; PKG="il.co.promaxgroup.dubiz"; SHOTS="${SWEEP_SHOTS:-all}"
mkdir -p "$OUT"
R="$OUT/report.txt"
log() { echo "$*" | tee -a "$R"; }

log "sdk=$(adb shell getprop ro.build.version.sdk | tr -d '\r') release=$(adb shell getprop ro.build.version.release | tr -d '\r') model=$(adb shell getprop ro.product.model | tr -d '\r')"
log "webview=$(adb shell dumpsys webviewupdate 2>/dev/null | grep -m1 'Current WebView package' | tr -s ' ')"
log "screen=$(adb shell wm size | tr -d '\r' | tail -1) density=$(adb shell wm density | tr -d '\r' | tail -1)"

find app -name page.tsx | sed -E 's|^app||; s|/page.tsx$||; s|/\([^)]+\)||g; s|^$|/|' | sort -u > "$OUT/routes.txt"
log "routes=$(wc -l < "$OUT/routes.txt")"
printf '/home\n/payables\n/documents\n/login\n' > "$OUT/routes-landscape.txt"

adb install -r -t android/app/build/outputs/apk/debug/app-debug.apk > /dev/null 2>&1 && log "apk installed"
adb reverse tcp:3000 tcp:3000
adb shell settings put system accelerometer_rotation 0
adb shell settings put system user_rotation 0

serve() { # dist-dir
  rm -rf .next && cp -r "$1" .next
  (npx next start -p 3000 > "$OUT/server-$2.log" 2>&1 &)
  for i in $(seq 1 60); do curl -s -o /dev/null http://localhost:3000/login && return 0; sleep 2; done
  return 1
}
stop_server() { pkill -f "next start -p 3000" || true; pkill -f "next-server" || true; sleep 3; }
launch() {
  adb shell am force-stop "$PKG"; sleep 2
  adb shell am start -n "$PKG/.MainActivity" > /dev/null 2>&1; sleep 15
}

for mode in before after; do
  log ""; log "== $mode =="
  serve ".next-$mode" "$mode" || { log "server $mode did not start"; continue; }
  launch
  adb exec-out screencap -p > "$OUT/$mode-launch.png"
  node scripts/native/android-safe-area-sweep.mjs "$mode" "$OUT/routes.txt" "$OUT" --shots "$SHOTS" 2>&1 | tail -n +1 > "$OUT/sweep-$mode.log"
  tail -3 "$OUT/sweep-$mode.log" | tee -a "$R"
  if [ "$mode" = after ]; then
    adb shell settings put system user_rotation 1; sleep 4
    node scripts/native/android-safe-area-sweep.mjs "after-landscape" "$OUT/routes-landscape.txt" "$OUT" --shots all > "$OUT/sweep-after-landscape.log" 2>&1
    adb shell settings put system user_rotation 0; sleep 3
  fi
  stop_server
done

adb logcat -d > "$OUT/logcat.txt" 2>&1
grep -qE "FATAL EXCEPTION|ANR in $PKG" "$OUT/logcat.txt" && log "!! crash/ANR in logcat" || log "no crash/ANR in logcat"
exit 0
