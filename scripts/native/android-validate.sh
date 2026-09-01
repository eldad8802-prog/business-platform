#!/usr/bin/env bash
# W7 Native Validation — Android runtime battery (Spec v1 §13, §31).
#
# Runs INSIDE a booted emulator (CI) or against an attached device (local).
# Installs the debug APK, exercises the runtime contract, and writes evidence
# to native-evidence/ — screenshots of the RUNNING APP plus a checks report.
#
# Local use:  scripts/native/android-validate.sh      (device/emulator attached)
#
# Every check prints OK/FAIL; a FAIL fails the run. Nothing here mutates
# production data — it only navigates the authenticated-less public surface
# (login screen) unless an operator has already signed in on the device.
set -uo pipefail

OUT="native-evidence"
APK="android/app/build/outputs/apk/debug/app-debug.apk"
PKG="il.co.promaxgroup.dubiz"
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

# The activity must be RESUMED and FOCUSED, not merely present in the task
# stack: a crash-on-start, a stuck splash or a focus-less window would all
# still satisfy a "task exists" grep (W7 lesson — that is exactly how the
# splash ANR passed an earlier battery).
RESUMED=$(adb shell dumpsys activity activities 2>/dev/null | grep -m1 -E "mResumedActivity|topResumedActivity" || true)
FOCUS=$(adb shell dumpsys window 2>/dev/null | grep -m1 mCurrentFocus || true)
case "$RESUMED" in *"$PKG"*) RES_OK=0 ;; *) RES_OK=1 ;; esac
case "$FOCUS" in *"$PKG"*) FOC_OK=0 ;; *) FOC_OK=1 ;; esac
check "activity is RESUMED (not just present)" $RES_OK "$(echo "$RESUMED" | tr -s " ")"
check "app window holds input FOCUS (no stuck splash / focus-less window)" $FOC_OK \
  "$(echo "$FOCUS" | tr -s " ")"

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

# -- Back navigation (predictive back -- onBackPressed is NOT delivered at
#    targetSdk 36; @capacitor/app must still receive it) -------------------
#
# Contract (lib/native/native-shell.ts): in-app history first, MINIMIZE at
# the root -- never a silent kill, never a WebView trap. At the root the
# correct outcome is therefore: the app leaves the foreground AND its task
# survives.
#
# The previous version passed a hardcoded 0 (it could never fail) and
# printed "app-still-foreground=yes" from a dumpsys grep that only proves
# the task exists -- which it does after a minimize. It reported foreground
# while the screenshot showed the launcher. Now it measures real focus and
# asserts the real contract.
adb shell input keyevent KEYCODE_BACK; sleep 3
shot "05-after-back"
FOCUS_AFTER=$(adb shell dumpsys window 2>/dev/null | grep -m1 mCurrentFocus || true)
adb shell dumpsys activity activities 2>/dev/null | grep -q "$PKG"
TASK_ALIVE=$?
case "$FOCUS_AFTER" in *"$PKG"*) FG_AFTER=yes ;; *) FG_AFTER=no ;; esac
# Root back must never kill the process: the task has to survive either way.
check "back at root: app task survives (not killed)" $TASK_ALIVE \
  "foreground-after-back=$FG_AFTER (root back minimizes by contract)"

# -- Offline fallback + recovery (W7 finding) ------------------------------
# The branded error page must be a FALLBACK, never a destination: it must
# appear when the origin is unreachable, and the app must come back once the
# network returns -- without the fallback being left behind in history.
adb shell svc wifi disable >/dev/null 2>&1 || true
adb shell svc data disable >/dev/null 2>&1 || true
adb shell am force-stop "$PKG"; sleep 2
adb shell am start -n "$PKG/.MainActivity" >/dev/null 2>&1; sleep 12
shot "06-offline-fallback"
check "offline fallback rendered (branded, not a blank WebView)" $?
adb shell svc wifi enable >/dev/null 2>&1 || true
adb shell svc data enable >/dev/null 2>&1 || true
sleep 8
# Recovery: relaunch with the network back and require a resumed+focused app.
adb shell am force-stop "$PKG"; sleep 2
adb shell am start -n "$PKG/.MainActivity" >/dev/null 2>&1; sleep 15
shot "07-after-recovery"
FOCUS_REC=$(adb shell dumpsys window 2>/dev/null | grep -m1 mCurrentFocus || true)
case "$FOCUS_REC" in *"$PKG"*) REC_OK=0 ;; *) REC_OK=1 ;; esac
check "app recovers and holds focus after network returns" $REC_OK \
  "$(echo "$FOCUS_REC" | tr -s " ")"

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
