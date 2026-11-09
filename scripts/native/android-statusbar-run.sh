#!/usr/bin/env bash
# DIAGNOSTIC ONLY — issue 2b: before (main) / after (StatusBar overlay off) on one emulator.
set -uo pipefail
OUT="native-evidence"; mkdir -p "$OUT"; R="$OUT/report.txt"
log() { echo "$(date -u +%H:%M:%S) $*" | tee -a "$R"; }
A() { timeout 60 adb "$@"; }
log "sdk=$(A shell getprop ro.build.version.sdk | tr -d '\r') model=$(A shell getprop ro.product.model | tr -d '\r') webview=$(A shell dumpsys webviewupdate 2>/dev/null | grep -m1 'Current WebView package' | tr -s ' ')"
A install -r -t android/app/build/outputs/apk/debug/app-debug.apk > /dev/null 2>&1 && log "apk installed"
A reverse tcp:3000 tcp:3000
for MODE in before after; do
  # stop the previous server for real (next start runs as next-server) and wait for the port
  for p in $(lsof -ti tcp:3000 2>/dev/null); do kill -9 "$p" 2>/dev/null; done
  pkill -9 -f "next-server" 2>/dev/null; pkill -9 -f "next start" 2>/dev/null
  for i in $(seq 1 30); do lsof -ti tcp:3000 >/dev/null 2>&1 || break; sleep 1; done
  lsof -ti tcp:3000 >/dev/null 2>&1 && { log "!! port 3000 still busy before $MODE — aborting"; exit 0; }
  rm -rf .next && cp -r ".next-$MODE" .next
  (npx next start -p 3000 > "$OUT/server-$MODE.log" 2>&1 &)
  for i in $(seq 1 60); do curl -s -m 5 -o /dev/null http://localhost:3000/login && break; sleep 2; done
  grep -qE "EADDRINUSE|Failed to start" "$OUT/server-$MODE.log" && { log "!! $MODE server failed to start — aborting"; exit 0; }
  log "$MODE server pid=$(lsof -ti tcp:3000 | head -1) build=$(cat .next/BUILD_ID)"
  timeout 1200 node scripts/native/android-statusbar-check.mjs "$OUT" "$MODE" > "$OUT/check-$MODE.log" 2>&1
  log "$MODE exit=$? entries=$(grep -c '"check"' "$OUT/check-$MODE.log")"
done
timeout 60 adb logcat -d > "$OUT/logcat.txt" 2>&1
grep -qE "FATAL EXCEPTION|ANR in il.co.promaxgroup.dubiz" "$OUT/logcat.txt" && log "!! crash/ANR" || log "no crash/ANR in logcat"
exit 0
