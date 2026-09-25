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

# M0 — the KNOWLEDGE models.
#
# Every table below is under FORCE RLS with a policy keyed on `app.current_business_id`, and each one
# either stores derived knowledge or IS the canonical evidence knowledge is derived from. They are
# tracked separately from PILOT_MODELS because the failure they produce is worse than an empty list: a
# knowledge engine that reads no evidence does not error — it concludes "this business has no history"
# and then stays silent forever, or, if it ever aggregated across the table, builds a baseline out of
# other businesses' data.
#
# This is not hypothetical. The Business Memory read and write paths both ran on the global client from
# the day they merged. Twenty-one production comparisons reported `absent` and nothing ever failed,
# because a context-less read under RLS is indistinguishable from "nothing learned yet". CI-TC-1..5
# could not see it: DerivedClaim* was not a pilot model.
#
# A new learning artifact MUST be added here on the day its table receives an RLS policy.
#
# M4/M5 added the last seven — and two of them, knowledgeMeasure and businessInsight, shipped in M2/M3
# WITHOUT being listed. That omission is the original defect's exact shape repeating: the tables were
# FORCE RLS from their first migration and nothing checked that the code reached them through a tenant
# transaction. They did, as it happens. Nothing was proving it.
KNOWLEDGE_MODELS="derivedClaimProjection derivedClaimCandidate derivedClaimEvidenceLink reviewEvent extractionSnapshot extractionEvidence sliceDecision vendorLearning learningEvent knowledgeMeasure knowledgeMeasureEvidenceLink temporalKnowledge businessInsight entityLinkProposal collectionAction party partyResolutionClaim"

# Runtime trees that must never touch a pilot model through the global client.
TENANT_TREES="app lib features components"

# Paths allowed to use the global client for a pilot model. Keep this SMALL and
# make it shrink: every entry is a place the tenant boundary is not yet enforced.
#   - platform-admin/*  : admin plane. Reads cross-tenant BY DESIGN and must NOT be
#                         pushed through tenant context (that is what app_admin and
#                         ADMIN_DATABASE_URL exist for).
ALLOW_GLOBAL_PILOT="lib/services/platform-admin/"

# CLASSIFIED bare-transaction register.
#
# CUTOVER-3A repaired every TENANT-SENSITIVE entry, so this list no longer contains a
# single "legacy exception". Each remaining line must carry one of four
# classifications, and the guard REFUSES an entry without one — a file cannot be
# parked here just because it predates a wave.
#
#   BOOTSTRAP        runs before a tenant exists, so no tenant GUC is possible
#   ADMIN            deliberate privileged/erasure boundary, not normal runtime
#   CONTROL_PLANE    control-plane capability with its own credential and guard
#   GLOBAL_NON_TENANT touches no table under tenant RLS, or is inherently multi-tenant
#   CANONICAL        the tenant-transaction substrate itself
#
# Format: "<path>|<CLASSIFICATION>". Anything else fails CI-TC-7b.
KNOWN_BARE_TX_CLASSIFIED="lib/auth/signup.ts|BOOTSTRAP
lib/services/account/account-deletion.prisma-store.ts|ADMIN
lib/services/platform-admin/update-business-feature-access.service.ts|CONTROL_PLANE
lib/services/redeem.service.ts|GLOBAL_NON_TENANT
lib/services/revenue/publish-coupon.service.ts|GLOBAL_NON_TENANT
lib/services/payments/payments.deps.ts|CANONICAL
lib/services/billing/billing-tenant-tx.ts|CANONICAL
lib/services/inventory/supplier-purchase-approval.service.ts|CANONICAL
lib/tenant/transaction.ts|CANONICAL"

# Why each non-obvious one is what it claims to be:
#
#   lib/auth/signup.ts — BOOTSTRAP. It writes Business and User, neither of which any
#   migration has ever put under RLS, and it is the act that BRINGS A TENANT INTO
#   EXISTENCE. A tenant-scoped transaction is not merely unused here, it is
#   impossible: there is no businessId to scope to until this transaction commits
#   one. Reachable only from the gated registration route.
#
#   account-deletion.prisma-store.ts — ADMIN. The erasure boundary, designed in AD-2A:
#   quarantine commits BEFORE the destructive purge, and the purge itself already runs
#   through runTenantJob + withTenantTransaction. The bare outer transactions are the
#   lifecycle transitions, which act ON a quarantined tenant.
#
#   redeem.service.ts / publish-coupon.service.ts — GLOBAL_NON_TENANT. Coupon carries
#   `issuingBusinessId` and RedemptionEvent carries BOTH `issuingBusinessId` and
#   `redeemingBusinessId`: a redemption is inherently a TWO-tenant row (A issues, B
#   redeems). Neither table is under RLS, and a single-tenant `businessId = GUC`
#   predicate cannot express that ownership without being wrong. Marketplace policy is
#   its own separate wave — forcing tenant context here would be a bug, not a fix.
#
#   payments.deps.ts / billing-tenant-tx.ts / supplier-purchase-approval.service.ts —
#   CANONICAL. These match only in a COMMENT or a TYPE position, not in a real
#   transaction; they are listed so the textual guard stays honest about them.
#
# Derived plain list, for the membership check.
KNOWN_BARE_TX="$(printf '%s
' "$KNOWN_BARE_TX_CLASSIFIED" | sed 's/|.*//')"

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

