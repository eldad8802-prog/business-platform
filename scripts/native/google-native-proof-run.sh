#!/usr/bin/env bash
# DIAGNOSTIC ONLY — runs the Google-in-app transport proof on one emulator.
set -uo pipefail
OUT="native-evidence"; mkdir -p "$OUT"
log() { echo "$(date -u +%H:%M:%S) $*" | tee -a "$OUT/report.txt"; }
log "sdk=$(adb shell getprop ro.build.version.sdk | tr -d '\r') chrome=$(adb shell dumpsys package com.android.chrome | grep -m1 versionName | tr -d ' ')"
adb install -r -t android/app/build/outputs/apk/debug/app-debug.apk > /dev/null 2>&1 && log "apk installed"
adb reverse tcp:3000 tcp:3000
(node scripts/native/google-native-proof-server.mjs "$OUT/proof-server.log" > "$OUT/server.out" 2>&1 &)
for i in $(seq 1 30); do curl -s -m 2 -o /dev/null http://localhost:3000/ && break; sleep 1; done
timeout 900 node scripts/native/google-native-proof.mjs "$OUT" > "$OUT/proof.log" 2>&1
log "proof exit=$? checks=$(grep -c '"check"' "$OUT/proof.log")"
adb logcat -d > "$OUT/logcat.txt" 2>&1
grep -qE "ANR in il.co.promaxgroup.dubiz|Process: il.co.promaxgroup.dubiz" "$OUT/logcat.txt" && log "!! app crash/ANR" || log "no app crash/ANR"
exit 0
