#!/usr/bin/env bash
# TEST-ONLY. iOS WKWebView cookie-contract probe — runs on a macOS runner
# against a real iOS Simulator and the real Capacitor app. Evidence only: no
# Dubiz data, no auth, no database, no external network.
#
# It answers the same question Android already answered, because WKWebView is a
# different engine with a different cookie store and nothing about Android
# transfers to it:
#
#   does WKWebView honour HttpOnly + Secure + SameSite=Strict +
#   Path=/api/auth/refresh, and does that cookie survive the app's process
#   being terminated?
#
# Android also showed the cookie store is flushed to disk lazily — a kill twelve
# seconds after the write lost it, a kill after seventy-five seconds did not. So
# this times BOTH, in one run, rather than only the flattering case.
#
# Process termination is `simctl terminate`, and it is verified: the app's pid
# must be present before and absent after. A scene teardown is not process
# death, and a WebView reload is not either.
set -uo pipefail

PKG="il.co.promaxgroup.dubiz"
PORT="${PROBE_PORT:-3171}"
OUT="${OUT_DIR:-native-evidence}"
APP="${APP_PATH:?APP_PATH (the built .app bundle) is required}"
DEVICE="${SIM_UDID:-booted}"
REPORT="$OUT/cookie-probe.json"
CHECKS="$OUT/ios-cookie-probe-report.txt"
SHORT_DELAY="${PROBE_SHORT_DELAY:-10}"
LONG_DELAY="${PROBE_LONG_DELAY:-75}"
# WebKit refused a Secure cookie over loopback http, so the probe is served
# over TLS with an ephemeral certificate the simulator trusts. -k is for that
# certificate on the RUNNER side only; the WebView validates it properly.
# The runner drives the probe over loopback — control traffic has no reason to
# make a round trip through the public tunnel. The WebView is the only thing
# that uses the public origin, and PROBE_PUBLIC_ORIGIN is what its
# location.origin is checked against.
BASE="http://localhost:$PORT"
PUBLIC_ORIGIN="${PROBE_PUBLIC_ORIGIN:-$BASE}"

mkdir -p "$OUT"
: > "$CHECKS"
fails=0
check() { # name, exit-code, detail
  if [ "$2" -eq 0 ]; then echo "OK  : $1${3:+ — $3}" | tee -a "$CHECKS"
  else echo "FAIL: $1${3:+ — $3}" | tee -a "$CHECKS"; fails=$((fails + 1)); fi
}
note() { echo "$1" | tee -a "$CHECKS"; }

phase() { curl -fsS "$BASE/control?phase=$1" > /dev/null; }
observed() { # phase, path
  node -e '
    const fs = require("fs");
    const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).report;
    const hits = r.filter((e) => e.phase === process.argv[2]);
    const last = hits[hits.length - 1];
    if (!last) { console.log("MISSING"); process.exit(0); }
    let v = last;
    for (const p of process.argv[3].split(".")) v = v?.[p];
    console.log(String(v));
  ' "$REPORT" "$1" "$2"
}
launch() { xcrun simctl launch "$DEVICE" "$PKG" > /dev/null 2>&1 || true; }
pid_of() { xcrun simctl spawn "$DEVICE" launchctl list 2>/dev/null | grep -F "$PKG" | awk '{print $1}' | head -1 | tr -d '\r'; }
wait_report() { # phase
  for _ in $(seq 1 45); do
    [ -f "$REPORT" ] && [ "$(observed "$1" phase)" = "$1" ] && return 0
    sleep 1
  done
  return 1
}

echo "== install the app on the simulator"
xcrun simctl install "$DEVICE" "$APP"

# ── A/B/C/D ────────────────────────────────────────────────────────────────
phase SET
launch
wait_report SET || { check "the probe page reported at all" 1 "no report from WKWebView"; exit 1; }

ORIGIN="$(observed SET locationOrigin)"
check "WKWebView loaded the probe origin" \
  "$([ "$ORIGIN" = "$PUBLIC_ORIGIN" ] && echo 0 || echo 1)" "location.origin=$ORIGIN"
check "A. SET COOKIE accepted by WKWebView" \
  "$([ "$(observed SET refreshEndpoint.cookiePresent)" = "true" ] && echo 0 || echo 1)"
check "B. HTTPONLY — document.cookie does not contain the marker" \
  "$([ "$(observed SET documentCookieContainsMarker)" = "false" ] && echo 0 || echo 1)" \
  "document.cookie is $(observed SET documentCookie)"
check "C. SCOPED SEND — the SECURE cookie reaches /api/auth/refresh" \
  "$([ "$(observed SET refreshEndpoint.cookiePresent)" = "true" ] && [ "$(observed SET refreshEndpoint.matchesMarker)" = "true" ] && echo 0 || echo 1)"
check "D. PATH ISOLATION — it does NOT reach /api/other" \
  "$([ "$(observed SET otherEndpoint.cookiePresent)" = "false" ] && echo 0 || echo 1)"
note "DIAG: non-Secure twin present at SET = $(observed SET refreshEndpoint.twinPresent)"

xcrun simctl io "$DEVICE" screenshot "$OUT/ios-probe-set.png" > /dev/null 2>&1 || true

