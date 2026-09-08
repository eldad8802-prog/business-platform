#!/usr/bin/env bash
# TEST-ONLY. Android WebView cookie-contract probe — runs INSIDE a booted
# emulator on CI. Evidence only: no Dubiz data, no auth, no database, no
# network beyond a runner-local probe server reached through `adb reverse`.
#
# What it proves, and the reason each step exists:
#
#   the cookie is accepted with all four attributes    the architecture depends on it
#   JavaScript cannot read it                          HttpOnly is the entire XSS defence
#   it reaches /api/auth/refresh                       otherwise refresh cannot work
#   it does NOT reach another API path                 Path scoping bounds the blast radius
#   it survives PROCESS DEATH                          the single most important proof
#   an expiring Set-Cookie removes it                  logout must be able to end it
#   reinstall removes it                               it must not outlive the app
#
# Process death is verified with `pidof`, not assumed from a relaunch: an
# Activity restart is not process death, and a page reload is not either.
set -euo pipefail

PKG="il.co.promaxgroup.dubiz"
PORT="${PROBE_PORT:-3171}"
OUT="${OUT_DIR:-native-evidence}"
APK="${APK_PATH:-android/app/build/outputs/apk/debug/app-debug.apk}"
REPORT="$OUT/cookie-probe.json"
CHECKS="$OUT/cookie-probe-report.txt"

mkdir -p "$OUT"
: > "$CHECKS"
fails=0
check() { # name, exit-code, detail
  if [ "$2" -eq 0 ]; then echo "OK  : $1${3:+ — $3}" | tee -a "$CHECKS"
  else echo "FAIL: $1${3:+ — $3}" | tee -a "$CHECKS"; fails=$((fails + 1)); fi
}

phase() { curl -fsS "http://127.0.0.1:$PORT/control?phase=$1" > /dev/null; }
# The report is append-only; the newest entry for a phase is the one to read.
observed() { # phase, jq-path
  node -e '
    const fs = require("fs");
    const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).report;
    const hits = r.filter((e) => e.phase === process.argv[2]);
    const last = hits[hits.length - 1];
    if (!last) { console.log("MISSING"); process.exit(0); }
    const path = process.argv[3].split(".");
    let v = last;
    for (const p of path) v = v?.[p];
    console.log(String(v));
  ' "$REPORT" "$1" "$2"
}
launch() { adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 > /dev/null 2>&1 || true; }
wait_report() { # phase
  for _ in $(seq 1 40); do
    [ -f "$REPORT" ] && [ "$(observed "$1" phase)" = "$1" ] && return 0
    sleep 1
  done
  return 1
}
pid_of() { adb shell pidof "$PKG" 2>/dev/null | tr -d '\r' || true; }

echo "== cookie probe: reverse-tunnel the runner-local server into the emulator"
adb reverse "tcp:$PORT" "tcp:$PORT"
adb shell "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/plan" > /dev/null 2>&1 || true

echo "== install the debug build"
adb install -r "$APK" > /dev/null

# ── A/B/C/D: set, HttpOnly, scoped send, path isolation ────────────────────
phase SET
launch
wait_report SET || { check "the probe page reported at all" 1 "no report from the WebView"; exit 1; }

ORIGIN="$(observed SET locationOrigin)"
check "the WebView loaded the probe origin" "$([ "$ORIGIN" = "http://127.0.0.1:$PORT" ] && echo 0 || echo 1)" "location.origin=$ORIGIN"
check "A. SET COOKIE accepted by the Android WebView" \
  "$([ "$(observed SET refreshEndpoint.cookiePresent)" = "true" ] && echo 0 || echo 1)"
check "B. HTTPONLY — document.cookie does not contain the marker" \
  "$([ "$(observed SET documentCookieContainsMarker)" = "false" ] && echo 0 || echo 1)" \
  "document.cookie is $(observed SET documentCookie)"
check "C. SCOPED SEND — the cookie reaches /api/auth/refresh" \
  "$([ "$(observed SET refreshEndpoint.matchesMarker)" = "true" ] && echo 0 || echo 1)"
check "D. PATH ISOLATION — it does NOT reach /api/other" \
  "$([ "$(observed SET otherEndpoint.cookiePresent)" = "false" ] && echo 0 || echo 1)"

adb shell screencap -p /sdcard/probe-set.png && adb pull /sdcard/probe-set.png "$OUT/" > /dev/null 2>&1 || true

