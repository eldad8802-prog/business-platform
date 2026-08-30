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

  # ── CI-W4B-1: WhatsAppConnection must NEVER receive tenant RLS ──────────
  if grep -rn "ROW LEVEL SECURITY" prisma/migrations --include="*.sql" 2>/dev/null | grep -q "WhatsAppConnection"; then
    echo "CI-W4B-1 FAIL: a migration puts RLS on WhatsAppConnection (provider bootstrap)"; fail=1
  fi

  # ── CI-W4B-2: Message dedup stays tenant-scoped ──────────────────────────
  if [ -f prisma/schema.prisma ] && ! grep -q "@@unique(\[businessId, providerMessageId\])" prisma/schema.prisma; then
    echo "CI-W4B-2 FAIL: Message lost its tenant-scoped provider unique"; fail=1
  fi

  # ── CI-W4B-3: no global-Prisma W4B writes in post-Phase-A paths ──────────
  # These files were tx-threaded in W4B; a reappearing prisma.<model>.write
  # would bypass the tenant transaction. The "?? prisma" fallback declaration
  # lines are the sanctioned pattern and are excluded.
  W4B_WRITE_RX="prisma\.(message|messageAnalysis|replySuggestion|businessBotSettings|whatsAppAttachmentImport)\.(create|update|upsert|delete)"
  W4B_FILES="lib/services/conversation/inbound-message-pipeline.service.ts lib/reply-suggestions/generate-reply-suggestions.ts lib/services/integrations/whatsapp/whatsapp-import-row.service.ts lib/services/integrations/whatsapp/conversation-intake.service.ts lib/learning/update-learning.ts"
  for wf in $W4B_FILES; do
    if [ -f "$wf" ] && grep -nE "$W4B_WRITE_RX" "$wf" >/dev/null; then
      echo "CI-W4B-3 FAIL: $wf writes a W4B table on the global client"; fail=1
    fi
  done

  # ── CI-W4C-1: gmail callback tenant authority stays the verified state ──
  GC="app/api/integrations/gmail/callback/route.ts"
  if [ -f "$GC" ]; then
    grep -q "verifiedState.state.businessId" "$GC" || {
      echo "CI-W4C-1 FAIL: callback no longer derives tenant from the verified state"; fail=1; }
  fi

  # ── CI-W4C-2: EmailConnection must HAVE tenant RLS (not bootstrap) and
  #    OAuthToken must keep its parent-join policy ──
  W4C_MIG="prisma/migrations/20260826200000_d2_p7_w4c_gmail_tenant_rls/migration.sql"
  if [ -f "$W4C_MIG" ]; then
    grep -q 'CREATE POLICY p7w4c_tenant ON "EmailConnection"' "$W4C_MIG" || {
      echo "CI-W4C-2 FAIL: EmailConnection lost its tenant policy"; fail=1; }
    grep -q '"OAuthToken"."connectionId"' "$W4C_MIG" || {
      echo "CI-W4C-2 FAIL: OAuthToken lost its parent-join policy"; fail=1; }
  fi
  if [ -f docs/security-d2-provider-bootstrap-allowlist-v1.md ] && grep -qE '^\| .EmailConnection' docs/security-d2-provider-bootstrap-allowlist-v1.md; then
    echo "CI-W4C-2 FAIL: EmailConnection listed as a bootstrap table"; fail=1
  fi

  # ── CI-W4C-3: no global-Prisma W4C writes in the Gmail services/route ──
  W4C_WRITE_RX="prisma\.(emailConnection|oAuthToken|emailAttachmentImport)\.(create|update|upsert|delete)"
  W4C_FILES="lib/services/integrations/gmail/gmail-auth.service.ts lib/services/integrations/gmail/gmail-connection.service.ts lib/services/integrations/gmail/gmail-discovery.service.ts lib/services/integrations/gmail/email-import-dedup.service.ts app/api/integrations/gmail/import/route.ts app/api/integrations/gmail/callback/route.ts"
  for wf in $W4C_FILES; do
    if [ -f "$wf" ] && grep -nE "$W4C_WRITE_RX" "$wf" >/dev/null; then
      echo "CI-W4C-3 FAIL: $wf writes a W4C table on the global client"; fail=1
    fi
  done

  # ── CI-W4D-1: the approval route must stay a tenant transaction ──────────
  APPROVE="app/api/documents/[id]/approve/route.ts"
  if [ -f "$APPROVE" ] && ! grep -q "withTenantTransaction" "$APPROVE"; then
    echo "CI-W4D-1 FAIL: approve route lost its tenant transaction"; fail=1
  fi

  # ── CI-W4D-2: learning-center global reads must use the admin client ─────
  LC="lib/services/learning-center/learning-center-data.ts"
  if [ -f "$LC" ]; then
    grep -q "getPrismaAdmin" "$LC" || {
      echo "CI-W4D-2 FAIL: learning-center left the admin client"; fail=1; }
    if grep -qE 'from "@/lib/prisma"' "$LC"; then
      echo "CI-W4D-2 FAIL: learning-center imports the tenant client"; fail=1
    fi
  fi

  # ── CI-W4D-3: dead vendor-learning service stays deleted ─────────────────
  if [ -f "lib/services/documents/vendor-learning.service.ts" ]; then
    echo "CI-W4D-3 FAIL: dead vendor-learning.service.ts resurrected"; fail=1
  fi

  # ── CI-W4D-4: indirect parent-join shapes present in the W4D migration ───
  W4D_MIG="prisma/migrations/20260827090000_d2_p7_w4d_documents_tenant_rls/migration.sql"
  if [ -f "$W4D_MIG" ]; then
    grep -q '"ExtractedData"."documentId"' "$W4D_MIG" || {
      echo "CI-W4D-4 FAIL: ExtractedData lost its parent-join policy"; fail=1; }
    grep -q '"ExtractionEvidence"."extractionSnapshotId"' "$W4D_MIG" || {
      echo "CI-W4D-4 FAIL: ExtractionEvidence lost its parent-join policy"; fail=1; }
  fi

  # ── CI-W4D-5: no global-Prisma W4D writes in the wired paths ─────────────
  W4D_WRITE_RX="prisma\.(document|extractedData|financialRecord|vendorLearning|extractionSnapshot|sliceDecision|extractionEvidence|reviewEvent)\.(create|update|upsert|delete|createMany|updateMany)"
  W4D_FILES="app/api/documents/[id]/approve/route.ts app/api/documents/[id]/process/route.ts app/api/documents/upload/route.ts lib/services/documents/create-document-from-ocr.service.ts lib/services/documents/ledger/correction-ledger.service.ts lib/services/documents/process-document-pipeline.service.ts app/api/integrations/gmail/import/route.ts"
  for wf in $W4D_FILES; do
    if [ -f "$wf" ] && grep -nE "$W4D_WRITE_RX" "$wf" >/dev/null; then
      echo "CI-W4D-5 FAIL: $wf writes a W4D table on the global client"; fail=1
    fi
  done

  # ── CI-W4E-1: payment webhook payload is never tenant authority ──────────
  # The webhook service must derive its tenant from the STORED PaymentRequest.
  # Any read of businessId out of the parsed provider payload is a hard fail.
  W4E_WH="lib/services/payments/payment-webhook.service.ts"
  if [ -f "$W4E_WH" ]; then
    grep -q "runWithTenantContext({ businessId: request.businessId }" "$W4E_WH" || {
      echo "CI-W4E-1 FAIL: webhook no longer derives tenant from the stored PaymentRequest"; fail=1; }
    if grep -nE "(parsed|input|body|payload|headers)[a-zA-Z.]*\.businessId" "$W4E_WH" >/dev/null; then
      echo "CI-W4E-1 FAIL: $W4E_WH reads businessId out of the provider payload"; fail=1
    fi
  fi

  # ── CI-W4E-2: no global Prisma in the payments store ─────────────────────
  # Every DB call must go through dbStep (tenant) or bootstrapStep (allowlisted
  # pre-context). A bare `prisma.<model>.` is the exact regression that would
  # silently return zero rows under FORCE RLS.
  W4E_STORE="lib/services/payments/payment-store.prisma.ts"
  if [ -f "$W4E_STORE" ]; then
    if grep -nE "(await|return) prisma\.[a-z]" "$W4E_STORE" >/dev/null; then
      echo "CI-W4E-2 FAIL: $W4E_STORE reaches the global client outside dbStep/bootstrapStep"; fail=1
    fi
  fi

  # ── CI-W4E-3/4: bootstrapStep allowlist + never a protected table ─────────
  # bootstrapStep is the ONLY sanctioned pre-context path. It may touch exactly
  # PaymentWebhookEvent and PaymentProviderRouting; anything else would turn it
  # into a generic escape hatch around RLS.
  if [ -f "$W4E_STORE" ]; then
    W4E_BOOT_MODELS="$( { grep -oE "bootstrapStep[(][(]db[)] => db[.][a-zA-Z]+" "$W4E_STORE" | sed 's/.*db[.]//'; grep -A1 -E "bootstrapStep[(][(]db[)] =>$" "$W4E_STORE" | grep -oE "db[.][a-zA-Z]+" | sed 's/db[.]//'; } 2>/dev/null | sort -u || true)"
    for model in $W4E_BOOT_MODELS; do
      case "$model" in
        paymentWebhookEvent|paymentProviderRouting) : ;;
        *) echo "CI-W4E-3 FAIL: bootstrapStep touches non-allowlisted model '$model'"; fail=1 ;;
      esac
    done
    for model in $W4E_BOOT_MODELS; do
      case "$model" in
        paymentTransaction|paymentAuditEvent|financialEvent|paymentRequest)
          echo "CI-W4E-4 FAIL: bootstrapStep reaches protected payment table '$model'"; fail=1 ;;
      esac
    done
  fi

  # ── CI-W4E-5/6/7: routing table posture + parent-join policy ──────────────
  W4E_MIG="prisma/migrations/20260830120000_d2_p7_w4ea_payments_tenant_rls/migration.sql"
  if [ -f "$W4E_MIG" ]; then
    if grep -nE "ROW LEVEL SECURITY" "$W4E_MIG" | grep -q "PaymentProviderRouting"; then
      echo "CI-W4E-5 FAIL: PaymentProviderRouting gained RLS without an architecture change"; fail=1
    fi
    if sed -n '/CREATE TABLE IF NOT EXISTS "PaymentProviderRouting"/,/^);/p' "$W4E_MIG" \
       | grep -niE '"(amount|currency|status|customerId|description|paymentUrl|payload|credential|token|secret|merchantId)"' >/dev/null; then
      echo "CI-W4E-6 FAIL: PaymentProviderRouting is no longer routing-only"; fail=1
    fi
    grep -q '"PaymentTransaction"."paymentRequestId"' "$W4E_MIG" || {
      echo "CI-W4E-7 FAIL: PaymentTransaction lost its parent-join policy"; fail=1; }
  fi

  # ── CI-W4E-8: provider calls stay outside the tenant transaction ──────────
  for pf in lib/services/payments/*.ts; do
    [ -f "$pf" ] || continue
    case "$pf" in *.test.ts) continue ;; esac
    if awk '/withTenantTransaction\(/{d=1} d{print} /^[[:space:]]*\)[[:space:]]*;?[[:space:]]*$/{d=0}' "$pf" \
       | grep -qE "getPaymentStatus|createPaymentLink|fetch\("; then
      echo "CI-W4E-8 FAIL: $pf makes a provider call inside a tenant transaction"; fail=1
    fi
  done

  # ── CI-W4E-9: FinancialEvent stays tenant-threaded ───────────────────────
  W4E_DEPS="lib/services/payments/payments.deps.ts"
  if [ -f "$W4E_DEPS" ]; then
    if grep -v "^[[:space:]]*//" "$W4E_DEPS" | grep -q "prisma[.][$]transaction"; then
      echo "CI-W4E-9 FAIL: $W4E_DEPS posts FinancialEvent on a global transaction"; fail=1
    fi
    grep -q "withTenantTransaction" "$W4E_DEPS" || {
      echo "CI-W4E-9 FAIL: $W4E_DEPS no longer posts FinancialEvent on a tenant transaction"; fail=1; }
  fi

  # ── CI-W4E-10: routing is verified against the stored PaymentRequest ──────
  # The routing row is a HINT; the callback must re-read the parent constrained
  # by BOTH the routed id and the routed businessId, so a tampered routing row
  # can only produce a refusal.
  if [ -f "$W4E_STORE" ]; then
    grep -q "id: route.paymentRequestId" "$W4E_STORE" || {
      echo "CI-W4E-10 FAIL: routing no longer resolves through the stored parent id"; fail=1; }
    grep -q "businessId: route.businessId" "$W4E_STORE" || {
      echo "CI-W4E-10 FAIL: routing businessId is not checked against the stored PaymentRequest"; fail=1; }
  fi

  # ── CI-W4EB1-1: the ITA callback never treats a cookie as tenant authority ─
  # The cookie may still be READ (it is cross-checked against the signed state),
  # but it must never be what the resolved context is built from.
  W4EB_CB="lib/services/billing/authority/billing-authority-oauth-callback.service.ts"
  if [ -f "$W4EB_CB" ]; then
    if grep -q "businessId: parsedCookies.businessId," "$W4EB_CB"; then
      echo "CI-W4EB1-1 FAIL: the resolved context is built from the cookie businessId"; fail=1
    fi
    grep -q "businessId: verified.state.businessId" "$W4EB_CB" || {
      echo "CI-W4EB1-1 FAIL: the context no longer resolves businessId from the verified state"; fail=1; }
    grep -q "actorUserId: verified.state.userId" "$W4EB_CB" || {
      echo "CI-W4EB1-1 FAIL: the acting user is no longer taken from the verified state"; fail=1; }
  fi

  # ── CI-W4EB1-2: the callback verifies the state; no unsigned acceptance ────
  if [ -f "$W4EB_CB" ]; then
    grep -q "verifySignedAuthorityState" "$W4EB_CB" || {
      echo "CI-W4EB1-2 FAIL: the callback no longer verifies the signed state"; fail=1; }
  fi

  # ── CI-W4EB1-3: the signed-state service keeps every binding + check ───────
  W4EB_ST="lib/services/billing/authority/billing-authority-signed-state.service.ts"
  if [ -f "$W4EB_ST" ]; then
    for needle in "createHmac" "timingSafeEqual" "purpose" "environment" "nonce" "exp"; do
      grep -q "$needle" "$W4EB_ST" || {
        echo "CI-W4EB1-3 FAIL: signed state lost '$needle'"; fail=1; }
    done
    grep -q 'reason: "wrong_purpose"' "$W4EB_ST" || {
      echo "CI-W4EB1-3 FAIL: purpose validation removed"; fail=1; }
    grep -q 'reason: "wrong_environment"' "$W4EB_ST" || {
      echo "CI-W4EB1-3 FAIL: environment validation removed"; fail=1; }
    grep -q 'reason: "expired"' "$W4EB_ST" || {
      echo "CI-W4EB1-3 FAIL: expiry enforcement removed"; fail=1; }
    grep -q 'reason: "wrong_version"' "$W4EB_ST" || {
      echo "CI-W4EB1-3 FAIL: version validation removed"; fail=1; }
  fi

  # ── CI-W4EB1-4: Gmail and Authority envelopes stay cryptographically apart ─
  # Different derivation labels are what makes one envelope unusable as the
  # other. Identical labels would silently collapse that separation.
  W4EB_GM="lib/services/integrations/gmail/signed-state.service.ts"
  if [ -f "$W4EB_ST" ] && [ -f "$W4EB_GM" ]; then
    A_LABEL="$(grep 'KEY_DERIVATION_LABEL =' "$W4EB_ST" | head -1)"
    G_LABEL="$(grep 'KEY_DERIVATION_LABEL =' "$W4EB_GM" | head -1)"
    if [ "$A_LABEL" = "$G_LABEL" ]; then
      echo "CI-W4EB1-4 FAIL: Gmail and Authority share a key-derivation label"; fail=1
    fi
    A_PURPOSE="$(grep '^const PURPOSE =' "$W4EB_ST" | head -1)"
    G_PURPOSE="$(grep '^const PURPOSE =' "$W4EB_GM" | head -1)"
    if [ "$A_PURPOSE" = "$G_PURPOSE" ]; then
      echo "CI-W4EB1-4 FAIL: Gmail and Authority share a state purpose"; fail=1
    fi
  fi

  # ── CI-W4EB1-5: authority connection writes stay on a tenant transaction ───
  W4EB_CONN="lib/services/billing/authority/billing-authority-connection.service.ts"
  if [ -f "$W4EB_CONN" ]; then
    if grep -q 'prisma\.\$transaction' "$W4EB_CONN"; then
      echo "CI-W4EB1-5 FAIL: an authority connection transition reverted to a global transaction"; fail=1
    fi
    grep -q "billingTenantTx" "$W4EB_CONN" || {
      echo "CI-W4EB1-5 FAIL: authority connection transitions no longer use the tenant transaction"; fail=1; }
  fi


  if [ "$fail" -ne 0 ]; then
    echo "W4-CONTEXT-GUARD FAILED"
    return 1
  fi
  echo "W4-CONTEXT-GUARD OK — CI-W4-1..5 + CI-W4B-1..3 + CI-W4C-1..3 + CI-W4D-1..5 + CI-W4E-1..10 + CI-W4EB1-1..5 clean."
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
    mkdir -p "$T/prisma/migrations/m1" "$T/lib/services/conversation" "$T/lib/reply-suggestions" "$T/lib/learning"
    printf 'CREATE POLICY x ON "Message";\n' > "$T/prisma/migrations/m1/migration.sql"
    printf 'model Message {\n  @@unique([businessId, providerMessageId])\n}\n' > "$T/prisma/schema.prisma"
    printf 'const db = options?.tx ?? prisma;\n' > "$T/lib/services/conversation/inbound-message-pipeline.service.ts"
    mkdir -p "$T/prisma/migrations/w4c" "$T/lib/services/integrations/gmail" "$T/app/api/integrations/gmail/import"
    printf 'CREATE POLICY p7w4c_tenant ON "EmailConnection";\nx "OAuthToken"."connectionId" x\n' > "$T/prisma/migrations/w4c/../20260826200000_d2_p7_w4c_gmail_tenant_rls_placeholder.sql"
    mkdir -p "$T/prisma/migrations/20260826200000_d2_p7_w4c_gmail_tenant_rls"
    printf 'CREATE POLICY p7w4c_tenant ON "EmailConnection";\nUSING x "OAuthToken"."connectionId" x\n' > "$T/prisma/migrations/20260826200000_d2_p7_w4c_gmail_tenant_rls/migration.sql"
    printf '// clean\n' > "$T/lib/services/integrations/gmail/gmail-auth.service.ts"
    printf 'const businessId = verifiedState.state.businessId;\n' >> "$T/app/api/integrations/gmail/callback/route.ts"
    mkdir -p "$T/app/api/documents/[id]/approve" "$T/lib/services/learning-center" "$T/prisma/migrations/20260827090000_d2_p7_w4d_documents_tenant_rls"
    printf 'withTenantTransaction\n' > "$T/app/api/documents/[id]/approve/route.ts"
    printf 'import { getPrismaAdmin } from "x";\n' > "$T/lib/services/learning-center/learning-center-data.ts"
    printf '%s\n%s\n' 'x "ExtractedData"."documentId" x' 'x "ExtractionEvidence"."extractionSnapshotId" x' > "$T/prisma/migrations/20260827090000_d2_p7_w4d_documents_tenant_rls/migration.sql"
    cat > "$T/docs/security-d2-provider-bootstrap-allowlist-v1.md" <<'MD'
