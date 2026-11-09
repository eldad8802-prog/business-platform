#!/usr/bin/env bash
# DIAGNOSTIC ONLY (branch diag/android-statusbar-overlay) — issue 2, part 2.
# Inside the booted emulator: serves the app on the runner (localhost:3000 via `adb reverse`),
# first as main is today (.next-before, includes #1039), then with the status-bar fix
# (.next-after), and measures the REAL position of the content against the system bars
# (scripts/native/statusbar-real.mjs) — routes, keyboard, sheet + client navigation,
# landscape, plain Chrome, dark mode — plus cold-launch frames for flash / temporary overlap.
set -uo pipefail
OUT="native-evidence"; PKG="il.co.promaxgroup.dubiz"
mkdir -p "$OUT/frames" "$OUT/shots"
R="$OUT/report.txt"
log() { echo "$(date -u +%H:%M:%S) $*" | tee -a "$R"; }
A() { timeout 60 adb "$@"; }

log "sdk=$(A shell getprop ro.build.version.sdk | tr -d '\r') release=$(A shell getprop ro.build.version.release | tr -d '\r')"
log "webview=$(A shell dumpsys webviewupdate 2>/dev/null | grep -m1 'Current WebView package' | tr -s ' ')"
log "screen=$(A shell wm size | tr -d '\r' | tail -1) density=$(A shell wm density | tr -d '\r' | tail -1)"
A shell dumpsys window | grep -E "type=(statusBars|navigationBars|ITYPE_STATUS_BAR|ITYPE_NAVIGATION_BAR)" | head -4 | tr -s ' ' | sed 's/^/  bars: /' | tee -a "$R"

A install -r -t android/app/build/outputs/apk/debug/app-debug.apk > /dev/null 2>&1 && log "apk installed"
A reverse tcp:3000 tcp:3000
A shell settings put system accelerometer_rotation 0
A shell settings put system user_rotation 0
A shell cmd uimode night no > /dev/null 2>&1

serve() { # dist-dir name
  rm -rf .next && cp -r "$1" .next
  (npx next start -p 3000 > "$OUT/server-$2.log" 2>&1 &)
  for i in $(seq 1 60); do curl -s -m 5 -o /dev/null http://localhost:3000/login && return 0; sleep 2; done
  return 1
}
stop_server() { pkill -f "next start -p 3000" || true; pkill -f "next-server" || true; sleep 3; }
rotate() { # 0 portrait, 1 landscape — both the settings key and wm (API 34 ignored the key alone, run 42679890084)
  A shell settings put system accelerometer_rotation 0; A shell settings put system user_rotation "$1"
  A shell wm user-rotation lock "$1" > /dev/null 2>&1; sleep 4
  log "rotation requested=$1 actual=$(A shell dumpsys window displays | grep -oE 'mCurrentRotation=[^ ]+|cur=[0-9]+x[0-9]+' | head -2 | xargs)"
}
launch() { A shell am force-stop "$PKG"; sleep 2; A shell am start -n "$PKG/.MainActivity" > /dev/null 2>&1; sleep 12; }
real() { # mode scenario
  timeout 600 node scripts/native/statusbar-real.mjs "$1" "$OUT" "$2" > "$OUT/real-$1-$2.log" 2>&1
  log "$1/$2 exit=$? pass=$(grep -c -E ' PASS|KEYBOARD-OK' "$OUT/real-$1-$2.log") fail=$(grep -c -E ' FAIL|KEYBOARD-FAIL' "$OUT/real-$1-$2.log") error=$(grep -c ' ERROR' "$OUT/real-$1-$2.log")"
}
launch_frames() { # mode — cold start, screencap as fast as adb allows for ~12 s
  A shell am force-stop "$PKG"; sleep 2
  : > "$OUT/frames/$1-launch-times.txt"
  A shell am start -n "$PKG/.MainActivity" > /dev/null 2>&1
  local t0; t0=$(date +%s%3N)
  for i in $(seq -w 0 39); do
    timeout 10 adb exec-out screencap -p > "$OUT/frames/$1-launch-$i.png" 2>/dev/null
    echo "$i $(( $(date +%s%3N) - t0 ))" >> "$OUT/frames/$1-launch-times.txt"
    [ $(( $(date +%s%3N) - t0 )) -gt 12000 ] && break
  done
}

for mode in before after; do
  log "== $mode =="
  serve ".next-$mode" "$mode" || { log "server $mode did not start"; continue; }
  launch_frames "$mode"
  SB=$(A shell dumpsys window | grep -m1 -E "type=(statusBars|ITYPE_STATUS_BAR)" | grep -oE 'frame=\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]' | head -1 | sed -E 's/.*\]\[[0-9]+,([0-9]+)\]/\1/')
  python3 scripts/native/statusbar-launch-frames.py "$OUT/frames" "$mode" "${SB:-63}" > "$OUT/launch-$mode.txt" 2>&1
  log "$mode launch: $(tail -1 "$OUT/launch-$mode.txt")"
  launch; real "$mode" routes
  launch; real "$mode" keyboard
  launch; real "$mode" sheet
  rotate 1
  launch; real "$mode" landscape
  rotate 0
  if [ "$mode" = after ]; then
    # Chrome's first-run screens blocked launchBrowser (run 42677048086): skip them on this throwaway emulator.
    A shell 'echo "_ --disable-fre --no-default-browser-check --no-first-run" > /data/local/tmp/chrome-command-line'
    A shell am set-debug-app --persistent com.android.chrome > /dev/null 2>&1
    real "$mode" chrome
    if ! grep -q ' PASS' "$OUT/real-$mode-chrome.log"; then
      A shell am start -a android.intent.action.VIEW -d http://localhost:3000/login com.android.chrome > /dev/null 2>&1; sleep 8
      A exec-out screencap -p > "$OUT/shots/after-chrome-intent-login.png"
    fi
    A shell cmd uimode night yes > /dev/null 2>&1; sleep 3
    launch; A exec-out screencap -p > "$OUT/shots/after-darkmode-launch.png"
    A shell cmd uimode night no > /dev/null 2>&1; sleep 2
  fi
  stop_server
done

timeout 60 adb logcat -d > "$OUT/logcat.txt" 2>&1
grep -qE "Process: $PKG|ANR in $PKG" "$OUT/logcat.txt" && log "!! crash/ANR in logcat" || log "no crash/ANR in logcat"
grep -E "StatusBar|SystemBars|Capacitor/Console" "$OUT/logcat.txt" | grep -iE "error|reject|not implemented" | head -20 > "$OUT/logcat-statusbar-errors.txt"
log "statusbar-related errors in logcat: $(wc -l < "$OUT/logcat-statusbar-errors.txt")"
exit 0
