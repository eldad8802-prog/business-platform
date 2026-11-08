#!/usr/bin/env bash
# DIAGNOSTIC ONLY (branch diag/android-file-chooser) — documents fix 1, issue B.
#
# Runs inside a booted emulator. The APK bundles scripts/native/file-chooser-probe.html
# as its start page (no server.url), so every tap goes through the real
# Capacitor BridgeWebChromeClient.onShowFileChooser. For each <input type=file>
# variant it records: the intent Android actually started (logcat START line),
# the activity that ended up on top, a screenshot, the visible picker texts,
# and what the page received (change / cancel). Never fails the job on a
# probe outcome — the evidence is the product.
set -uo pipefail
set -f  # no globbing: "*/*" MIME specs below must stay literal

OUT="native-evidence"
APK="android/app/build/outputs/apk/debug/app-debug.apk"
PKG="il.co.promaxgroup.dubiz.probe"
ACT="il.co.promaxgroup.dubiz.MainActivity"
VARIANTS=(C1 C2 UD U1 U2 U3 U4 U5 U6)
N=${#VARIANTS[@]}
mkdir -p "$OUT/shots" "$OUT/ui"
R="$OUT/report.txt"
log() { echo "$*" | tee -a "$R"; }

shot() { adb exec-out screencap -p > "$OUT/shots/$1.png" 2>/dev/null; }
ui() { # name -> dumps UI xml, prints visible texts
  adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
  adb pull /sdcard/ui.xml "$OUT/ui/$1.xml" >/dev/null 2>&1
  grep -oE '(text|content-desc)="[^"]+"' "$OUT/ui/$1.xml" 2>/dev/null | sort -u | head -40 | tr '\n' ' '
}
tap_text() { # name-of-dump, exact text -> taps the node centre, returns 1 if absent
  local b
  b=$(grep -oE "(text|content-desc)=\"$2\"[^>]*bounds=\"\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]\"" "$OUT/ui/$1.xml" 2>/dev/null \
      | head -1 | grep -oE '\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]')
  [ -z "$b" ] && return 1
  local x1 y1 x2 y2
  read -r x1 y1 x2 y2 <<<"$(echo "$b" | tr -c '0-9' ' ')"
  adb shell input tap $(( (x1 + x2) / 2 )) $(( (y1 + y2) / 2 ))
}
top() { adb shell dumpsys activity activities 2>/dev/null | grep -m1 -E "topResumedActivity|mResumedActivity" | tr -s ' '; }
focused_app() { adb shell dumpsys window 2>/dev/null | grep -m1 mCurrentFocus | grep -q "$PKG"; }
ensure_app() {
  focused_app && return
  adb shell am start -n "$PKG/$ACT" >/dev/null 2>&1; sleep 8
}

log "== device =="
log "sdk=$(adb shell getprop ro.build.version.sdk | tr -d '\r') release=$(adb shell getprop ro.build.version.release | tr -d '\r') fingerprint=$(adb shell getprop ro.build.fingerprint | tr -d '\r')"
log "webview=$(adb shell dumpsys webviewupdate 2>/dev/null | grep -m1 -E 'Current WebView package' | tr -s ' ')"

adb install -r -t "$APK" > "$OUT/install.log" 2>&1; log "install: $(tail -1 "$OUT/install.log")"
adb shell pm grant "$PKG" android.permission.CAMERA 2>/dev/null; log "camera permission pre-granted"

# Real files the upload picker should be able to reach in Downloads.
printf '%%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%%%EOF\n' > /tmp/probe.pdf
adb push /tmp/probe.pdf /sdcard/Download/probe.pdf >/dev/null 2>&1
adb exec-out screencap -p > /tmp/probe.png 2>/dev/null && adb push /tmp/probe.png /sdcard/Download/probe.png >/dev/null 2>&1
adb shell content call --method scan_volume --uri content://media --arg external_primary >/dev/null 2>&1 || true
sleep 3

log ""
log "== who answers each intent on this image (package manager resolution) =="
for spec in "GET_CONTENT application/pdf" "GET_CONTENT image/jpeg" "GET_CONTENT */*" "OPEN_DOCUMENT */*"; do
  set -- $spec
  log "-- $1 type=$2:"
  adb shell cmd package query-activities --brief -a "android.intent.action.$1" -c android.intent.category.OPENABLE -t "$2" 2>&1 \
    | tr -d '\r' | grep -v '^$' | sed 's/^/     /' | tee -a "$R" >/dev/null
done
log "-- IMAGE_CAPTURE:"
adb shell cmd package query-activities --brief -a android.media.action.IMAGE_CAPTURE 2>&1 | tr -d '\r' | grep -v '^$' | sed 's/^/     /' | tee -a "$R" >/dev/null

adb shell am start -W -n "$PKG/$ACT" >/dev/null 2>&1; sleep 10
SIZE=$(adb shell wm size | tr -d '\r' | grep -oE '[0-9]+x[0-9]+' | tail -1)
W=${SIZE%x*}; H=${SIZE#*x}
log ""; log "screen=${W}x${H}"; shot "00-probe-page"

for i in "${!VARIANTS[@]}"; do
  v=${VARIANTS[$i]}
  ensure_app
  adb logcat -c
  adb shell input tap $(( W / 2 )) $(( (2 * i + 1) * H / (2 * N) ))
  sleep 5
  log ""; log "== $v =="
  adb logcat -d > "$OUT/logcat-$v-open.txt" 2>&1
  log "started : $(grep -E 'START u0' "$OUT/logcat-$v-open.txt" | grep -v "$PKG/$ACT" | sed -E 's/.*START u0 //' | tr '\n' ' ' | cut -c1-600)"
  log "top     : $(top)"
  shot "$v-1-opened"
  log "ui      : $(ui "$v-opened" | cut -c1-700)"

  picked=no
  case "$v" in
    C*)
      # Emulator camera: shutter, then accept the photo if it asks.
      adb shell input keyevent KEYCODE_CAMERA; sleep 4; shot "$v-2-after-shutter"
      ui "$v-shutter" >/dev/null
      for t in "Shutter" "Take photo" "Done" "OK"; do tap_text "$v-shutter" "$t" && { sleep 3; ui "$v-shutter" >/dev/null; }; done
      sleep 3 ;;
    U*)
      # Reach a real PDF in Downloads through whatever picker opened.
      if tap_text "$v-opened" "probe.pdf"; then picked=pdf-direct
      else
        tap_text "$v-opened" "Show roots" || tap_text "$v-opened" "Navigate up" || true; sleep 2
        ui "$v-roots" >/dev/null
        if tap_text "$v-roots" "Downloads"; then sleep 3; ui "$v-downloads" >/dev/null; shot "$v-2-downloads"
          tap_text "$v-downloads" "probe.pdf" && picked=pdf-via-downloads
        fi
      fi
      sleep 4 ;;
  esac

  if ! focused_app; then adb shell input keyevent KEYCODE_BACK; sleep 3; fi
  if ! focused_app; then adb shell input keyevent KEYCODE_BACK; sleep 3; fi
  shot "$v-3-back-in-app"
  adb logcat -d > "$OUT/logcat-$v.txt" 2>&1
  log "page    : $(grep -oE 'PROBE (change|cancel) [^"]*' "$OUT/logcat-$v.txt" | sort -u | tr '\n' ' ')"
  log "pick    : $picked ; app-focused-after=$(focused_app && echo yes || echo no)"
  grep -E "FileChooser|Capacitor" "$OUT/logcat-$v.txt" | tail -5 >> "$R"