POSApiKey WhatsAppConnection PaymentWebhookEvent PaymentProviderRouting
MD
    mkdir -p "$T/lib/services/payments" "$T/prisma/migrations/20260830120000_d2_p7_w4ea_payments_tenant_rls"
    cat > "$T/lib/services/payments/payment-webhook.service.ts" <<'TS'
return runWithTenantContext({ businessId: request.businessId }, async () => {});
TS
    cat > "$T/lib/services/payments/payment-store.prisma.ts" <<'TS'
const route = await bootstrapStep((db) => db.paymentProviderRouting.findUnique({}));
const created = await bootstrapStep((db) => db.paymentWebhookEvent.create({}));
const row = await dbStep((db) => db.paymentRequest.findFirst({ where: { id: route.paymentRequestId, businessId: route.businessId } }));
TS
    cat > "$T/lib/services/payments/payments.deps.ts" <<'TS'
await runWithTenantContext({ businessId: e.businessId }, () => withTenantTransaction((tx) => ensurePaymentPostedEvent(tx, {})));
TS
    cat > "$T/lib/services/payments/payment-request.service.ts" <<'TS'
const linkResult = await adapter.createPaymentLink({});
TS
    mkdir -p "$T/lib/services/billing/authority"
    cat > "$T/lib/services/billing/authority/billing-authority-oauth-callback.service.ts" <<'TS'