# ── E: background → foreground. Not a kill, and labelled as such. ──────────
PID_BG_BEFORE="$(pid_of)"
phase BG_FG
xcrun simctl launch "$DEVICE" com.apple.springboard > /dev/null 2>&1 || true
sleep 3
launch
wait_report BG_FG || true
PID_BG_AFTER="$(pid_of)"
check "E. BACKGROUND → FOREGROUND keeps the cookie usable" \
  "$([ "$(observed BG_FG refreshEndpoint.cookiePresent)" = "true" ] && echo 0 || echo 1)"
check "E. and the process did NOT die — this step is not a kill test" \
  "$([ -n "$PID_BG_BEFORE" ] && [ "$PID_BG_BEFORE" = "$PID_BG_AFTER" ] && echo 0 || echo 1)" \
  "pid ${PID_BG_BEFORE:-none} -> ${PID_BG_AFTER:-none}"

# ── F1: SHORT-DELAY termination. Android lost the cookie here. ─────────────
note "== short-delay kill: terminating ${SHORT_DELAY}s after the cookie was written"
sleep "$SHORT_DELAY"
PID_S_BEFORE="$(pid_of)"
xcrun simctl terminate "$DEVICE" "$PKG" > /dev/null 2>&1 || true
sleep 3
PID_S_DURING="$(pid_of)"
check "F1. the app process genuinely terminated (short delay)" \
  "$([ -n "$PID_S_BEFORE" ] && [ -z "$PID_S_DURING" ] && echo 0 || echo 1)" \
  "pid ${PID_S_BEFORE:-none} -> ${PID_S_DURING:-none}"
phase AFTER_KILL_SHORT
launch
wait_report AFTER_KILL_SHORT || true
SHORT_SURVIVED="$(observed AFTER_KILL_SHORT refreshEndpoint.cookiePresent)"
note "RESULT: short-delay kill (${SHORT_DELAY}s) cookie survived = ${SHORT_SURVIVED}"

# ── F2: LONG-DELAY termination. Android survived here. ────────────────────
phase SET_AGAIN
launch
wait_report SET_AGAIN || true
note "== long-delay kill: letting the cookie store settle for ${LONG_DELAY}s"
sleep "$LONG_DELAY"
PID_L_BEFORE="$(pid_of)"
xcrun simctl terminate "$DEVICE" "$PKG" > /dev/null 2>&1 || true
sleep 3
PID_L_DURING="$(pid_of)"
check "F2. the app process genuinely terminated (long delay)" \
  "$([ -n "$PID_L_BEFORE" ] && [ -z "$PID_L_DURING" ] && echo 0 || echo 1)" \
  "pid ${PID_L_BEFORE:-none} -> ${PID_L_DURING:-none}"
phase AFTER_KILL_LONG
launch
wait_report AFTER_KILL_LONG || true
PID_L_AFTER="$(pid_of)"
check "F. a NEW process started" \
  "$([ -n "$PID_L_AFTER" ] && [ "$PID_L_AFTER" != "$PID_L_BEFORE" ] && echo 0 || echo 1)" \
  "pid ${PID_L_BEFORE:-none} -> ${PID_L_AFTER:-none}"
check "F. PROCESS TERMINATION → REOPEN: the cookie survived" \
  "$([ "$(observed AFTER_KILL_LONG refreshEndpoint.cookiePresent)" = "true" ] && echo 0 || echo 1)"
check "F. and it is still the same marker" \
  "$([ "$(observed AFTER_KILL_LONG refreshEndpoint.matchesMarker)" = "true" ] && echo 0 || echo 1)"
check "F. still invisible to script after the restart" \
  "$([ "$(observed AFTER_KILL_LONG documentCookieContainsMarker)" = "false" ] && echo 0 || echo 1)"
note "RESULT: long-delay kill (${LONG_DELAY}s) cookie survived = $(observed AFTER_KILL_LONG refreshEndpoint.cookiePresent)"

xcrun simctl io "$DEVICE" screenshot "$OUT/ios-probe-kill.png" > /dev/null 2>&1 || true

# ── G: app update over the same install ───────────────────────────────────
xcrun simctl terminate "$DEVICE" "$PKG" > /dev/null 2>&1 || true
xcrun simctl install "$DEVICE" "$APP"
phase AFTER_UPDATE
launch
wait_report AFTER_UPDATE || true
check "G. APP UPDATE over the same install keeps the cookie" \
  "$([ "$(observed AFTER_UPDATE refreshEndpoint.cookiePresent)" = "true" ] && echo 0 || echo 1)"

# ── H: the server can remove it ───────────────────────────────────────────
phase CLEAR
xcrun simctl terminate "$DEVICE" "$PKG" > /dev/null 2>&1 || true
launch
wait_report CLEAR || true
check "H. CLEAR — an expiring Set-Cookie removes it" \
  "$([ "$(observed CLEAR refreshEndpoint.cookiePresent)" = "false" ] && echo 0 || echo 1)"

# ── I: uninstall must take it with the app ────────────────────────────────
xcrun simctl uninstall "$DEVICE" "$PKG" > /dev/null 2>&1 || true
xcrun simctl install "$DEVICE" "$APP"
phase AFTER_REINSTALL
launch
wait_report AFTER_REINSTALL || true
check "I. REINSTALL leaves no cookie behind" \
  "$([ "$(observed AFTER_REINSTALL refreshEndpoint.cookiePresent)" = "false" ] && echo 0 || echo 1)"

echo
echo "== ios cookie probe summary"
cat "$CHECKS"
echo
if [ "$fails" -ne 0 ]; then echo "IOS COOKIE PROBE: $fails FAILED"; exit 1; fi
echo "IOS COOKIE PROBE: all checks passed"
