#!/usr/bin/env bash
# DIAGNOSTIC ONLY — stage 1 (cream bars): old vs new APK against the branch's web build, one emulator.
set -uo pipefail
OUT="native-evidence"; mkdir -p "$OUT"
log() { echo "$(date -u +%H:%M:%S) $*" | tee -a "$OUT/report.txt"; }
log "sdk=$(adb shell getprop ro.build.version.sdk | tr -d '\r')"
adb reverse tcp:3000 tcp:3000
(npx next start -p 3000 > "$OUT/server.log" 2>&1 &)
for i in $(seq 1 60); do curl -s -m 5 -o /dev/null http://localhost:3000/login && break; sleep 2; done
for V in old new; do
  adb uninstall il.co.promaxgroup.dubiz > /dev/null 2>&1
  adb install -r -t "apk/app-$V.apk" > /dev/null 2>&1 && log "$V apk installed"
  timeout 900 node scripts/native/cream-bars-check.mjs "$OUT" "$V" > "$OUT/check-$V.log" 2>&1
  log "$V exit=$? entries=$(grep -c '"check"' "$OUT/check-$V.log")"
done
adb shell cmd uimode night no > /dev/null 2>&1
adb logcat -d > "$OUT/logcat.txt" 2>&1
grep -qE "ANR in il.co.promaxgroup.dubiz|Process: il.co.promaxgroup.dubiz" "$OUT/logcat.txt" && log "!! app crash/ANR" || log "no app crash/ANR"
exit 0