# --- 7b. every register entry must carry a real classification -------------
# The point of CUTOVER-3A was to end "legacy exception" as a category. An entry
# without one of the four classifications is exactly the shape that let inventory
# and content-plan sit unrepaired for two waves, so it fails rather than parks.
VALID_CLASS="BOOTSTRAP ADMIN CONTROL_PLANE GLOBAL_NON_TENANT CANONICAL"
unclassified=""
while IFS= read -r entry; do
  [ -z "$entry" ] && continue
  path="${entry%%|*}"
  class="${entry##*|}"
  hit=0
  for c in $VALID_CLASS; do [ "$class" = "$c" ] && hit=1; done
  [ "$hit" -eq 1 ] || unclassified="$unclassified $path"
done <<< "$KNOWN_BARE_TX_CLASSIFIED"
ok "CI-TC-7b every bare-transaction register entry carries a valid classification" \
   "$([ -z "$unclassified" ] && echo 1 || echo 0)" "$unclassified"

# --- 7c. no tenant-sensitive entry may claim a non-tenant classification ---
# A file that touches an RLS-protected tenant table cannot be GLOBAL_NON_TENANT.
# This is the check that would have caught the inventory debt on the day it was
# parked: those files touch InventoryItem/PurchaseOrder/ContentRun, all FORCE-RLS'd.
mislabelled=""
while IFS= read -r entry; do
  [ -z "$entry" ] && continue
  path="${entry%%|*}"
  class="${entry##*|}"
  [ "$class" = "GLOBAL_NON_TENANT" ] || continue
  [ -f "$ROOT/$path" ] || continue
  # models the file writes through a transaction client
  models="$(grep -oE '\b(tx|db)\.[a-zA-Z]+\.' "$ROOT/$path" 2>/dev/null | sed 's/.*\.\([a-zA-Z]*\)\.$/\1/' | sort -u || true)"
  for m in $models; do
    Tbl="$(printf '%s' "$m" | sed 's/^./\U&/')"
    if grep -rqlE "ALTER TABLE \"$Tbl\" ENABLE ROW LEVEL SECURITY" "$ROOT/prisma/migrations" 2>/dev/null; then
      mislabelled="$mislabelled $path:$Tbl"
    fi
  done
done <<< "$KNOWN_BARE_TX_CLASSIFIED"
ok "CI-TC-7c no GLOBAL_NON_TENANT entry actually touches an RLS-protected table" \
   "$([ -z "$mislabelled" ] && echo 1 || echo 0)" "$mislabelled"

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
# The sanctioned-client register. `lib/prisma-auth.ts` joined it in
# D2/AUTH-BOUNDARY-STEP-2: auth and bootstrap connect as their own identity so
# that tenant traffic can lose User/Business access. Its import surface is
# enforced separately by admin-boundary-guard CI-2a/2b/2c.
adhoc="$(grep -rn "new PrismaClient" --include=*.ts "$ROOT/app" "$ROOT/lib" "$ROOT/features" "$ROOT/components" 2>/dev/null \
         | grep -v '\.test\.' | grep -vE 'lib/prisma\.ts|lib/prisma-admin\.ts|lib/prisma-control-plane\.ts|lib/prisma-auth\.ts' || true)"
n="$(printf '%s' "$adhoc" | grep -c . || true)"
ok "CI-TC-10 no ad-hoc PrismaClient in runtime code" "$([ "$n" -eq 0 ] && echo 1 || echo 0)" "$(printf '%s' "$adhoc" | tr '\n' ' ' | cut -c1-160)"

# --- 11. no owner-role fallback smuggled into runtime config ---------------
own="$(grep -rn "neondb_owner" --include=*.ts "$ROOT/app" "$ROOT/lib" 2>/dev/null | grep -v '\.test\.' || true)"
n="$(printf '%s' "$own" | grep -c . || true)"
ok "CI-TC-11 runtime code never names the owner role" "$([ "$n" -eq 0 ] && echo 1 || echo 0)" "$(printf '%s' "$own" | tr '\n' ' ' | cut -c1-160)"