done

# ── Camera (C2 = the shipped camera input) — cancel and permission paths ────
C2_ROW=1
tap_c2() { adb shell input tap $(( W / 2 )) $(( (2 * C2_ROW + 1) * H / (2 * N) )); }
tap_first() { # dump-name, texts... -> taps the first one present
  local d=$1; shift
  for t in "$@"; do tap_text "$d" "$t" && { echo "$t"; return 0; }; done
  echo "(none of: $*)"; return 1
}
reset_camera_perm() { # revoking kills the app process; relaunch afterwards
  adb shell pm revoke "$PKG" android.permission.CAMERA 2>/dev/null
  adb shell pm clear-permission-flags "$PKG" android.permission.CAMERA user-set user-fixed 2>/dev/null
  sleep 2; adb shell am start -n "$PKG/$ACT" >/dev/null 2>&1; sleep 10
}
scenario_end() { # name
  if ! focused_app; then adb shell input keyevent KEYCODE_BACK; sleep 3; fi
  if ! focused_app; then adb shell input keyevent KEYCODE_BACK; sleep 3; fi
  shot "$1-9-end"
  adb logcat -d > "$OUT/logcat-$1.txt" 2>&1
  log "page    : $(grep -oE 'PROBE (change|cancel) [^"]*' "$OUT/logcat-$1.txt" | sort -u | tr '\n' ' ')"
  log "native  : $(grep -E 'FileChooser' "$OUT/logcat-$1.txt" | sed -E 's/.*FileChooser: //' | sort -u | tr '\n' ' ')"
  log "crash   : $(grep -qE "FATAL EXCEPTION|ANR in $PKG" "$OUT/logcat-$1.txt" && echo YES || echo none)"
  log "app-focused-after=$(focused_app && echo yes || echo no)"
}