verifySignedAuthorityState;
businessId: verified.state.businessId,
actorUserId: verified.state.userId,
TS
    cat > "$T/lib/services/billing/authority/billing-authority-signed-state.service.ts" <<'TS'
import { createHmac, timingSafeEqual } from "node:crypto";
const PURPOSE = "authority-oauth-state";
const KEY_DERIVATION_LABEL = "dubiz-authority-oauth-state-v1";
nonce; exp; environment;
reason: "wrong_purpose"
reason: "wrong_environment"
reason: "expired"
reason: "wrong_version"
TS
    cat > "$T/lib/services/integrations/gmail/signed-state.service.ts" <<'TS'
const PURPOSE = "gmail-oauth-state";
const KEY_DERIVATION_LABEL = "dubiz-gmail-oauth-state-v1";
TS
    cat > "$T/lib/services/billing/authority/billing-authority-connection.service.ts" <<'TS'
import { billingTenantTx } from "../billing-tenant-tx";
return billingTenantTx(input.businessId, (tx) => markAuthorityConnectedTx(tx, input));
TS
    cat > "$T/prisma/migrations/20260830120000_d2_p7_w4ea_payments_tenant_rls/migration.sql" <<'SQL'
CREATE TABLE IF NOT EXISTS "PaymentProviderRouting" (
  "id" SERIAL PRIMARY KEY,
  "provider" "PaymentProvider" NOT NULL,
  "providerRequestId" TEXT NOT NULL,
  "paymentRequestId" INTEGER NOT NULL,
  "businessId" INTEGER NOT NULL
);
x "PaymentTransaction"."paymentRequestId" x
SQL
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

  local T7="$BASE/v7"; make_clean_tree "$T7"
  printf 'ALTER TABLE "WhatsAppConnection" ENABLE ROW LEVEL SECURITY;\n' >> "$T7/prisma/migrations/m1/migration.sql"
  check "CI-W4B-1 catches RLS on WhatsAppConnection" FAIL "$T7"

  local T8="$BASE/v8"; make_clean_tree "$T8"
  printf 'model Message {\n}\n' > "$T8/prisma/schema.prisma"
  check "CI-W4B-2 catches lost Message unique" FAIL "$T8"

  local T9="$BASE/v9"; make_clean_tree "$T9"
  printf 'await prisma.replySuggestion.create({});\n' >> "$T9/lib/services/conversation/inbound-message-pipeline.service.ts"
  check "CI-W4B-3 catches global-client W4B write" FAIL "$T9"

  local T10="$BASE/v10"; make_clean_tree "$T10"
  printf '// no verified state\n' > "$T10/app/api/integrations/gmail/callback/route.ts"
  check "CI-W4C-1 catches lost verified-state authority" FAIL "$T10"

  local T11="$BASE/v11"; make_clean_tree "$T11"
  printf '%s\n' '-- no policies' > "$T11/prisma/migrations/20260826200000_d2_p7_w4c_gmail_tenant_rls/migration.sql"
  check "CI-W4C-2 catches lost EmailConnection/OAuthToken policy" FAIL "$T11"

  local T12="$BASE/v12"; make_clean_tree "$T12"
  printf 'await prisma.oAuthToken.update({});\n' >> "$T12/lib/services/integrations/gmail/gmail-auth.service.ts"
  check "CI-W4C-3 catches global-client W4C write" FAIL "$T12"

  local T13="$BASE/v13"; make_clean_tree "$T13"
  printf 'no tx here\n' > "$T13/app/api/documents/[id]/approve/route.ts"
  check "CI-W4D-1 catches approve without tenant tx" FAIL "$T13"

  local T14="$BASE/v14"; make_clean_tree "$T14"
  printf 'import { prisma } from "@/lib/prisma";\n' > "$T14/lib/services/learning-center/learning-center-data.ts"
  check "CI-W4D-2 catches learning-center on tenant client" FAIL "$T14"

  local T15="$BASE/v15"; make_clean_tree "$T15"
  printf 'dead\n' > "$T15/lib/services/documents/vendor-learning.service.ts" 2>/dev/null || mkdir -p "$T15/lib/services/documents" && printf 'dead\n' > "$T15/lib/services/documents/vendor-learning.service.ts"
  check "CI-W4D-3 catches resurrected dead code" FAIL "$T15"

  local T16="$BASE/v16"; make_clean_tree "$T16"
  printf '%s\n' '-- empty' > "$T16/prisma/migrations/20260827090000_d2_p7_w4d_documents_tenant_rls/migration.sql"
  check "CI-W4D-4 catches lost parent-join shapes" FAIL "$T16"

  local T17="$BASE/v17"; make_clean_tree "$T17"
  printf 'await prisma.financialRecord.create({});\nwithTenantTransaction\n' > "$T17/app/api/documents/[id]/approve/route.ts"
  check "CI-W4D-5 catches global-client W4D write" FAIL "$T17"

  local T18="$BASE/v18"; make_clean_tree "$T18"
  cat >> "$T18/lib/services/payments/payment-webhook.service.ts" <<'TS'
