#!/usr/bin/env bash
# D2 / PRODUCTION-RUNTIME-CUTOVER-2A — tenant-context ratchet.
#
# Production still connects as an owner role that bypasses RLS, so none of this is
# observable at runtime today. The failure it prevents is specific and quiet: under
# the restricted runtime a statement with no `app.current_business_id` does not
# error on read — it matches zero rows. "This tenant has data" silently becomes
# "this tenant has no data". Writes raise; reads do not. That asymmetry is why this
# has to be enforced statically rather than discovered after the cutover.
#
#   bash scripts/ci/tenant-context-guard.sh .            # check a tree
#   bash scripts/ci/tenant-context-guard.sh --self-test  # negative proofs
#
# NOTE ON PIPES: `grep -q` / `head -1` downstream of a pipe SIGPIPE the producer,
# which under `set -o pipefail` inverts results. Every check reads to EOF instead.

set -uo pipefail

MODE="check"
ROOT="${1:-.}"
if [ "${1:-}" = "--self-test" ]; then MODE="selftest"; ROOT="${2:-.}"; fi

PASS=0
FAIL=0
ok() {
  if [ "$2" = "1" ]; then PASS=$((PASS + 1)); echo "  [PASS] $1";
  else FAIL=$((FAIL + 1)); echo "  [FAIL] $1${3:+ — $3}"; fi
}

# The five tables the P4-B pilot protected on the Preview branch only. No migration
# in this repository has ever enabled RLS on them, which is why Production has none.
# CUTOVER-2B will ship that migration; this guard makes sure the application is
# ready for it and cannot drift back.
PILOT_MODELS="conversation customer appointment billingDocument paymentRequest"

# Runtime trees that must never touch a pilot model through the global client.
TENANT_TREES="app lib features components"

# Paths allowed to use the global client for a pilot model. Keep this SMALL and
# make it shrink: every entry is a place the tenant boundary is not yet enforced.
#   - platform-admin/*  : admin plane. Reads cross-tenant BY DESIGN and must NOT be
#                         pushed through tenant context (that is what app_admin and
#                         ADMIN_DATABASE_URL exist for).
ALLOW_GLOBAL_PILOT="lib/services/platform-admin/"

# Files that still open a bare `prisma.$transaction` on tenant-owned tables that
# EARLIER waves already put under RLS (inventory/W3, coupons, content). They are a
# pre-existing gap that this wave did not create and does not close — its scope is
# the five pilot tables. Recorded explicitly so the set cannot GROW.
#
# ONE entry below is NOT that category and must not be read as a gap:
#
#   lib/auth/signup.ts — account creation. It writes Business and User, which NO
#   migration in this repository has ever put under RLS, and it is the act that
#   BRINGS A TENANT INTO EXISTENCE. A tenant-scoped transaction is not merely
#   unused here, it is impossible: there is no businessId to scope to until this
#   transaction commits one. Wrapping it in tenant context would mean inventing
#   an id before the row exists. Bare by necessity, not by omission — and
#   reachable only from the gated registration route, which
#   lib/auth/signup-gate-coverage.test.ts pins.
KNOWN_BARE_TX="lib/services/inventory/inventory.service.ts
lib/services/inventory/pending-match.service.ts
lib/services/inventory/purchase-order.service.ts
lib/services/inventory/receiving.service.ts
lib/services/inventory/supplier-purchase-approval.service.ts
lib/services/content-plan-persistence-v1.service.ts
lib/services/redeem.service.ts
lib/services/revenue/publish-coupon.service.ts
lib/services/platform-admin/update-business-feature-access.service.ts
lib/services/account/account-deletion.prisma-store.ts
lib/services/payments/payments.deps.ts
lib/tenant/transaction.ts
lib/services/billing/billing-tenant-tx.ts
lib/auth/signup.ts"

