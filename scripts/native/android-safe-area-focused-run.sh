#!/usr/bin/env bash
# DIAGNOSTIC ONLY — issue 2 final focused checks (Android 17 / WebView 145).
set -uo pipefail
OUT="native-evidence"; mkdir -p "$OUT"; R="$OUT/report.txt"
log() { echo "$(date -u +%H:%M:%S) $*" | tee -a "$R"; }
A() { timeout 60 adb "$@"; }
log "sdk=$(A shell getprop ro.build.version.sdk | tr -d '\r') webview=$(A shell dumpsys webviewupdate 2>/dev/null | grep -m1 'Current WebView package' | tr -s ' ')"
log "chrome=$(A shell dumpsys package com.android.chrome 2>/dev/null | grep -m1 versionName | tr -d ' ')"
A install -r -t android/app/build/outputs/apk/debug/app-debug.apk > /dev/null 2>&1 && log "apk installed"
A reverse tcp:3000 tcp:3000
rm -rf .next && cp -r .next-after .next
(npx next start -p 3000 > "$OUT/server.log" 2>&1 &)
for i in $(seq 1 60); do curl -s -m 5 -o /dev/null http://localhost:3000/login && break; sleep 2; done
timeout 1500 node scripts/native/android-safe-area-focused.mjs "$OUT" > "$OUT/focused.log" 2>&1
log "focused exit=$? checks=$(grep -c '"check"' "$OUT/focused.log")"
timeout 60 adb logcat -d > "$OUT/logcat.txt" 2>&1
grep -qE "FATAL EXCEPTION|ANR in il.co.promaxgroup.dubiz" "$OUT/logcat.txt" && log "!! crash/ANR" || log "no crash/ANR in logcat"
exit 0
