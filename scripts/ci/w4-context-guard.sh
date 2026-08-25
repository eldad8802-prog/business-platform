#!/usr/bin/env bash
# D2 / P7-W4A — async/provider tenant-context invariants (CI-W4).
#
# Mechanical guards for the W4A security foundation:
#   CI-W4-1  every `after(` continuation in app/ runs through runTenantJob
#   CI-W4-2  the WhatsApp webhook derives tenant ONLY via the routing gate
#            (no payload/body/query businessId authority)
#   CI-W4-3  the WhatsApp env fallback stays production-blocked and DB-error-proof
#   CI-W4-4  the Gmail callback never treats the standalone businessId cookie
#            as tenant authority (verified signed state only)
#   CI-W4-5  provider-bootstrap tables are documented in the canonical allowlist
#
# NOT covered mechanically (documented limitation): "no external network call
# inside withTenantTransaction". A grep for fetch() inside tx callbacks would
# be brittle (helper indirection) and create false confidence; the W4A paths
# are proven structurally in .p7w4a/battery.mjs instead. An AST-based lint is
# a candidate for a later slice.
#
# Usage: w4-context-guard.sh [repo-root] | w4-context-guard.sh --self-test
set -euo pipefail

run_guard() {
  local ROOT="${1:-.}"
  cd "$ROOT"
  local fail=0

  # ── CI-W4-1: after() continuations use the canonical tenant job ──────────
  # Every file that calls next/server after() must wrap the continuation in
  # runTenantJob (explicit tenant handoff — never inherited request ALS).
  while IFS= read -r f; do
    if ! grep -q "runTenantJob" "$f"; then
      echo "CI-W4-1 FAIL: $f calls after() without runTenantJob"
      fail=1
    fi
  done < <(grep -rlE "^import \{[^}]*\bafter\b[^}]*\} from \"next/server\"" app --include="*.ts" 2>/dev/null || true)

  # ── CI-W4-2: WhatsApp webhook tenant source ──────────────────────────────
  local WA_ROUTE="app/api/integrations/whatsapp/webhook/route.ts"
  if [ -f "$WA_ROUTE" ]; then
    grep -q "routeInboundWhatsAppMessage" "$WA_ROUTE" || {
      echo "CI-W4-2 FAIL: webhook no longer resolves tenant via the routing gate"; fail=1; }
    grep -q "runTenantJob" "$WA_ROUTE" || {
      echo "CI-W4-2 FAIL: webhook intake branches are not wrapped in runTenantJob"; fail=1; }
    if grep -nE "body\.businessId|payload\.businessId|searchParams.get\([\"']businessId" "$WA_ROUTE" >/dev/null; then
      echo "CI-W4-2 FAIL: webhook reads a raw businessId from the request"; fail=1
    fi
  else
    echo "CI-W4-2 FAIL: $WA_ROUTE missing"; fail=1
  fi

  # ── CI-W4-3: env fallback production-blocked + DB-error-proof ────────────
  local RESOLVE="lib/services/integrations/whatsapp/business-resolve.service.ts"
  if [ -f "$RESOLVE" ]; then
    grep -q 'NODE_ENV === "production") return false' "$RESOLVE" || {
      echo "CI-W4-3 FAIL: env fallback lost its production block"; fail=1; }
  else
    echo "CI-W4-3 FAIL: $RESOLVE missing"; fail=1
  fi
  # The resolver must not swallow DB errors into "not found" (the old
  # catch{return null} pattern that let a DB blip reroute to the env map).
  local CONN="lib/services/integrations/whatsapp/connection.service.ts"
  if [ -f "$CONN" ]; then
    if awk '/export async function resolveBusinessIdByPhoneNumberId/,/^}/' "$CONN" | grep -qE "catch[[:space:]]*[({]"; then
      echo "CI-W4-3 FAIL: resolveBusinessIdByPhoneNumberId swallows DB errors again"; fail=1
    fi
  fi

  # ── CI-W4-4: Gmail callback tenant authority = verified signed state ─────
  local GC="app/api/integrations/gmail/callback/route.ts"
  if [ -f "$GC" ]; then
    grep -q "verifySignedGmailState" "$GC" || {
      echo "CI-W4-4 FAIL: gmail callback does not verify the signed state"; fail=1; }
    # The legacy cookie may only appear in clear/legacy lines — never as a
    # value that is read into a businessId.
    if grep -nE "cookies\.get\([\"']gmail_oauth_business_id" "$GC" >/dev/null; then
      echo "CI-W4-4 FAIL: gmail callback reads the standalone businessId cookie"; fail=1
    fi
  else
    echo "CI-W4-4 FAIL: $GC missing"; fail=1
  fi
  # The connect route must not resurrect the standalone tenant cookie.
  local GCONN="app/api/integrations/gmail/connect/route.ts"
  if [ -f "$GCONN" ] && grep -nE "cookies\.set\([\"']gmail_oauth_business_id" "$GCONN" >/dev/null; then
    echo "CI-W4-4 FAIL: gmail connect sets the standalone businessId cookie again"; fail=1
  fi

  # ── CI-W4-5: provider-bootstrap allowlist documented ─────────────────────
  local DOC="docs/security-d2-provider-bootstrap-allowlist-v1.md"
  if [ -f "$DOC" ]; then
    for t in POSApiKey WhatsAppConnection PaymentWebhookEvent; do
      grep -q "$t" "$DOC" || { echo "CI-W4-5 FAIL: $t missing from bootstrap allowlist"; fail=1; }
    done
  else
    echo "CI-W4-5 FAIL: $DOC missing"; fail=1
  fi

  if [ "$fail" -ne 0 ]; then
    echo "W4-CONTEXT-GUARD FAILED"
    return 1
  fi
  echo "W4-CONTEXT-GUARD OK — CI-W4-1..5 clean."
}