const businessId = parsed.businessId;
TS
  check "CI-W4E-1 catches payload tenant authority" FAIL "$T18"

  local T19="$BASE/v19"; make_clean_tree "$T19"
  cat >> "$T19/lib/services/payments/payment-store.prisma.ts" <<'TS'
const row = await prisma.paymentTransaction.findFirst({});
TS
  check "CI-W4E-2 catches global client in the payments store" FAIL "$T19"

  local T20="$BASE/v20"; make_clean_tree "$T20"
  cat >> "$T20/lib/services/payments/payment-store.prisma.ts" <<'TS'
const x = await bootstrapStep((db) => db.customer.findMany({}));
TS
  check "CI-W4E-3 catches bootstrapStep leaving its allowlist" FAIL "$T20"

  local T21="$BASE/v21"; make_clean_tree "$T21"
  cat >> "$T21/lib/services/payments/payment-store.prisma.ts" <<'TS'
const x = await bootstrapStep((db) => db.financialEvent.create({}));
TS
  check "CI-W4E-4 catches bootstrapStep reaching a protected table" FAIL "$T21"

  local T22="$BASE/v22"; make_clean_tree "$T22"
  cat >> "$T22/prisma/migrations/20260830120000_d2_p7_w4ea_payments_tenant_rls/migration.sql" <<'SQL'
