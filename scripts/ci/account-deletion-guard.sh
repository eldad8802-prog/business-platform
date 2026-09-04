#!/usr/bin/env bash
# D2 / ACCOUNT-DELETION-2A — deletion lifecycle & erasure-execution invariants (CI-AD).
#
# The account-deletion flow failed in a way that guards are unusually good at
# preventing from coming back: it was CORRECT-LOOKING. Every statement carried
# `where: { businessId }`, the order read sensibly, and the API returned success —
# while under FORCE RLS every one of those statements would have matched zero rows.
# These guards pin the properties that make the difference.
#
#   CI-AD-1   the erasure purge runs under an explicit tenant context
#   CI-AD-2   the erasure purge proves the context before mutating (silent-zero)
#   CI-AD-3   quarantine commits BEFORE anything destructive
#   CI-AD-4   the erasure audit is atomic with the transition (never swallowed)
#   CI-AD-5   `quarantinePolicy: "erasure"` exists only in the account module
#   CI-AD-6   runTenantJob refuses normal work on a quarantined business by default
#   CI-AD-7   session auth gates on the whole quarantine, not just deletedAt
#   CI-AD-8   the payment webhook gates before entering the tenant
#   CI-AD-9   the settlement writes re-check inside their own transaction (TOCTOU)
#   CI-AD-10  the deletion route takes no businessId from the request
#   CI-AD-11  the integrity scanner is SELECT-only
#   CI-AD-12  AD-2A adds NO DELETE grant
#   CI-AD-13  no UNREGISTERED DELETE policy in any migration
#
# Not covered mechanically (documented, same limitation as CI-W4): "no external
# network call inside a tenant interactive transaction". A grep for fetch() inside a
# tx callback is defeated by one layer of helper indirection and would create false
# confidence; the erasure path is proven structurally in .ad2a/battery.mjs instead.
#
# Usage: account-deletion-guard.sh [repo-root] | account-deletion-guard.sh --self-test
set -euo pipefail

tscode() { sed -e 's://.*::' -e 's:^[[:space:]]*\*.*::' -e 's:^[[:space:]]*/\*.*::' "$1"; }