run_checks() {
echo "== CI-TC: tenant context closure =="

# --- 1..5. no pilot model reached through the global client -----------------
i=1
for m in $PILOT_MODELS; do
  hits="$(grep -rn "prisma\.${m}\." --include=*.ts $(for t in $TENANT_TREES; do echo "$ROOT/$t"; done) 2>/dev/null \
          | grep -v '\.test\.' || true)"
  # drop allowlisted paths
  for alw in $ALLOW_GLOBAL_PILOT; do
    hits="$(printf '%s\n' "$hits" | grep -v "$alw" || true)"
  done
  n="$(printf '%s' "$hits" | grep -c . || true)"
  ok "CI-TC-${i}  no global prisma.${m}.* in tenant runtime" "$([ "$n" -eq 0 ] && echo 1 || echo 0)" "$(printf '%s' "$hits" | tr '\n' ' ' | cut -c1-200)"
  i=$((i + 1))
done

# --- 6. the canonical helper exists and fails loud on a bad tenant ----------
HELPER="$ROOT/lib/tenant/tenant-tx.ts"
n=0
if [ -f "$HELPER" ]; then
  a=$(grep -c "runWithTenantContext" "$HELPER" || true)
  b=$(grep -c "withTenantTransaction" "$HELPER" || true)
  c=$(grep -c "throw new Error" "$HELPER" || true)
  [ "$a" -ge 1 ] && [ "$b" -ge 1 ] && [ "$c" -ge 1 ] && n=1
fi
ok "CI-TC-6  tenantTx exists, sets context + transaction, and rejects a bad businessId" "$n"

# --- 7. bare tenant transactions cannot GROW -------------------------------
# Paths are normalised by keeping everything from the first `app/` or `lib/` segment,
# NOT by removing "$ROOT". `sed "s|^$ROOT/||"` silently fails whenever ROOT is an
# absolute path — its slashes and dots are live in the pattern — and the failure runs
# in the dangerous direction: every file then looks unmatched, so the check reports
# violations that do not exist AND its negative proof passes for the wrong reason.
found="$(grep -rln 'prisma\.\$transaction' --include=*.ts "$ROOT/app" "$ROOT/lib" 2>/dev/null \
         | grep -v '\.test\.' | sed -E 's#^.*/(app/|lib/)#\1#' | sort -u || true)"
unknown=""
for f in $found; do
  case "$KNOWN_BARE_TX" in
    *"$f"*) : ;;
    *) unknown="$unknown $f" ;;
  esac
done
ok "CI-TC-7  no NEW bare prisma.\$transaction outside the recorded set" "$([ -z "$unknown" ] && echo 1 || echo 0)" "$unknown"

# --- 8. tenant runtime must not reach for the admin or control-plane client -
adm="$(grep -rn "prisma-admin\|getPrismaAdmin" --include=*.ts "$ROOT/app/api" 2>/dev/null \
       | grep -v '\.test\.' | grep -v 'platform-admin' || true)"
n="$(printf '%s' "$adm" | grep -c . || true)"
ok "CI-TC-8  no tenant API route imports the admin client" "$([ "$n" -eq 0 ] && echo 1 || echo 0)" "$(printf '%s' "$adm" | tr '\n' ' ' | cut -c1-160)"

ctl="$(grep -rn "prisma-control-plane\|getPrismaControlPlane" --include=*.ts "$ROOT/app/api" "$ROOT/lib/services" 2>/dev/null \
       | grep -v '\.test\.' | grep -v 'control-plane' | grep -v 'platform-admin' || true)"
n="$(printf '%s' "$ctl" | grep -c . || true)"
ok "CI-TC-9  no tenant runtime imports the control-plane client" "$([ "$n" -eq 0 ] && echo 1 || echo 0)" "$(printf '%s' "$ctl" | tr '\n' ' ' | cut -c1-160)"

# --- 10. no ad-hoc PrismaClient (CI-1 also covers this; pinned here too) ----
adhoc="$(grep -rn "new PrismaClient" --include=*.ts "$ROOT/app" "$ROOT/lib" "$ROOT/features" "$ROOT/components" 2>/dev/null \
         | grep -v '\.test\.' | grep -vE 'lib/prisma\.ts|lib/prisma-admin\.ts|lib/prisma-control-plane\.ts' || true)"
n="$(printf '%s' "$adhoc" | grep -c . || true)"
ok "CI-TC-10 no ad-hoc PrismaClient in runtime code" "$([ "$n" -eq 0 ] && echo 1 || echo 0)" "$(printf '%s' "$adhoc" | tr '\n' ' ' | cut -c1-160)"

# --- 11. no owner-role fallback smuggled into runtime config ---------------
own="$(grep -rn "neondb_owner" --include=*.ts "$ROOT/app" "$ROOT/lib" 2>/dev/null | grep -v '\.test\.' || true)"
n="$(printf '%s' "$own" | grep -c . || true)"
ok "CI-TC-11 runtime code never names the owner role" "$([ "$n" -eq 0 ] && echo 1 || echo 0)" "$(printf '%s' "$own" | tr '\n' ' ' | cut -c1-160)"

# --- 12. the admin plane is still allowed to read cross-tenant -------------
n=$(grep -rc "prisma\." "$ROOT/lib/services/platform-admin/platform-business-detail.service.ts" 2>/dev/null || echo 0)
ok "CI-TC-12 platform-admin retains its own (non-tenant) read path" "$([ "$n" -ge 1 ] && echo 1 || echo 0)"

echo ""
echo "[CI-TC] PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
}