# S1 — camera opens, user backs out without taking a photo.
log ""; log "== S1 camera-cancel (permission granted) =="
ensure_app; adb logcat -c; tap_c2; sleep 5
log "top     : $(top)"; shot "S1-1-camera"
adb shell input keyevent KEYCODE_BACK; sleep 3
scenario_end S1

# S2 — permission not yet granted: system dialog, user denies.
log ""; log "== S2 permission-deny (dialog) =="
reset_camera_perm; adb logcat -c; tap_c2; sleep 4
log "top     : $(top)"; shot "S2-1-dialog"; ui S2-dialog >/dev/null
log "tapped  : $(tap_first S2-dialog "Don’t allow" "Don't allow" "Deny")"; sleep 4
log "top-after: $(top)"
scenario_end S2

# S3 — permission not yet granted: user allows, camera opens, photo returned.
log ""; log "== S3 permission-allow (dialog) then capture =="
reset_camera_perm; adb logcat -c; tap_c2; sleep 4
shot "S3-1-dialog"; ui S3-dialog >/dev/null
log "tapped  : $(tap_first S3-dialog "While using the app" "Only this time" "Allow")"; sleep 5
log "top     : $(top)"; shot "S3-2-camera"
adb shell input keyevent KEYCODE_CAMERA; sleep 4; ui S3-cam >/dev/null
for t in "Shutter" "Take photo" "Done" "OK"; do tap_text S3-cam "$t" && { sleep 3; ui S3-cam >/dev/null; }; done
sleep 3
scenario_end S3

# S4 — permission permanently denied ("don't ask again"): no dialog at all.
log ""; log "== S4 permission-permanently-denied =="
adb shell pm revoke "$PKG" android.permission.CAMERA 2>/dev/null
adb shell pm set-permission-flags "$PKG" android.permission.CAMERA user-set user-fixed 2>/dev/null
sleep 2; adb shell am start -n "$PKG/$ACT" >/dev/null 2>&1; sleep 10
adb logcat -c; tap_c2; sleep 5
log "top     : $(top)"; shot "S4-1-after-tap"; log "ui      : $(ui S4 | cut -c1-300)"
scenario_end S4

# S5 — after a denial the upload input still works (no stuck chooser).
log ""; log "== S5 upload still works after camera denial =="
ensure_app; adb logcat -c
adb shell input tap $(( W / 2 )) $(( (2 * 2 + 1) * H / (2 * N) )); sleep 5
log "top     : $(top)"; ui S5 >/dev/null; tap_text S5 "probe.pdf" && log "picked  : probe.pdf"; sleep 4
scenario_end S5

UD_ROW=2
tap_ud() { adb shell input tap $(( W / 2 )) $(( (2 * UD_ROW + 1) * H / (2 * N) )); }

# S6 — Documents upload (UD): pick an image instead of a PDF.
log ""; log "== S6 upload picks an image (UD) =="
ensure_app; adb logcat -c; tap_ud; sleep 5
adb logcat -d > "$OUT/logcat-S6-open.txt" 2>&1
log "started : $(grep -E 'START u0' "$OUT/logcat-S6-open.txt" | grep -v "$PKG/$ACT" | sed -E 's/.*START u0 //' | grep -oE 'act=[^ ]+|typ=[^ ]+|cmp=[^ ]+' | tr '\n' ' ')"
log "top     : $(top)"; ui S6 >/dev/null; shot "S6-1-picker"
tap_text S6 "probe.png" && log "picked  : probe.png" || log "picked  : (probe.png not visible)"; sleep 4
scenario_end S6

# S7 — Documents upload (UD): open the picker and cancel.
log ""; log "== S7 upload cancel (UD) =="
ensure_app; adb logcat -c; tap_ud; sleep 5
log "top     : $(top)"; shot "S7-1-picker"
adb shell input keyevent KEYCODE_BACK; sleep 3
scenario_end S7

# S8 — the picker can be opened again right after a cancel (no stuck callback).
log ""; log "== S8 upload reopen after cancel (UD) =="
ensure_app; adb logcat -c; tap_ud; sleep 5
log "top     : $(top)"; ui S8 >/dev/null
tap_text S8 "probe.pdf" && log "picked  : probe.pdf"; sleep 4
scenario_end S8

adb logcat -d > "$OUT/logcat-final.txt" 2>&1
grep -qE "FATAL EXCEPTION|ANR in $PKG" "$OUT/logcat-final.txt" && log "!! crash/ANR seen" || log "no crash/ANR in final logcat window"
log ""; log "=== probe finished ==="
exit 0