run_guard() {
  local ROOT="${1:-.}"
  cd "$ROOT"
  local fail=0

  local STORE="lib/services/account/account-deletion.prisma-store.ts"
  local SVC="lib/services/account/account-deletion.service.ts"
  local ROUTE="app/api/account/route.ts"
  local JOB="lib/tenant/job.ts"
  local AUTH="lib/auth.ts"
  local LIFECYCLE="lib/tenant/business-lifecycle.ts"
  local WEBHOOK="lib/services/payments/payment-webhook.service.ts"
  local PAYSTORE="lib/services/payments/payment-store.prisma.ts"
  local SCAN="scripts/security/conversation-integrity-scan.mjs"

  for f in "$STORE" "$SVC" "$ROUTE" "$JOB" "$AUTH" "$LIFECYCLE" "$WEBHOOK" "$PAYSTORE" "$SCAN"; do
    if [ ! -f "$f" ]; then
      echo "CI-AD FAIL: required artifact missing -> $f"
      fail=1
    fi
  done
  if [ "$fail" -ne 0 ]; then return 1; fi

  # ── 1: the purge runs under an explicit tenant context ───────────────────
  if ! tscode "$STORE" | grep "runTenantJob" >/dev/null 2>&1; then
    echo "CI-AD-1 FAIL: the erasure purge establishes no explicit tenant context"; fail=1
  fi
  if ! tscode "$STORE" | grep "withTenantTransaction" >/dev/null 2>&1; then
    echo "CI-AD-1 FAIL: the erasure purge does not run in a tenant transaction (RLS would zero it)"; fail=1
  fi

  # ── 2: silent-zero backstop ──────────────────────────────────────────────
  if ! tscode "$STORE" | grep "assertTenantContextIs" >/dev/null 2>&1; then
    echo "CI-AD-2 FAIL: the purge does not prove its tenant context before mutating"; fail=1
  fi
  if ! tscode "$STORE" | grep -E "assertExactlyOne|assertAtLeastOne" >/dev/null 2>&1; then
    echo "CI-AD-2 FAIL: the purge has no affected-row assertion"; fail=1
  fi

  # ── 3: quarantine first ──────────────────────────────────────────────────
  if ! tscode "$SVC" | grep "quarantineAndRevokeIntegrations" >/dev/null 2>&1; then
    echo "CI-AD-3 FAIL: the orchestrator has no quarantine stage"; fail=1
  fi
  local q_line p_line
  q_line="$(tscode "$SVC" | grep -n "store.quarantineAndRevokeIntegrations" | awk -F: 'NR==1{print $1}' || true)"
  p_line="$(tscode "$SVC" | grep -n "store.purgeOperationalData" | awk -F: 'NR==1{print $1}' || true)"
  if [ -n "$q_line" ] && [ -n "$p_line" ] && [ "$q_line" -ge "$p_line" ]; then
    echo "CI-AD-3 FAIL: destructive work is ordered before the quarantine"; fail=1
  fi

  # ── 4: audit atomic, never swallowed ─────────────────────────────────────
  if ! tscode "$STORE" | grep -E "logAuditEvent\(|createPlatformAuditEventTx\(" >/dev/null 2>&1; then
    echo "CI-AD-4 FAIL: the erasure writes no audit evidence"; fail=1
  fi
  if ! tscode "$STORE" | grep "{ tx }" >/dev/null 2>&1; then
    echo "CI-AD-4 FAIL: the erasure audit is not bound to the transition transaction (its failure would be swallowed)"; fail=1
  fi

  # ── 5: the quarantine escape hatch is confined to the account module ─────
  local ci5
  ci5="$(
    grep -rn 'quarantinePolicy:[[:space:]]*"erasure"' app lib --include="*.ts" 2>/dev/null \
      | grep -vE "(^|/)lib/services/account/" \
      | grep -vE "(^|/)lib/tenant/job\.ts:" \
      | grep -vE "\.test\.ts:" || true
  )"
  if [ -n "$ci5" ]; then
    echo "CI-AD-5 FAIL: the erasure quarantine bypass is used outside the account module:"
    echo "$ci5"; fail=1
  fi

  # ── 6: tenant jobs are gated by default ──────────────────────────────────
  if ! tscode "$JOB" | grep "assertBusinessAcceptsWrites" >/dev/null 2>&1; then
    echo "CI-AD-6 FAIL: runTenantJob does not check the deletion lifecycle"; fail=1
  fi
  if ! tscode "$JOB" | grep -E 'policy === "normal"' >/dev/null 2>&1; then
    echo "CI-AD-6 FAIL: runTenantJob does not default to the guarded policy"; fail=1
  fi

  # ── 7: session auth gates the whole quarantine ───────────────────────────
  if ! tscode "$AUTH" | grep "acceptsNormalWrites" >/dev/null 2>&1; then
    echo "CI-AD-7 FAIL: getCurrentUser does not use the canonical lifecycle gate"; fail=1
  fi
  if tscode "$AUTH" | grep -E "business\?\.deletedAt|business\.deletedAt" >/dev/null 2>&1; then
    echo "CI-AD-7 FAIL: getCurrentUser still gates on deletedAt alone (the quarantine window stays authenticated)"; fail=1
  fi

  # ── 8: the payment webhook gates before the tenant boundary ──────────────
  if ! tscode "$WEBHOOK" | grep "getBusinessLifecycle" >/dev/null 2>&1; then
    echo "CI-AD-8 FAIL: the payment webhook does not check the deletion lifecycle"; fail=1
  fi
  local w_gate w_ctx
  w_gate="$(tscode "$WEBHOOK" | grep -n "getBusinessLifecycle(" | awk -F: 'NR==1{print $1}' || true)"
  w_ctx="$(tscode "$WEBHOOK" | grep -n "runWithTenantContext({ businessId: request.businessId }" | awk -F: 'NR==1{print $1}' || true)"
  if [ -n "$w_gate" ] && [ -n "$w_ctx" ] && [ "$w_gate" -ge "$w_ctx" ]; then
    echo "CI-AD-8 FAIL: the webhook enters the tenant before checking the lifecycle"; fail=1
  fi

  # ── 9: settlement writes are race-safe ───────────────────────────────────
  if ! tscode "$PAYSTORE" | grep "assertBusinessAcceptsWritesTx" >/dev/null 2>&1; then
    echo "CI-AD-9 FAIL: payment settlement writes have no in-transaction lifecycle check (TOCTOU)"; fail=1
  fi
  if ! tscode "$PAYSTORE" | grep "guardedDbStep" >/dev/null 2>&1; then
    echo "CI-AD-9 FAIL: the guarded step helper is gone"; fail=1
  fi

  # ── 10: no request-supplied tenant on the deletion route ─────────────────
  if tscode "$ROUTE" | grep -E "req\.json\(\)|searchParams|params" >/dev/null 2>&1; then
    echo "CI-AD-10 FAIL: the deletion route reads a target from the request"; fail=1
  fi
  if ! tscode "$ROUTE" | grep "businessId: user.businessId" >/dev/null 2>&1; then
    echo "CI-AD-10 FAIL: the deletion route does not take the tenant from the session"; fail=1
  fi

  # ── 11: the integrity scanner mutates nothing ────────────────────────────
  # Comments are stripped first: this file DESCRIBES what it must never do, and a
  # naive grep would trip on its own documentation.
  if tscode "$SCAN" | grep -iE "(INSERT INTO|DELETE FROM|TRUNCATE|ALTER TABLE|DROP TABLE|CREATE TABLE|UPDATE \"[A-Za-z])" >/dev/null 2>&1; then
    echo "CI-AD-11 FAIL: the integrity scanner contains a mutating statement"; fail=1
  fi
  if tscode "$SCAN" | grep -E '\$executeRaw\b|\$executeRawUnsafe' >/dev/null 2>&1; then
    echo "CI-AD-11 FAIL: the integrity scanner can execute non-query SQL"; fail=1
  fi

  # ── 12/13: AD-2A grants no DELETE and adds no DELETE policy ──────────────
  local ci12
  ci12="$(
    grep -rniE 'GRANT[^;]*DELETE[^;]*ON[[:space:]]*"(Conversation|Message|MessageAnalysis|ReplySuggestion)"' \
      scripts/security 2>/dev/null || true
  )"
  if [ -n "$ci12" ]; then
    echo "CI-AD-12 FAIL: a DELETE grant on the Conversation graph appeared (AD-2A must add none):"
    echo "$ci12"; fail=1
  fi
  # CI-AD-13 is a RATCHET, not a ban. A DELETE policy is how a tenant is allowed
  # to delete its own rows at all, so one appearing unannounced is exactly the
  # regression AD-2A exists to stop — but a table with a real, named delete
  # consumer must still be able to have one.
  #
  # So the check stays repo-wide and subtracts a REGISTER: every allowed DELETE
  # policy is named here with its consumer. Anything not on this list still
  # fails, which is what keeps the ratchet meaningful. Adding a line here is a
  # deliberate, reviewable act — not an exemption pattern that absorbs whatever
  # a future migration happens to add.
  #
  # Registered:
  #   p7imp_tenant_delete      ImportRun     retention cleanup + account erasure
  #   p7imp_row_tenant_delete  ImportRunRow  retention cleanup + account erasure
  #
  # Both belong to the Import execution ledger (I-6). Its rows carry no business
  # data — only ids, digests, enums and timestamps — and it has TWO real delete
  # consumers: the 30-day cleanup of the retry scaffolding, and erasure, which
  # must not strand import evidence inside a deleted business. Writing no DELETE
  # policy would have made the retention policy unimplementable.
  #
  # Neither touches the Conversation graph, which CI-AD-12 continues to guard by
  # name.
  local AD13_REGISTERED='p7imp_tenant_delete|p7imp_row_tenant_delete'
  local ci13
  ci13="$(
    grep -rniE 'CREATE POLICY[^;]*FOR DELETE' prisma/migrations 2>/dev/null \
      | grep -vE "CREATE POLICY[[:space:]]+($AD13_REGISTERED)[[:space:]]" || true
  )"
  if [ -n "$ci13" ]; then
    echo "CI-AD-13 FAIL: an UNREGISTERED DELETE policy appeared in a migration:"
    echo "$ci13"
    echo "  If it is intended, register it in AD13_REGISTERED with its delete consumer."
    fail=1
  fi

  if [ "$fail" -ne 0 ]; then
    echo ""
    echo "Fix: quarantine first; purge only under a proven tenant context; audit atomically;"
    echo "     every non-erasure path refuses a quarantined business; and AD-2A grants no DELETE."
    return 1
  fi
  return 0
}