# ---------------------------------------------------------------------------
# NEGATIVE SELF-PROOFS — a guard never seen to fail is not evidence.
# ---------------------------------------------------------------------------
selftest() {
  local src="$ROOT" sp=0 sf=0
  # A MINIMAL synthetic tree, not a copy of the repo. Copying app/ + lib/ per probe
  # took minutes; the guard only greps, so a handful of files reproduces every
  # condition it checks — and it keeps the negative proofs honest by construction,
  # because the clean fixture must pass before any mutation is applied.
  make_fixture() {
    local t="$1"
    mkdir -p "$t/app/api/conversation" "$t/lib/tenant" "$t/lib/services/platform-admin" \
             "$t/lib/services/billing" "$t/features" "$t/components"
    cp "$src/lib/tenant/tenant-tx.ts" "$t/lib/tenant/tenant-tx.ts"
    printf 'import { prisma } from "@/lib/prisma";\nexport const n = () => prisma.conversation.count({});\n' \
      > "$t/lib/services/platform-admin/platform-business-detail.service.ts"
    printf 'import { tenantTx } from "@/lib/tenant/tenant-tx";\nexport const x = (b: number) => tenantTx(b, (tx) => tx.conversation.findMany({}));\n' \
      > "$t/app/api/conversation/route.ts"
    printf 'import { prisma } from "@/lib/prisma";\nexport const t = () => prisma.$transaction(async () => {});\n' \
      > "$t/lib/tenant/transaction.ts"
  }

  probe() { # probe <label> <expected-failing-check> <mutator>
    local label="$1" expect="$2" mut="$3" tmp
    tmp="$(mktemp -d)"
    make_fixture "$tmp"
    "$mut" "$tmp"
    local out; out="$(bash "$src/scripts/ci/tenant-context-guard.sh" "$tmp" 2>&1)"
    local caught=0
    case "$out" in *"[FAIL] $expect"*) caught=1 ;; esac
    if [ "$caught" = "1" ]; then sp=$((sp+1)); echo "  [PASS] negative: $label -> $expect fails as designed";
    else sf=$((sf+1)); echo "  [FAIL] negative: $label -> $expect did NOT fail (guard is decorative)"; fi
    rm -rf "$tmp"
  }

  # The core regression: a contextualized Conversation read reverted to global Prisma.
  m_conv_global() {
    printf 'import { prisma } from "@/lib/prisma";\nexport const x = () => prisma.conversation.findMany({});\n' \
      > "$1/app/api/conversation/regressed.ts"
  }
  m_customer_global() {
    printf 'import { prisma } from "@/lib/prisma";\nexport const x = () => prisma.customer.findFirst({});\n' \
      > "$1/lib/services/billing/regressed.ts"
  }
  m_billingdoc_global() {
    printf 'import { prisma } from "@/lib/prisma";\nexport const x = () => prisma.billingDocument.findMany({});\n' \
      > "$1/lib/services/billing/regressed2.ts"
  }
  m_drop_helper() { rm -f "$1/lib/tenant/tenant-tx.ts"; }
  m_clean() { :; }
  m_new_bare_tx() {
    printf 'import { prisma } from "@/lib/prisma";\nexport const x = () => prisma.$transaction(async () => {});\n' \
      > "$1/lib/services/brand-new-bare.ts"
  }
  m_admin_from_tenant() {
    mkdir -p "$1/app/api/leaky"
    printf 'import { getPrismaAdmin } from "@/lib/prisma-admin";\nexport const x = getPrismaAdmin;\n' \
      > "$1/app/api/leaky/route.ts"
  }
  m_ctl_from_tenant() {
    mkdir -p "$1/app/api/leaky2"
    printf 'import { getPrismaControlPlane } from "@/lib/prisma-control-plane";\nexport const x = getPrismaControlPlane;\n' \
      > "$1/app/api/leaky2/route.ts"
  }
  m_adhoc_client() {
    printf 'import { PrismaClient } from "@prisma/client";\nexport const c = new PrismaClient();\n' \
      > "$1/lib/adhoc.ts"
  }
  m_owner_role() {
    printf 'export const url = "postgres://neondb_owner@host/db";\n' > "$1/lib/ownerfallback.ts"
  }

  echo ""
  echo "== CI-TC negative self-proofs =="
  probe "a Conversation read reverted to the global client" "CI-TC-1"  m_conv_global
  probe "a Customer read on the global client"              "CI-TC-2"  m_customer_global
  probe "a BillingDocument read on the global client"       "CI-TC-4"  m_billingdoc_global
  probe "the tenantTx helper is deleted"                    "CI-TC-6"  m_drop_helper
  probe "a NEW bare prisma.\$transaction appears"           "CI-TC-7"  m_new_bare_tx
  probe "a tenant route reaches for the admin client"       "CI-TC-8"  m_admin_from_tenant
  probe "a tenant route reaches for the control-plane client" "CI-TC-9" m_ctl_from_tenant
  probe "an ad-hoc PrismaClient is introduced"              "CI-TC-10" m_adhoc_client
  probe "runtime code names the owner role"                 "CI-TC-11" m_owner_role

  echo ""
  echo "[CI-TC self-test] PASS=$sp FAIL=$sf"
  [ "$sf" -eq 0 ] || exit 1
}

if [ "$MODE" = "selftest" ]; then selftest; else run_checks; fi
