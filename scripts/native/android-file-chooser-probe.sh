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
PKG="il.co.promaxgroup.dubiz"
VARIANTS=(C1 C2 U1 U2 U3 U4 U5 U6)
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
  adb shell am start -n "$PKG/.MainActivity" >/dev/null 2>&1; sleep 8
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

adb shell am start -W -n "$PKG/.MainActivity" >/dev/null 2>&1; sleep 10
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
  log "started : $(grep -E 'START u0' "$OUT/logcat-$v-open.txt" | grep -v "$PKG/.MainActivity" | sed -E 's/.*START u0 //' | tr '\n' ' ' | cut -c1-600)"
  log "top     : $(top)"
  shot "$v-1-opened"
  log "ui      : $(ui "$v-opened" | cut -c1-700)"

  picked=no
  case "$v" in
    C*)
      # Emulator camera: shutter, then accept the photo if it asks.
      adb shell input keyevent KEYCODE_CAMERA; sleep 4; shot "$v-2-after-shutter"
      ui "$v-shutter" >/dev/null
      for t in "Done" "OK" "Shutter" "Take photo"; do tap_text "$v-shutter" "$t" && { sleep 3; ui "$v-shutter" >/dev/null; }; done
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

adb logcat -d > "$OUT/logcat-final.txt" 2>&1
grep -qE "FATAL EXCEPTION|ANR in $PKG" "$OUT/logcat-final.txt" && log "!! crash/ANR seen" || log "no crash/ANR in final logcat window"
log ""; log "=== probe finished ==="
exit 0