self_test() {
  BASE="$(mktemp -d)"
  trap 'rm -rf "$BASE"' EXIT
  local ok=0 bad=0

  make_clean_tree() {
    local T="$1"
    mkdir -p "$T/lib/services/account" "$T/lib/tenant" "$T/lib/services/payments" \
             "$T/app/api/account" "$T/scripts/security" "$T/prisma/migrations/x"

    cat > "$T/lib/services/account/account-deletion.prisma-store.ts" <<'TS'
import { runTenantJob } from "@/lib/tenant/job";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { logAuditEvent } from "@/lib/services/audit.service";
async function assertTenantContextIs(tx: unknown, businessId: number) {}
function assertExactlyOne(n: number, op: string) {}
function assertAtLeastOne(n: number, op: string) {}
export const prismaAccountDeletionStore = {
  async purgeOperationalData(businessId: number) {
    await runTenantJob({ businessId }, () => withTenantTransaction(async (tx) => {
      await assertTenantContextIs(tx, businessId);
      const users = await tx.user.updateMany({});
      assertAtLeastOne(users.count, "user anonymization");
    }), { quarantinePolicy: "erasure" });
  },
  async finalizeAndAudit(businessId: number, actorUserId: number, now: Date) {
    await prisma.$transaction(async (tx) => {
      const finalized = await tx.business.updateMany({});
      assertExactlyOne(finalized.count, "purge finalization");
      await logAuditEvent({ businessId }, { tx });
    });
  },
};
TS

    cat > "$T/lib/services/account/account-deletion.service.ts" <<'TS'
export async function deleteOwnBusinessAccount(store, args) {
  await store.quarantineAndRevokeIntegrations(args.businessId, args.now);
  await store.purgeOperationalData(args.businessId);
  await store.finalizeAndAudit(args.businessId, args.actorUserId, args.now);
}
TS

    cat > "$T/app/api/account/route.ts" <<'TS'
import { getCurrentUser } from "@/lib/auth";
export async function DELETE(req: Request) {
  const user = await getCurrentUser(req);
  return deleteOwnBusinessAccount(store, { businessId: user.businessId, actorUserId: user.id });
}
TS

    cat > "$T/lib/tenant/job.ts" <<'TS'
import { assertBusinessAcceptsWrites } from "@/lib/tenant/business-lifecycle";
export async function runTenantJob(identity, fn, options) {
  const policy = options?.quarantinePolicy ?? "normal";
  if (policy === "normal") {
    await assertBusinessAcceptsWrites(identity.businessId);
  }
  return fn();
}
TS

    cat > "$T/lib/tenant/business-lifecycle.ts" <<'TS'
export function acceptsNormalWrites(row) { return true; }
export async function assertBusinessAcceptsWrites(id: number) {}
export async function assertBusinessAcceptsWritesTx(tx, id: number) {}
export async function readBusinessLifecycle(id: number) { return "ACTIVE"; }
TS

    cat > "$T/lib/auth.ts" <<'TS'
import { acceptsNormalWrites } from "./tenant/business-lifecycle";
export async function getCurrentUser(req: Request) {
  const user = await prisma.user.findUnique({});
  if (user && user.business && !acceptsNormalWrites(user.business)) {
    return null;
  }
  return user;
}
TS

    cat > "$T/lib/services/payments/payment-webhook.service.ts" <<'TS'
import { runWithTenantContext } from "@/lib/tenant/context";
import { runWithTenantContext } from "@/lib/tenant/context";
export async function processPaymentWebhook() {
  const lifecycle = await deps.store.getBusinessLifecycle(request.businessId);
  if (lifecycle !== "ACTIVE") { return fail("FAILED", "business_quarantined"); }
  return runWithTenantContext({ businessId: request.businessId }, async () => {});
}
TS

    cat > "$T/lib/services/payments/payment-store.prisma.ts" <<'TS'
import { assertBusinessAcceptsWritesTx } from "@/lib/tenant/business-lifecycle";
async function guardedDbStep(businessId, fn) {
  return withTenantTransaction(async (tx) => {
    await assertBusinessAcceptsWritesTx(tx, businessId);
    return fn(tx);
  });
}
TS

    cat > "$T/scripts/security/conversation-integrity-scan.mjs" <<'JS'
const EDGES = [{ name: "x", sql: 'SELECT m."id" FROM "Message" m WHERE 1=0' }];
export async function scanConversationIntegrity(client) {
  return client.$queryRawUnsafe(EDGES[0].sql);
}
JS

    printf 'CREATE POLICY p ON "X" FOR SELECT USING (true);\n' > "$T/prisma/migrations/x/migration.sql"
    mkdir -p "$T/scripts/security"
    printf 'GRANT SELECT ON "Conversation" TO :ROLE;\n' > "$T/scripts/security/grants.sql"
  }

  check() {
    local name="$1" expect="$2" tree="$3"
    if (run_guard "$tree" >/dev/null 2>&1); then actual=PASS; else actual=FAIL; fi
    if [ "$actual" = "$expect" ]; then
      ok=$((ok + 1)); echo "  [SELF-PASS] $name ($expect)"
    else
      bad=$((bad + 1)); echo "  [SELF-FAIL] $name expected=$expect got=$actual"
    fi
  }

  local T0="$BASE/clean"; make_clean_tree "$T0"
  check "clean tree passes" PASS "$T0"

  local T1="$BASE/v1"; make_clean_tree "$T1"
  cat > "$T1/lib/services/account/account-deletion.prisma-store.ts" <<'TS'
import { prisma } from "@/lib/prisma";
export const prismaAccountDeletionStore = {
  async purgeOperationalData(businessId: number) {
    await prisma.$transaction([prisma.conversation.deleteMany({ where: { businessId } })]);
  },
};
TS
  check "CI-AD-1/2/4 catch a context-less, unasserted, unaudited purge" FAIL "$T1"

  local T2="$BASE/v2"; make_clean_tree "$T2"
  cat > "$T2/lib/services/account/account-deletion.service.ts" <<'TS'
export async function deleteOwnBusinessAccount(store, args) {
  await store.purgeOperationalData(args.businessId);
  await store.quarantineAndRevokeIntegrations(args.businessId, args.now);
  await store.finalizeAndAudit(args.businessId, args.actorUserId, args.now);
}
TS
  check "CI-AD-3 catches destructive work ordered before the quarantine" FAIL "$T2"

  local T3="$BASE/v3"; make_clean_tree "$T3"
  mkdir -p "$T3/lib/services/documents"
  cat > "$T3/lib/services/documents/leak.ts" <<'TS'
import { runTenantJob } from "@/lib/tenant/job";
export const go = (businessId: number) =>
  runTenantJob({ businessId }, async () => {}, { quarantinePolicy: "erasure" });
TS
  check "CI-AD-5 catches the quarantine bypass escaping the account module" FAIL "$T3"

  local T4="$BASE/v4"; make_clean_tree "$T4"
  cat > "$T4/lib/tenant/job.ts" <<'TS'
export async function runTenantJob(identity, fn) {
  return fn();
}
TS
  check "CI-AD-6 catches an ungated runTenantJob" FAIL "$T4"

  local T5="$BASE/v5"; make_clean_tree "$T5"
  cat > "$T5/lib/auth.ts" <<'TS'
export async function getCurrentUser(req: Request) {
  const user = await prisma.user.findUnique({});
  if (user && user.business?.deletedAt) {
    return null;
  }
  return user;
}
TS
  check "CI-AD-7 catches auth regressing to deletedAt-only" FAIL "$T5"

  local T6="$BASE/v6"; make_clean_tree "$T6"
  cat > "$T6/lib/services/payments/payment-webhook.service.ts" <<'TS'
import { runWithTenantContext } from "@/lib/tenant/context";
import { readBusinessLifecycle } from "@/lib/tenant/business-lifecycle";
export async function processPaymentWebhook() {
  return runWithTenantContext({ businessId: request.businessId }, async () => {
    const lifecycle = await deps.store.getBusinessLifecycle(request.businessId);
  });
}
TS
  check "CI-AD-8 catches the webhook entering the tenant before the gate" FAIL "$T6"

  local T7="$BASE/v7"; make_clean_tree "$T7"
  cat > "$T7/lib/services/payments/payment-store.prisma.ts" <<'TS'
async function dbStep(fn) { return withTenantTransaction((tx) => fn(tx)); }
TS
  check "CI-AD-9 catches settlement writes losing the in-tx lifecycle check" FAIL "$T7"

  local T8="$BASE/v8"; make_clean_tree "$T8"
  cat > "$T8/app/api/account/route.ts" <<'TS'
export async function DELETE(req: Request) {
  const body = await req.json();
  return deleteOwnBusinessAccount(store, { businessId: body.businessId, actorUserId: body.actorUserId });
}
TS
  check "CI-AD-10 catches a request-supplied deletion target" FAIL "$T8"

  local T9="$BASE/v9"; make_clean_tree "$T9"
  cat >> "$T9/scripts/security/conversation-integrity-scan.mjs" <<'JS'
export async function repair(client) {
  return client.$executeRawUnsafe('DELETE FROM "Message" WHERE 1=0');
}
JS
  check "CI-AD-11 catches a mutating integrity scanner" FAIL "$T9"

  local T10="$BASE/v10"; make_clean_tree "$T10"
  printf 'GRANT SELECT, DELETE ON "Conversation" TO :ROLE;\n' >> "$T10/scripts/security/grants.sql"
  check "CI-AD-12 catches a Conversation DELETE grant" FAIL "$T10"

  local T11="$BASE/v11"; make_clean_tree "$T11"
  printf 'CREATE POLICY d ON "Conversation" FOR DELETE TO app_runtime USING (true);\n' \
    >> "$T11/prisma/migrations/x/migration.sql"
  check "CI-AD-13 catches a new DELETE policy" FAIL "$T11"

  echo "self-test: ok=$ok bad=$bad"
  [ "$bad" -eq 0 ]
}

if [ "${1:-}" = "--self-test" ]; then
  self_test
else
  run_guard "${1:-.}"
fi