# --- 12. the admin plane is still allowed to read cross-tenant -------------
n=$(grep -rc "prisma\." "$ROOT/lib/services/platform-admin/platform-business-detail.service.ts" 2>/dev/null || echo 0)
ok "CI-TC-12 platform-admin retains its own (non-tenant) read path" "$([ "$n" -ge 1 ] && echo 1 || echo 0)"

# --- 13. KNOWLEDGE tables are never reached through the global client ------
# The check CI-TC-1..5 could not perform, because these were never pilot models. The Learning Center
# is exempt: it is the platform-admin analytics surface and reads cross-tenant BY DESIGN through
# `adminDb()`, which is a different credential (app_admin, SELECT-only additive policies), not the
# tenant runtime client this guard is about.
KNOWLEDGE_ALLOW="lib/services/platform-admin/ lib/services/learning-center/"
kn_hits=""
for m in $KNOWLEDGE_MODELS; do
  h="$(grep -rn "prisma\.${m}\." --include=*.ts $(for t in $TENANT_TREES; do echo "$ROOT/$t"; done) 2>/dev/null \
       | grep -v '\.test\.' || true)"
  for alw in $KNOWLEDGE_ALLOW; do
    h="$(printf '%s\n' "$h" | grep -v "$alw" || true)"
  done
  [ -n "$(printf '%s' "$h" | grep -c . | grep -v '^0$')" ] && kn_hits="$kn_hits $(printf '%s' "$h" | tr '\n' ' ')"
done
kn_hits="$(printf '%s' "$kn_hits" | sed 's/^ *//')"
ok "CI-TC-13 no KNOWLEDGE model reached through the global prisma client" \
   "$([ -z "$kn_hits" ] && echo 1 || echo 0)" "$(printf '%s' "$kn_hits" | cut -c1-240)"

# --- 14. the Business Memory DB seams are tenant-bound by construction -----
# Named seams rather than a blanket text scan: these three are the only places Business Memory touches
# a tenant table, and each must reach it through the tenant primitives. If a future refactor moves the
# binding, this fails instead of silently returning to a context-less read.
co="$ROOT/lib/business-memory/read/coordinator.ts"
cw="$ROOT/lib/business-memory/materialization/claim-writer.ts"
rs="$ROOT/lib/business-memory/shadow/run-shadow.ts"
n=0
if [ -f "$co" ] && [ -f "$cw" ] && [ -f "$rs" ]; then
  a=$(grep -c "tenantTx(query.businessId" "$co" || true)          # Claim read
  b=$(grep -c "runWithTenantContext" "$co" || true)               # evidence freshness read
  c=$(grep -c "tenantTx(businessId" "$cw" || true)                # Claim write
  d=$(grep -c "runWithTenantContext" "$rs" || true)               # whole shadow orchestration
  e=$(grep -c 'from "@/lib/prisma"' "$co" "$cw" | grep -c ':[1-9]' || true)  # neither binds the singleton
  [ "$a" -ge 1 ] && [ "$b" -ge 1 ] && [ "$c" -ge 1 ] && [ "$d" -ge 1 ] && [ "$e" -eq 0 ] && n=1
fi
ok "CI-TC-14 Business Memory read/write/shadow seams are tenant-bound, not global-client" "$n"