ALTER TABLE "PaymentProviderRouting" ENABLE ROW LEVEL SECURITY;
SQL
  check "CI-W4E-5 catches RLS silently added to the routing table" FAIL "$T22"

  local T23="$BASE/v23"; make_clean_tree "$T23"
  cat > "$T23/prisma/migrations/20260830120000_d2_p7_w4ea_payments_tenant_rls/migration.sql" <<'SQL'
CREATE TABLE IF NOT EXISTS "PaymentProviderRouting" (
  "id" SERIAL PRIMARY KEY,
  "amount" DECIMAL(18,2) NOT NULL
);
x "PaymentTransaction"."paymentRequestId" x
SQL
  check "CI-W4E-6 catches the routing table gaining business data" FAIL "$T23"

  local T24="$BASE/v24"; make_clean_tree "$T24"
  printf 'x\n' > "$T24/prisma/migrations/20260830120000_d2_p7_w4ea_payments_tenant_rls/migration.sql"
  check "CI-W4E-7 catches a lost PaymentTransaction parent-join" FAIL "$T24"

  local T25="$BASE/v25"; make_clean_tree "$T25"
  cat >> "$T25/lib/services/payments/payment-request.service.ts" <<'TS'
await withTenantTransaction(async (tx) => {
  await adapter.getPaymentStatus({});
);
TS
  check "CI-W4E-8 catches a provider call inside a tenant transaction" FAIL "$T25"

  local T26="$BASE/v26"; make_clean_tree "$T26"
  cat > "$T26/lib/services/payments/payments.deps.ts" <<'TS'
await prisma.$transaction((tx) => ensurePaymentPostedEvent(tx, {}));
withTenantTransaction;
TS
  check "CI-W4E-9 catches FinancialEvent on a global transaction" FAIL "$T26"

  local T27="$BASE/v27"; make_clean_tree "$T27"
  cat > "$T27/lib/services/payments/payment-store.prisma.ts" <<'TS'
const route = await bootstrapStep((db) => db.paymentProviderRouting.findUnique({}));
const row = await dbStep((db) => db.paymentRequest.findFirst({ where: { id: route.paymentRequestId } }));
TS
  check "CI-W4E-10 catches routing businessId not verified against the parent" FAIL "$T27"

  local T28="$BASE/v28"; make_clean_tree "$T28"
  cat > "$T28/lib/services/billing/authority/billing-authority-oauth-callback.service.ts" <<'TS'
verifySignedAuthorityState;
actorUserId: verified.state.userId,
      businessId: parsedCookies.businessId,
TS
  check "CI-W4EB1-1 catches a cookie-built tenant context" FAIL "$T28"

  local T29="$BASE/v29"; make_clean_tree "$T29"
  cat > "$T29/lib/services/billing/authority/billing-authority-oauth-callback.service.ts" <<'TS'
businessId: verified.state.businessId,
actorUserId: verified.state.userId,
TS
  check "CI-W4EB1-2 catches a callback that stops verifying the state" FAIL "$T29"

  local T30="$BASE/v30"; make_clean_tree "$T30"
  cat > "$T30/lib/services/billing/authority/billing-authority-signed-state.service.ts" <<'TS'
import { createHmac, timingSafeEqual } from "node:crypto";
const PURPOSE = "authority-oauth-state";
const KEY_DERIVATION_LABEL = "dubiz-authority-oauth-state-v1";
nonce; exp; environment;
reason: "wrong_purpose"
reason: "expired"
reason: "wrong_version"
TS
  check "CI-W4EB1-3 catches removed environment validation" FAIL "$T30"

  local T31="$BASE/v31"; make_clean_tree "$T31"
  cat > "$T31/lib/services/integrations/gmail/signed-state.service.ts" <<'TS'
const PURPOSE = "authority-oauth-state";
const KEY_DERIVATION_LABEL = "dubiz-authority-oauth-state-v1";
TS
  check "CI-W4EB1-4 catches Gmail/Authority envelope collapse" FAIL "$T31"

  local T32="$BASE/v32"; make_clean_tree "$T32"
  cat > "$T32/lib/services/billing/authority/billing-authority-connection.service.ts" <<'TS'
import { billingTenantTx } from "../billing-tenant-tx";
return prisma.$transaction((tx) => markAuthorityConnectedTx(tx, input));
TS
  check "CI-W4EB1-5 catches an authority write reverting to a global transaction" FAIL "$T32"

  echo "self-test: ok=$ok bad=$bad"
  [ "$bad" -eq 0 ]
}

if [ "${1:-}" = "--self-test" ]; then
  self_test
else
  run_guard "${1:-.}"
fi
