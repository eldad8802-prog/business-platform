#!/usr/bin/env bash
# DIAGNOSTIC ONLY — runs the Google-in-app transport proof on one emulator, for two native builds:
# "current" (the app as it is) and "flush" (MainActivity flushes WebView cookies on pause).
set -uo pipefail
OUT="native-evidence"; mkdir -p "$OUT"
log() { echo "$(date -u +%H:%M:%S) $*" | tee -a "$OUT/report.txt"; }
log "sdk=$(adb shell getprop ro.build.version.sdk | tr -d '\r') chrome=$(adb shell dumpsys package com.android.chrome | grep -m1 versionName | tr -d ' ')"
adb reverse tcp:3000 tcp:3000
for V in current flush; do
  adb uninstall il.co.promaxgroup.dubiz > /dev/null 2>&1
  adb install -r -t "apk/app-$V.apk" > /dev/null 2>&1 && log "$V apk installed"
  pkill -f google-native-proof-server 2>/dev/null; sleep 1
  (node scripts/native/google-native-proof-server.mjs "$OUT/proof-server-$V.log" > "$OUT/server-$V.out" 2>&1 &)
  for i in $(seq 1 30); do curl -s -m 2 -o /dev/null http://localhost:3000/ && break; sleep 1; done
  timeout 900 node scripts/native/google-native-proof.mjs "$OUT" "$V" > "$OUT/proof-$V.log" 2>&1
  log "$V proof exit=$? checks=$(grep -c '"check"' "$OUT/proof-$V.log")"
done
adb logcat -d > "$OUT/logcat.txt" 2>&1
grep -qE "ANR in il.co.promaxgroup.dubiz|Process: il.co.promaxgroup.dubiz" "$OUT/logcat.txt" && log "!! app crash/ANR" || log "no app crash/ANR"
exit 0