self_test() {
  # Negative proof: plant each violation in a scratch tree and assert the
  # guard catches it.

  BASE="$(mktemp -d)"
  trap "rm -rf \"$BASE\"" EXIT
  local ok=0 bad=0

  make_clean_tree() {
    local T="$1"
    mkdir -p "$T/app/api/integrations/whatsapp/webhook" \
             "$T/app/api/integrations/gmail/callback" \
             "$T/app/api/integrations/gmail/connect" \
             "$T/lib/services/integrations/whatsapp" \
             "$T/docs" "$T/app/api/documents/upload"
    cat > "$T/app/api/documents/upload/route.ts" <<'TS'
import { after } from "next/server";
import { runTenantJob } from "@/lib/tenant/job";
after(() => runTenantJob({ businessId: 1 }, async () => {}));
TS
    cat > "$T/app/api/integrations/whatsapp/webhook/route.ts" <<'TS'
import { routeInboundWhatsAppMessage } from "x";
import { runTenantJob } from "@/lib/tenant/job";
TS
    cat > "$T/lib/services/integrations/whatsapp/business-resolve.service.ts" <<'TS'
function envFallbackEnabled(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return process.env.WHATSAPP_ALLOW_ENV_FALLBACK === "1";
}
TS
    cat > "$T/lib/services/integrations/whatsapp/connection.service.ts" <<'TS'
export async function resolveBusinessIdByPhoneNumberId(id: string) {
  const row = await prisma.whatsAppConnection.findUnique({ where: { phoneNumberId: id } });
  return row?.businessId ?? null;
}
TS
    cat > "$T/app/api/integrations/gmail/callback/route.ts" <<'TS'
import { verifySignedGmailState } from "x";
TS
    cat > "$T/app/api/integrations/gmail/connect/route.ts" <<'TS'
// clean
TS
    cat > "$T/docs/security-d2-provider-bootstrap-allowlist-v1.md" <<'MD'
POSApiKey WhatsAppConnection PaymentWebhookEvent
MD
  }

  check() {
    local name="$1" expect="$2" tree="$3"
    if (run_guard "$tree" >/dev/null 2>&1); then actual=PASS; else actual=FAIL; fi
    if [ "$actual" = "$expect" ]; then ok=$((ok+1)); echo "  [SELF-PASS] $name ($expect)";
    else bad=$((bad+1)); echo "  [SELF-FAIL] $name expected=$expect got=$actual"; fi
  }

  local T0="$BASE/clean"; make_clean_tree "$T0"
  check "clean tree passes" PASS "$T0"

  local T1="$BASE/v1"; make_clean_tree "$T1"
  cat > "$T1/app/api/documents/upload/route.ts" <<'TS'
import { after } from "next/server";
after(() => doWork());
TS
  check "CI-W4-1 catches after() without runTenantJob" FAIL "$T1"

  local T2="$BASE/v2"; make_clean_tree "$T2"
  cat >> "$T2/app/api/integrations/whatsapp/webhook/route.ts" <<'TS'
const businessId = body.businessId;
TS
  check "CI-W4-2 catches raw payload businessId" FAIL "$T2"

  local T3="$BASE/v3"; make_clean_tree "$T3"
  cat > "$T3/lib/services/integrations/whatsapp/business-resolve.service.ts" <<'TS'
function envFallbackEnabled(): boolean {
  return process.env.WHATSAPP_ALLOW_ENV_FALLBACK === "1";
}
TS
  check "CI-W4-3 catches missing production block" FAIL "$T3"

  local T4="$BASE/v4"; make_clean_tree "$T4"
  cat > "$T4/lib/services/integrations/whatsapp/connection.service.ts" <<'TS'
export async function resolveBusinessIdByPhoneNumberId(id: string) {
  try {
    const row = await prisma.whatsAppConnection.findUnique({ where: { phoneNumberId: id } });
    return row?.businessId ?? null;
  } catch {
    return null;
  }
}
TS
  check "CI-W4-3 catches swallowed DB errors" FAIL "$T4"

  local T5="$BASE/v5"; make_clean_tree "$T5"
  cat >> "$T5/app/api/integrations/gmail/callback/route.ts" <<'TS'
const businessIdRaw = req.cookies.get("gmail_oauth_business_id")?.value;
TS
  check "CI-W4-4 catches businessId-cookie authority" FAIL "$T5"

  local T6="$BASE/v6"; make_clean_tree "$T6"
  rm "$T6/docs/security-d2-provider-bootstrap-allowlist-v1.md"
  check "CI-W4-5 catches missing allowlist doc" FAIL "$T6"

  echo "self-test: ok=$ok bad=$bad"
  [ "$bad" -eq 0 ]
}

if [ "${1:-}" = "--self-test" ]; then
  self_test
else
  run_guard "${1:-.}"
fi