# --- 15. the M4/M5 seams are tenant-bound by construction --------------------
# Same idea as 14, for the layer built on top of it. `sources.ts` is the ONLY file in lib/knowledge
# that opens a query, so every rule in the catalogue inherits its tenancy from one place — which is
# only true for as long as that stays the case, hence the second half of this check.
sr="$ROOT/lib/knowledge/evidence/sources.ts"
mr="$ROOT/lib/knowledge/measure-reconciler.ts"
mw="$ROOT/lib/knowledge/measure-writer.ts"
id="$ROOT/lib/identity/entity-identity.service.ts"
ca="$ROOT/lib/services/collection/collection-action.service.ts"
n=0
if [ -f "$sr" ] && [ -f "$mr" ] && [ -f "$mw" ] && [ -f "$id" ] && [ -f "$ca" ]; then
  # every exported loader in sources.ts reaches the database through tenantTx, and none binds prisma
  loaders=$(grep -c "^export async function load" "$sr" || true)
  txs=$(grep -c "tenantTx(businessId" "$sr" || true)
  nosingleton=$(grep -c 'from "@/lib/prisma"' "$sr" "$mr" "$mw" "$id" "$ca" | grep -c ':[1-9]' || true)
  # no other file under lib/knowledge may open a query of its own
  # Four files may touch the database, and they are named: the evidence sources, the two writers, and
  # the M3 insight service (its own tenant seam, asserted separately below). Anything else opening a
  # query means the "one file to audit" property has quietly stopped being true.
  strays=$(grep -rln "tx\.\|prisma\." --include=*.ts "$ROOT/lib/knowledge" 2>/dev/null \
            | grep -v '/evidence/sources.ts$' | grep -v 'measure-writer.ts$' \
            | grep -v 'measure-reconciler.ts$' | grep -v 'insight.service.ts$' \
            | grep -v '/temporal/temporal-writer.ts$' | grep -v 'knowledge-selector.ts$' \
            | grep -v '\.test\.' | grep -c . || true)
  ins=$(grep -c "tenantTx(businessId" "$ROOT/lib/knowledge/insight.service.ts" || true)
  rec=$(grep -c "tenantTx(businessId" "$mr" || true)
  idn=$(grep -c "tenantTx(businessId" "$id" || true)
  can=$(grep -c "tenantTx(businessId" "$ca" || true)
  # M6 — the temporal writer and the M7-facing selector are the two further named seams.
  tw=$(grep -c "tenantTx(businessId" "$ROOT/lib/knowledge/temporal/temporal-writer.ts" 2>/dev/null || echo 0)
  ks=$(grep -c "tenantTx(businessId" "$ROOT/lib/knowledge/knowledge-selector.ts" 2>/dev/null || echo 0)
  [ "$loaders" -ge 7 ] && [ "$txs" -ge 7 ] && [ "$nosingleton" -eq 0 ] && [ "$strays" -eq 0 ] \
    && [ "$rec" -ge 1 ] && [ "$idn" -ge 1 ] && [ "$can" -ge 1 ] && [ "$ins" -ge 1 ] \
    && [ "$tw" -ge 1 ] && [ "$ks" -ge 1 ] && n=1
fi
ok "CI-TC-15 M4/M5 evidence, writer, reconciler, identity and collection seams are tenant-bound" "$n" \
   "loaders=${loaders:-?} tenantTx=${txs:-?} singleton=${nosingleton:-?} strays=${strays:-?}"

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
    # CI-TC-7c needs a file that genuinely touches an RLS-protected table, plus the
    # migration that protects it. Without both the check simply skips, and its
    # negative proof would then pass for the wrong reason.
    mkdir -p "$t/lib/services/inventory" "$t/prisma/migrations/9999_fixture"
    printf %s "export const x = (tx: any) => tx.inventoryItem.findMany({});" > "$t/lib/services/inventory/inventory.service.ts"
    printf %s 'ALTER TABLE "InventoryItem" ENABLE ROW LEVEL SECURITY;' > "$t/prisma/migrations/9999_fixture/migration.sql"
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

  # The two register checks read a constant inside THIS script, so their probes must
  # mutate a COPY of the guard rather than the fixture tree.
  probe_guard() { # probe_guard <label> <expected-check> <awk-mutator-fn>
    local label="$1" expect="$2" mut="$3" tmp
    tmp="$(mktemp -d)"
    make_fixture "$tmp"
    mkdir -p "$tmp/scripts/ci"
    "$mut" "$src/scripts/ci/tenant-context-guard.sh" > "$tmp/scripts/ci/guard.sh"
    local out; out="$(bash "$tmp/scripts/ci/guard.sh" "$tmp" 2>&1)"
    local caught=0
    case "$out" in *"[FAIL] $expect"*) caught=1 ;; esac
    if [ "$caught" = "1" ]; then sp=$((sp+1)); echo "  [PASS] negative: $label -> $expect fails as designed";
    else sf=$((sf+1)); echo "  [FAIL] negative: $label -> $expect did NOT fail (guard is decorative)"; fi
    rm -rf "$tmp"
  }

  # awk line-EQUALITY, so no path or '|' is ever treated as a regex.
  g_unclassified() {
    awk '{ if ($0 == "lib/tenant/transaction.ts|CANONICAL\"") { print "lib/tenant/transaction.ts|CANONICAL"; print "lib/services/some-new-thing.ts\""; } else print }' "$1"
  }
  g_mislabelled() {
    awk '{ if ($0 == "lib/services/redeem.service.ts|GLOBAL_NON_TENANT") print "lib/services/inventory/inventory.service.ts|GLOBAL_NON_TENANT"; else print }' "$1"
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

  # An entry parked in the register with no classification — the exact shape that let
  # inventory and content-plan sit unrepaired across two waves.
  probe_guard "a register entry is added with no classification" "CI-TC-7b" g_unclassified
  probe_guard "a tenant-sensitive file is mislabelled GLOBAL_NON_TENANT" "CI-TC-7c" g_mislabelled

  echo ""
  echo "[CI-TC self-test] PASS=$sp FAIL=$sf"
  [ "$sf" -eq 0 ] || exit 1
}

if [ "$MODE" = "selftest" ]; then selftest; else run_checks; fi
