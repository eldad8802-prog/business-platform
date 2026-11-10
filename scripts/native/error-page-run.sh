#!/usr/bin/env bash
# DIAGNOSTIC ONLY — runs the issue-4 error-page check on one emulator.
set -uo pipefail
OUT="native-evidence"; mkdir -p "$OUT"
log() { echo "$(date -u +%H:%M:%S) $*" | tee -a "$OUT/report.txt"; }
log "sdk=$(adb shell getprop ro.build.version.sdk | tr -d '\r')"
adb install -r -t android/app/build/outputs/apk/debug/app-debug.apk > /dev/null 2>&1 && log "apk installed"
adb reverse tcp:3000 tcp:3000
timeout 900 node scripts/native/error-page-check.mjs "$OUT" > "$OUT/check.log" 2>&1
log "check exit=$? entries=$(grep -c '"check"' "$OUT/check.log")"
adb shell cmd connectivity airplane-mode disable > /dev/null 2>&1
adb logcat -d > "$OUT/logcat.txt" 2>&1
grep -qE "ANR in il.co.promaxgroup.dubiz|Process: il.co.promaxgroup.dubiz" "$OUT/logcat.txt" && log "!! app crash/ANR" || log "no app crash/ANR"
exit 0
