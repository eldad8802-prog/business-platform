#!/usr/bin/env bash
# DIAGNOSTIC ONLY — issue 3: before (main) / after (app sign-in entry) on one emulator.
set -uo pipefail
OUT="native-evidence"; mkdir -p "$OUT"; R="$OUT/report.txt"
log() { echo "$(date -u +%H:%M:%S) $*" | tee -a "$R"; }
A() { timeout 60 adb "$@"; }
log "sdk=$(A shell getprop ro.build.version.sdk | tr -d '\r') webview=$(A shell dumpsys webviewupdate 2>/dev/null | grep -m1 'Current WebView package' | tr -s ' ')"
A install -r -t android/app/build/outputs/apk/debug/app-debug.apk > /dev/null 2>&1 && log "apk installed"
A reverse tcp:3000 tcp:3000
# Feature switches the sign-in screen reads on the server (register + forgot links). No mail is sent:
# the forgot request is mocked in the check, and nothing else posts to the mail path.
export PUBLIC_SIGNUP_ENABLED=true AUTH_PASSWORD_RESET_ENABLED=true AUTH_PLANE_ENABLED=true \
  TRANSACTIONAL_EMAIL_ENABLED=true RESEND_API_KEY=re_diagnostic_not_a_key \
  TRANSACTIONAL_EMAIL_FROM="Dubiz <no-reply@example.com>" APP_BASE_URL=http://localhost:3000
for MODE in before after; do
  for p in $(lsof -ti tcp:3000 2>/dev/null); do kill -9 "$p" 2>/dev/null; done
  pkill -9 -f "next-server" 2>/dev/null; pkill -9 -f "next start" 2>/dev/null
  for i in $(seq 1 30); do lsof -ti tcp:3000 >/dev/null 2>&1 || break; sleep 1; done
  lsof -ti tcp:3000 >/dev/null 2>&1 && { log "!! port 3000 still busy before $MODE — aborting"; exit 0; }
  rm -rf .next && cp -r ".next-$MODE" .next
  (npx next start -p 3000 > "$OUT/server-$MODE.log" 2>&1 &)
  for i in $(seq 1 60); do curl -s -m 5 -o /dev/null http://localhost:3000/login && break; sleep 2; done
  grep -qE "EADDRINUSE|Failed to start" "$OUT/server-$MODE.log" && { log "!! $MODE server failed to start — aborting"; exit 0; }
  ROOT_IS_MARKETING=$(curl -s -m 10 http://localhost:3000/ | grep -c "העסק שלך" || true)
  log "$MODE server build=$(cat .next/BUILD_ID) root-serves-marketing=$ROOT_IS_MARKETING head-entry-script=$(curl -s -m 10 http://localhost:3000/login | grep -c 'data-shell' || true)"
  if [ "${BROWSER_CHECK:-0}" = "1" ]; then
    timeout 300 node scripts/native/browser-login-check.mjs "$OUT" "$MODE" > "$OUT/browsers-$MODE.log" 2>&1
    log "$MODE browsers exit=$?"
  fi
  timeout 1500 node scripts/native/android-login-check.mjs "$OUT" "$MODE" > "$OUT/check-$MODE.log" 2>&1
  log "$MODE exit=$? entries=$(grep -c '"check"' "$OUT/check-$MODE.log")"
done
timeout 60 adb logcat -d > "$OUT/logcat.txt" 2>&1
grep -E "FATAL EXCEPTION|ANR in" "$OUT/logcat.txt" | head -5 | tee -a "$R"
grep -qE "ANR in il.co.promaxgroup.dubiz|Process: il.co.promaxgroup.dubiz" "$OUT/logcat.txt" && log "!! app crash/ANR" || log "no app crash/ANR in logcat"
exit 0
