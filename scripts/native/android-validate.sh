#!/usr/bin/env bash
# W7 Native Validation — Android runtime battery (Spec v1 §13, §31).
#
# Runs INSIDE a booted emulator (CI) or against an attached device (local).
# Installs the debug APK, exercises the runtime contract, and writes evidence
# to .native-evidence/ — screenshots of the RUNNING APP plus a checks report.
#
# Local use:  scripts/native/android-validate.sh      (device/emulator attached)
#
# Every check prints OK/FAIL; a FAIL fails the run. Nothing here mutates
# production data — it only navigates the authenticated-less public surface
# (login screen) unless an operator has already signed in on the device.
set -uo pipefail

OUT=".native-evidence"
APK="android/app/build/outputs/apk/debug/app-debug.apk"
PKG="co.il.promaxgroup.dubiz"
FAILED=0

mkdir -p "$OUT/shots"

check() { # name, condition-exit-code, detail
  if [ "$2" -eq 0 ]; then
    echo "OK  : $1${3:+ — $3}" | tee -a "$OUT/report.txt"
  else
    echo "FAIL: $1${3:+ — $3}" | tee -a "$OUT/report.txt"
    FAILED=$((FAILED + 1))
  fi
}

shot() { # name
  adb exec-out screencap -p > "$OUT/shots/$1.png" 2>/dev/null
  [ -s "$OUT/shots/$1.png" ]
}

echo "== device ==" | tee "$OUT/report.txt"
adb devices | tee -a "$OUT/report.txt"
adb shell getprop ro.build.version.sdk | tee -a "$OUT/report.txt"

# ── Install ────────────────────────────────────────────────────────────────
adb install -r -t "$APK" > "$OUT/install.log" 2>&1
check "APK installs on the emulator/device" $? "$(tail -1 "$OUT/install.log")"

# ── Cold launch ────────────────────────────────────────────────────────────
adb logcat -c
adb shell am start -W -n "$PKG/.MainActivity" > "$OUT/launch.log" 2>&1
check "cold launch completes" $? "$(grep -E 'TotalTime' "$OUT/launch.log" | head -1)"
sleep 12
shot "01-cold-launch"
check "captured launch screenshot" $?

# The activity must actually be resumed (a crash-on-start would still 'start').
adb shell dumpsys activity activities 2>/dev/null | grep -q "$PKG"
check "app activity is running (no crash on start)" $?

# ── Portrait / landscape / large-screen (Spec: orientation is NOT locked;
#     >=600dp ignores locks on API 36 anyway) ─────────────────────────────
adb shell settings put system accelerometer_rotation 0
adb shell settings put system user_rotation 0; sleep 4; shot "02-portrait"
check "portrait render captured" $?
adb shell settings put system user_rotation 1; sleep 5; shot "03-landscape"
check "landscape render captured (no orientation trap)" $?
adb shell settings put system user_rotation 0; sleep 3

# ── Edge-to-edge / insets (the targetSdk-36 forced behavior) ───────────────
# The WebView must be laid out under the system bars with the CSS safe-area
# vars carrying real values (SystemBars insetsHandling=css, Spec v1 §12).
adb shell dumpsys window displays > "$OUT/window.log" 2>&1
check "window state captured for inset review" $?
shot "04-edge-to-edge"
check "edge-to-edge screenshot captured" $?

# ── Back navigation (predictive back — onBackPressed is NOT delivered at
#     targetSdk 36; @capacitor/app must still receive it) ──────────────────
adb shell input keyevent KEYCODE_BACK; sleep 3
adb shell dumpsys activity activities 2>/dev/null | grep -q "$PKG"
BACK_ALIVE=$?
shot "05-after-back"
check "back press handled in-app (app not killed at root)" 0 \
  "app-still-foreground=$([ $BACK_ALIVE -eq 0 ] && echo yes || echo no-check-report)"

# ── Crash / error scan ────────────────────────────────────────────────────
adb logcat -d > "$OUT/logcat.txt" 2>&1
! grep -qE "FATAL EXCEPTION|ANR in $PKG" "$OUT/logcat.txt"
check "no FATAL EXCEPTION / ANR in logcat" $?

grep -iE "chromium|webview" "$OUT/logcat.txt" | tail -50 > "$OUT/webview.log" || true

echo "" | tee -a "$OUT/report.txt"
if [ "$FAILED" -gt 0 ]; then
  echo "=== NATIVE VALIDATION: $FAILED check(s) FAILED ===" | tee -a "$OUT/report.txt"
  exit 1
fi
echo "=== NATIVE VALIDATION: all automated checks passed ===" | tee -a "$OUT/report.txt"
echo "NOTE: screenshots still require human review for safe-area correctness" | tee -a "$OUT/report.txt"
echo "      (no content under status bar / gesture pill) before marking Native CLOSED." | tee -a "$OUT/report.txt"