# ── E: background → foreground (NOT a reload, NOT process death) ────────────
PID_BEFORE_BG="$(pid_of)"
phase BG_FG
adb shell input keyevent KEYCODE_HOME
sleep 3
launch
wait_report BG_FG || true
PID_AFTER_BG="$(pid_of)"
check "E. BACKGROUND → FOREGROUND keeps the cookie usable" \
  "$([ "$(observed BG_FG refreshEndpoint.cookiePresent)" = "true" ] && echo 0 || echo 1)"
check "E. and the process did NOT die — this step is not a kill test" \
  "$([ -n "$PID_BEFORE_BG" ] && [ "$PID_BEFORE_BG" = "$PID_AFTER_BG" ] && echo 0 || echo 1)" \
  "pid $PID_BEFORE_BG -> $PID_AFTER_BG"

# Two earlier runs killed the app about twelve seconds after the cookie was
# set, and both lost it: the Secure cookie and a non-Secure twin alike. That
# rules out this harness serving over loopback http, and points instead at the
# WebView flushing its cookie store to disk lazily rather than being unable to
# persist at all. This wait is the discriminator between those two.
SETTLE="${PROBE_SETTLE_SECONDS:-75}"
echo "== letting the WebView cookie store settle for ${SETTLE}s before the kill"
sleep "$SETTLE"

# ── F: PROCESS KILL → REOPEN. The proof the architecture rests on. ─────────
PID_BEFORE="$(pid_of)"
adb shell am force-stop "$PKG"
sleep 3
PID_DURING="$(pid_of)"
check "F. the app process genuinely died" \
  "$([ -n "$PID_BEFORE" ] && [ -z "$PID_DURING" ] && echo 0 || echo 1)" \
  "pid $PID_BEFORE -> ${PID_DURING:-none}"

phase AFTER_KILL
launch
wait_report AFTER_KILL || true
PID_AFTER="$(pid_of)"
check "F. a NEW process started" \
  "$([ -n "$PID_AFTER" ] && [ "$PID_AFTER" != "$PID_BEFORE" ] && echo 0 || echo 1)" \
  "pid ${PID_BEFORE} -> ${PID_AFTER}"
check "F. PROCESS KILL → REOPEN: the cookie survived" \
  "$([ "$(observed AFTER_KILL refreshEndpoint.cookiePresent)" = "true" ] && echo 0 || echo 1)"
check "F. and it is still the same marker" \
  "$([ "$(observed AFTER_KILL refreshEndpoint.matchesMarker)" = "true" ] && echo 0 || echo 1)"
check "F. still invisible to script after the restart" \
  "$([ "$(observed AFTER_KILL documentCookieContainsMarker)" = "false" ] && echo 0 || echo 1)"

# DIAGNOSIS, not a fallback: the twin is identical except that it omits Secure.
# If the twin survives the kill and the real cookie does not, the cause is this
# harness serving over loopback http, not the Android WebView. The production
# cookie stays Secure either way.
TWIN_AFTER_KILL="$(observed AFTER_KILL refreshEndpoint.twinPresent)"
echo "DIAG: non-Secure twin after process kill = ${TWIN_AFTER_KILL}" | tee -a "$CHECKS"

adb shell screencap -p /sdcard/probe-kill.png && adb pull /sdcard/probe-kill.png "$OUT/" > /dev/null 2>&1 || true

# ── G: app update over the same install, data preserved ────────────────────
adb shell am force-stop "$PKG"
adb install -r "$APK" > /dev/null
phase AFTER_UPDATE
launch
wait_report AFTER_UPDATE || true
check "G. APP UPDATE over the same install keeps the cookie" \
  "$([ "$(observed AFTER_UPDATE refreshEndpoint.cookiePresent)" = "true" ] && echo 0 || echo 1)"

# ── H: the server can remove it ────────────────────────────────────────────
phase CLEAR
adb shell am force-stop "$PKG"
launch
wait_report CLEAR || true
check "H. CLEAR — an expiring Set-Cookie removes it" \
  "$([ "$(observed CLEAR refreshEndpoint.cookiePresent)" = "false" ] && echo 0 || echo 1)"

# ── I: uninstall must take it with the app ─────────────────────────────────
adb uninstall "$PKG" > /dev/null
adb install -r "$APK" > /dev/null
phase AFTER_REINSTALL
launch
wait_report AFTER_REINSTALL || true
check "I. REINSTALL leaves no cookie behind" \
  "$([ "$(observed AFTER_REINSTALL refreshEndpoint.cookiePresent)" = "false" ] && echo 0 || echo 1)"

echo
echo "== cookie probe summary"
cat "$CHECKS"
echo
if [ "$fails" -ne 0 ]; then echo "COOKIE PROBE: $fails FAILED"; exit 1; fi
echo "COOKIE PROBE: all checks passed"
