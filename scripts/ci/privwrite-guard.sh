#!/usr/bin/env bash
# D2 / PRIVILEGED-WRITE-2 — control-plane write invariants (CI-PRIVWRITE).
#
# Mechanical guards for the BusinessFeatureAccess control-plane capability. The
# point of this family is that the capability cannot be BROADENED later without
# CI noticing: not the role's privileges, not the client's reach, not the
# policies, and not the authorization that precedes it.
#
#   CI-PRIVWRITE-1   no generic app_admin DML anywhere in the wave
#   CI-PRIVWRITE-2   no BYPASSRLS / SUPERUSER in any wave artifact
#   CI-PRIVWRITE-3   no owner runtime (no OWNER TO / ALTER ... OWNER)
#   CI-PRIVWRITE-4   no SECURITY DEFINER object
#   CI-PRIVWRITE-5   control-plane client reads CONTROL_PLANE_DATABASE_URL only
#   CI-PRIVWRITE-6   control-plane client has no credential fallback chain
#   CI-PRIVWRITE-7   control-plane client import allowlist
#   CI-PRIVWRITE-8   control-plane module never imports the tenant singleton
#   CI-PRIVWRITE-9   control-plane grants name only approved tables
#   CI-PRIVWRITE-10  no DELETE granted to any role in the wave
#   CI-PRIVWRITE-11  BusinessFeatureAccess gets ENABLE + FORCE RLS
#   CI-PRIVWRITE-12  tenant policy is SELECT-only; no tenant write policy
#   CI-PRIVWRITE-13  control-plane write policies are GUC-constrained
#   CI-PRIVWRITE-14  the mutation route authorizes PLATFORM_ADMIN first
#   CI-PRIVWRITE-15  actor is never body/query-supplied on this path
#   CI-PRIVWRITE-16  the tenant resolver never uses the context-less singleton
#   CI-PRIVWRITE-17  the admin read path uses the sanctioned admin client
#   CI-PRIVWRITE-18  no bare prisma.$transaction on the mutation path
#   CI-PRIVWRITE-19  mutation and audit share one transaction
#   CI-PRIVWRITE-20  no DELETE policy in the migration
#   CI-PRIVWRITE-21  feature-access (tenant territory) sees no privileged client
#
# Comments are stripped before matching, so a guard cannot be satisfied — or
# tripped — by prose. Not covered mechanically (documented limitation): "the
# privileged client is never reached before authorization" is proven
# structurally by CI-PRIVWRITE-14 plus the route's single call site; a full
# call-graph proof would need an AST pass and is a candidate for a later slice.
#
# Usage: privwrite-guard.sh [repo-root] | privwrite-guard.sh --self-test
set -euo pipefail

# Strip comments AND re-emit ONE STATEMENT PER LINE, so line-based matching
# cannot be defeated by wrapping a statement across several lines.
sqlflat() {
  sed 's/--.*//' "$1" | awk 'BEGIN { RS = ";" } { gsub(/[[:space:]]+/, " "); if ($0 ~ /[^ ]/) print $0 ";" }'
}
# Strip TS line comments and block-comment bodies (leading * lines).
tscode() { sed -e 's://.*::' -e 's:^[[:space:]]*\*.*::' -e 's:^[[:space:]]*/\*.*::' "$1"; }

run_guard() {
  local ROOT="${1:-.}"
  cd "$ROOT"
  local fail=0

  local MIG="prisma/migrations/20260901090000_d2_pw2_business_feature_access_rls/migration.sql"
  local GRANTS="scripts/security/d2-pw2-grants.sql"
  local ROLLBACK="scripts/security/d2-pw2-rollback.sql"
  local CLIENT="lib/prisma-control-plane.ts"
  local CTLTX="lib/services/control-plane/control-plane-transaction.ts"
  local UPDSVC="lib/services/platform-admin/update-business-feature-access.service.ts"
  local ADMSVC="lib/services/platform-admin/platform-business-features.service.ts"
  local RESOLVER="lib/services/feature-access/resolve-feature-access.ts"
  local ROUTE="app/api/platform-admin/businesses/[id]/features/[featureKey]/route.ts"

  for f in "$MIG" "$GRANTS" "$ROLLBACK" "$CLIENT" "$CTLTX" "$UPDSVC" "$ADMSVC" "$RESOLVER" "$ROUTE"; do
    if [ ! -f "$f" ]; then
      echo "CI-PRIVWRITE FAIL: required artifact missing -> $f"
      fail=1
    fi
  done
  if [ "$fail" -ne 0 ]; then return 1; fi

  # ── 1: no generic app_admin DML ─────────────────────────────────────────
  # app_admin keeps exactly its historical posture: SELECT everywhere plus the
  # pre-existing append-only PlatformAuditEvent INSERT. Nothing in this wave may
  # add a write to it.
  for f in "$GRANTS" "$MIG"; do
    if sqlflat "$f" | grep -qiE "GRANT[^;]*(INSERT|UPDATE|DELETE)[^;]*TO[[:space:]]+app_admin"; then
      echo "CI-PRIVWRITE-1 FAIL: generic app_admin write grant in $f"; fail=1
    fi
  done

  # ── 2: no BYPASSRLS / SUPERUSER ─────────────────────────────────────────
  for f in "$MIG" "$GRANTS" "$ROLLBACK"; do
    if sqlflat "$f" | grep -qiE "(^|[^O])BYPASSRLS|[^O]SUPERUSER"; then
      echo "CI-PRIVWRITE-2 FAIL: BYPASSRLS/SUPERUSER in $f"; fail=1
    fi
  done

  # ── 3: no owner runtime ─────────────────────────────────────────────────
  for f in "$MIG" "$GRANTS" "$ROLLBACK"; do
    if sqlflat "$f" | grep -qiE "OWNER[[:space:]]+TO"; then
      echo "CI-PRIVWRITE-3 FAIL: ownership transfer in $f"; fail=1
    fi
  done

  # ── 4: no SECURITY DEFINER ──────────────────────────────────────────────
  for f in "$MIG" "$GRANTS" "$ROLLBACK"; do
    if sqlflat "$f" | grep -qi "SECURITY[[:space:]]\+DEFINER"; then
      echo "CI-PRIVWRITE-4 FAIL: SECURITY DEFINER in $f"; fail=1
    fi
  done

  # ── 5/6: the client reads one env var and never falls back ──────────────
  if ! tscode "$CLIENT" | grep -q "CONTROL_PLANE_DATABASE_URL"; then
    echo "CI-PRIVWRITE-5 FAIL: $CLIENT does not read CONTROL_PLANE_DATABASE_URL"; fail=1
  fi
  if tscode "$CLIENT" | grep -qE "process\.env\.(DATABASE_URL|DIRECT_URL|ADMIN_DATABASE_URL)"; then
    echo "CI-PRIVWRITE-6 FAIL: $CLIENT references a fallback credential"; fail=1
  fi
  if ! tscode "$CLIENT" | grep -q "throw new Error"; then
    echo "CI-PRIVWRITE-6 FAIL: $CLIENT does not fail loud on a missing credential"; fail=1
  fi

  # ── 7: import allowlist for the control-plane client ────────────────────
  local ci7
  ci7="$(
    grep -rnE "from ['\"](@/lib/prisma-control-plane|[./]+lib/prisma-control-plane|[./]+prisma-control-plane)['\"]" \
      app lib --include="*.ts" --include="*.tsx" 2>/dev/null \
      | grep -vE "(^|/)lib/services/control-plane/" \
      | grep -vE "(^|/)lib/prisma-control-plane\.ts:" \
      | grep -vE "\.test\.ts:|/__mocks__/" \
      || true
  )"
  if [ -n "$ci7" ]; then
    echo "CI-PRIVWRITE-7 FAIL: control-plane client imported outside lib/services/control-plane/**:"
    echo "$ci7"; fail=1
  fi

  # ── 8: the control-plane module never touches the tenant singleton ──────
  local ci8
  ci8="$(grep -rnE "from ['\"]@/lib/prisma['\"]" lib/services/control-plane --include="*.ts" 2>/dev/null || true)"
  if [ -n "$ci8" ]; then
    echo "CI-PRIVWRITE-8 FAIL: tenant singleton imported inside the control-plane module:"
    echo "$ci8"; fail=1
  fi

  # ── 9: control-plane grants name only approved tables ───────────────────
  local approved='BusinessFeatureAccess|PlatformAuditEvent|Business|PlatformFeaturePolicy'
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    if ! echo "$line" | grep -qE "\"($approved)\"|ON SCHEMA public|SEQUENCE"; then
      echo "CI-PRIVWRITE-9 FAIL: control-plane grant on an unapproved object -> $line"; fail=1
    fi
  done < <(sqlflat "$GRANTS" | grep -iE "GRANT[^;]*TO[[:space:]]+app_ctlplane" || true)

  # ── 10: no DELETE granted to anyone; audit stays append-only ────────────
  if sqlflat "$GRANTS" | grep -qiE "GRANT[^;]*DELETE"; then
    echo "CI-PRIVWRITE-10 FAIL: a DELETE privilege is granted in $GRANTS"; fail=1
  fi
  if sqlflat "$GRANTS" | grep -qiE "GRANT[^;]*SELECT[^;]*ON \"PlatformAuditEvent\"[^;]*TO[[:space:]]+app_ctlplane"; then
    echo "CI-PRIVWRITE-10 FAIL: the control-plane role is granted SELECT on the audit trail (append-only means it may not read what it wrote)"; fail=1
  fi

  # ── 11: ENABLE + FORCE RLS ──────────────────────────────────────────────
  sqlflat "$MIG" | grep -qE 'ALTER TABLE "BusinessFeatureAccess" ENABLE ROW LEVEL SECURITY' || {
    echo "CI-PRIVWRITE-11 FAIL: BusinessFeatureAccess is not ENABLE RLS"; fail=1; }
  sqlflat "$MIG" | grep -qE 'ALTER TABLE "BusinessFeatureAccess" FORCE ROW LEVEL SECURITY' || {
    echo "CI-PRIVWRITE-11 FAIL: BusinessFeatureAccess is not FORCE RLS"; fail=1; }

  # ── 12: the tenant policy is SELECT-only ────────────────────────────────
  if ! sqlflat "$MIG" | grep "CREATE POLICY p7pw2_tenant_read" | grep -q "FOR SELECT"; then
    echo "CI-PRIVWRITE-12 FAIL: p7pw2_tenant_read is not FOR SELECT"; fail=1
  fi
  if sqlflat "$MIG" | grep "CREATE POLICY p7pw2_tenant_read" | grep -q "WITH CHECK"; then
    echo "CI-PRIVWRITE-12 FAIL: the tenant policy carries a write branch"; fail=1
  fi

  # ── 13: control-plane write policies are GUC-constrained ────────────────
  for pol in p7pw2_ctl_insert p7pw2_ctl_update; do
    if ! sqlflat "$MIG" | grep "CREATE POLICY $pol" | grep -q "app.current_business_id"; then
      echo "CI-PRIVWRITE-13 FAIL: $pol is not constrained by the tenant GUC"; fail=1
    fi
    if ! sqlflat "$MIG" | grep "CREATE POLICY $pol" | grep -q "TO app_ctlplane"; then
      echo "CI-PRIVWRITE-13 FAIL: $pol is not restricted to app_ctlplane"; fail=1
    fi
  done
  if sqlflat "$MIG" | grep "CREATE POLICY p7pw2_ctl_update" | grep -q "USING (true)"; then
    echo "CI-PRIVWRITE-13 FAIL: the control-plane update policy is unconstrained"; fail=1
  fi

  # ── 14: the mutation route authorizes PLATFORM_ADMIN ────────────────────
  if ! tscode "$ROUTE" | grep -q "requirePlatformAdmin"; then
    echo "CI-PRIVWRITE-14 FAIL: the feature mutation route lacks the canonical admin guard"; fail=1
  fi
  # The guard must precede the privileged service call in source order.
  local authline svcline
  authline="$(tscode "$ROUTE" | grep -n "requirePlatformAdmin" | head -1 | cut -d: -f1)"
  svcline="$(tscode "$ROUTE" | grep -n "updateBusinessFeatureAccess(" | tail -1 | cut -d: -f1)"
  if [ -n "$authline" ] && [ -n "$svcline" ] && [ "$authline" -ge "$svcline" ]; then
    echo "CI-PRIVWRITE-14 FAIL: authorization does not precede the privileged call"; fail=1
  fi

  # ── 15: actor is never body/query supplied ──────────────────────────────
  if tscode "$ROUTE" | grep -qE "actorUserId:[[:space:]]*(record|body|rawBody|searchParams)"; then
    echo "CI-PRIVWRITE-15 FAIL: the route takes actorUserId from the request"; fail=1
  fi
  if ! tscode "$ROUTE" | grep -q "actorUserId: auth.id"; then
    echo "CI-PRIVWRITE-15 FAIL: the route does not pass the authenticated admin as actor"; fail=1
  fi
  if tscode "$UPDSVC" | grep -qE "req\.(json|headers)|searchParams"; then
    echo "CI-PRIVWRITE-15 FAIL: the privileged service reads the request directly"; fail=1
  fi

  # ── 16: the tenant resolver never uses the context-less singleton ───────
  if tscode "$RESOLVER" | grep -qE "from ['\"]@/lib/prisma['\"]"; then
    echo "CI-PRIVWRITE-16 FAIL: the tenant resolver imports the context-less singleton"; fail=1
  fi
  if ! tscode "$RESOLVER" | grep -q "withTenantTransaction"; then
    echo "CI-PRIVWRITE-16 FAIL: the tenant resolver does not run inside a tenant transaction"; fail=1
  fi

  # ── 17: the admin read runs under an EXPLICIT target context ────────────
  # It reads one named business, so it needs no cross-tenant credential. What it
  # must never do is read this FORCE-RLS'd table with no context at all — that is
  # the fail-silent shape that renders every business as "no override".
  if tscode "$ADMSVC" | grep -qE "from ['\"]@/lib/prisma['\"]"; then
    echo "CI-PRIVWRITE-17 FAIL: the admin features read imports the context-less tenant singleton"; fail=1
  fi
  if ! tscode "$ADMSVC" | grep -q "runTenantJob"; then
    echo "CI-PRIVWRITE-17 FAIL: the admin features read establishes no explicit target context"; fail=1
  fi
  if ! tscode "$ADMSVC" | grep -q "withTenantTransaction"; then
    echo "CI-PRIVWRITE-17 FAIL: the admin features read is not GUC-scoped"; fail=1
  fi

  # ── 18: no bare prisma.$transaction on the mutation path ────────────────
  if tscode "$UPDSVC" | grep -qE "prisma\.\\\$transaction"; then
    echo "CI-PRIVWRITE-18 FAIL: bare prisma.\$transaction on the privileged mutation path"; fail=1
  fi
  if ! tscode "$UPDSVC" | grep -q "withControlPlaneTransaction"; then
    echo "CI-PRIVWRITE-18 FAIL: the mutation does not run in a control-plane transaction"; fail=1
  fi
  if ! tscode "$UPDSVC" | grep -q "assertAffected"; then
    echo "CI-PRIVWRITE-18 FAIL: the mutation has no affected-row assertion"; fail=1
  fi

  # ── 19: mutation and audit share one transaction ────────────────────────
  if ! tscode "$UPDSVC" | grep -q "createPlatformAuditEventTx(tx"; then
    echo "CI-PRIVWRITE-19 FAIL: the audit append is not on the mutation transaction"; fail=1
  fi
  if tscode "$UPDSVC" | grep -q "logPlatformAuditEvent"; then
    echo "CI-PRIVWRITE-19 FAIL: the privileged path uses the best-effort (non-atomic) audit"; fail=1
  fi

  # ── 20: no DELETE policy in the migration ───────────────────────────────
  if sqlflat "$MIG" | grep -qiE "CREATE POLICY[^;]*FOR DELETE"; then
    echo "CI-PRIVWRITE-20 FAIL: a DELETE policy exists on the table"; fail=1
  fi
  if tscode "$UPDSVC" | grep -qE "businessFeatureAccess\.delete"; then
    echo "CI-PRIVWRITE-20 FAIL: the mutation path still deletes rows (INHERIT is the contract)"; fail=1
  fi

  # ── 21: ratchet — tenant territory sees no privileged client ────────────
  local ci21
  ci21="$(
    grep -rnE "from ['\"](@/lib/prisma-admin|@/lib/prisma-control-plane)['\"]" \
      lib/services/feature-access --include="*.ts" 2>/dev/null \
      | grep -vE "\.test\.ts:" || true
  )"
  if [ -n "$ci21" ]; then
    echo "CI-PRIVWRITE-21 FAIL: a privileged client is reachable from tenant feature-access code:"
    echo "$ci21"; fail=1
  fi

  if [ "$fail" -ne 0 ]; then
    echo ""
    echo "Fix: the control-plane capability is BusinessFeatureAccess + append-only audit, nothing else;"
    echo "     it is reached only through lib/services/control-plane, only after requirePlatformAdmin,"
    echo "     and only inside a GUC-locked transaction. app_admin stays read-only."
    return 1
  fi
  return 0
}

self_test() {
  # Negative proof: plant each violation in a scratch tree and assert the guard
  # catches it. A clean tree must pass.
  BASE="$(mktemp -d)"
  trap 'rm -rf "$BASE"' EXIT
  local ok=0 bad=0

  make_clean_tree() {
    local T="$1"
    mkdir -p "$T/prisma/migrations/20260901090000_d2_pw2_business_feature_access_rls" \
             "$T/scripts/security" \
             "$T/lib/services/control-plane" \
             "$T/lib/services/platform-admin" \
             "$T/lib/services/feature-access" \
             "$T/app/api/platform-admin/businesses/[id]/features/[featureKey]"

    cat > "$T/prisma/migrations/20260901090000_d2_pw2_business_feature_access_rls/migration.sql" <<'SQL'
ALTER TABLE "BusinessFeatureAccess" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessFeatureAccess" FORCE ROW LEVEL SECURITY;
CREATE POLICY p7pw2_tenant_read ON "BusinessFeatureAccess"
  FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY p7adm_read ON "BusinessFeatureAccess"
  FOR SELECT TO app_admin
  USING (true);
CREATE POLICY p7pw2_ctl_insert ON "BusinessFeatureAccess"
  FOR INSERT TO app_ctlplane
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY p7pw2_ctl_update ON "BusinessFeatureAccess"
  FOR UPDATE TO app_ctlplane
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
SQL

    cat > "$T/scripts/security/d2-pw2-grants.sql" <<'SQL'
GRANT SELECT ON "BusinessFeatureAccess" TO :ROLE;
GRANT SELECT ON "BusinessFeatureAccess" TO app_admin;
GRANT USAGE ON SCHEMA public TO app_ctlplane;
GRANT SELECT, INSERT, UPDATE ON "BusinessFeatureAccess" TO app_ctlplane;
GRANT USAGE, SELECT ON SEQUENCE "BusinessFeatureAccess_id_seq" TO app_ctlplane;
GRANT INSERT ON "PlatformAuditEvent" TO app_ctlplane;
GRANT SELECT ON "Business" TO app_ctlplane;
GRANT app_ctlplane TO :CTL_LOGIN_ROLE;
SQL

    cat > "$T/scripts/security/d2-pw2-rollback.sql" <<'SQL'
DROP POLICY IF EXISTS p7pw2_ctl_update ON "BusinessFeatureAccess";
REVOKE ALL PRIVILEGES ON "BusinessFeatureAccess" FROM app_ctlplane;
SQL

    cat > "$T/lib/prisma-control-plane.ts" <<'TS'
export function getPrismaControlPlane() {
  const url = process.env.CONTROL_PLANE_DATABASE_URL?.trim();
  if (!url) {
    throw new Error("CONTROL_PLANE_DATABASE_URL is not configured");
  }
  return url;
}
TS

    cat > "$T/lib/services/control-plane/control-plane-transaction.ts" <<'TS'
import { getPrismaControlPlane } from "@/lib/prisma-control-plane";
export async function withControlPlaneTransaction(id: number, fn: unknown) {
  return getPrismaControlPlane();
}
export function assertAffected(count: number, op: string) {}
TS

    cat > "$T/lib/services/platform-admin/update-business-feature-access.service.ts" <<'TS'
import { assertAffected, withControlPlaneTransaction } from "@/lib/services/control-plane/control-plane-transaction";
import { createPlatformAuditEventTx } from "@/lib/services/platform-admin/platform-audit.service";
export async function updateBusinessFeatureAccess(input: { actorUserId: number }) {
  return withControlPlaneTransaction(1, async (tx) => {
    const updated = await tx.businessFeatureAccess.updateMany({});
    assertAffected(updated.count, "update");
    await createPlatformAuditEventTx(tx, { actorUserId: input.actorUserId });
  });
}
TS

    cat > "$T/lib/services/platform-admin/platform-business-features.service.ts" <<'TS'
import { runTenantJob } from "@/lib/tenant/job";
import { withTenantTransaction } from "@/lib/tenant/transaction";
export async function getPlatformAdminBusinessFeatures(businessId: number) {
  return runTenantJob({ businessId }, () =>
    withTenantTransaction((tx) =>
      tx.businessFeatureAccess.findMany({ where: { businessId } })
    )
  );
}
TS

    cat > "$T/lib/services/feature-access/resolve-feature-access.ts" <<'TS'
import { withTenantTransaction } from "@/lib/tenant/transaction";
export async function resolveBusinessCapabilities(businessId: number) {
  return withTenantTransaction((tx) => tx.businessFeatureAccess.findMany({ where: { businessId } }));
}
TS

    cat > "$T/app/api/platform-admin/businesses/[id]/features/[featureKey]/route.ts" <<'TS'
import { requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";
import { updateBusinessFeatureAccess } from "@/lib/services/platform-admin/update-business-feature-access.service";
export async function PATCH(req: Request) {
  const auth = await requirePlatformAdminOrResponse(req);
  const result = await updateBusinessFeatureAccess({ actorUserId: auth.id });
  return result;
}
TS
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
  echo 'GRANT SELECT, INSERT ON "BusinessFeatureAccess" TO app_admin;' >> "$T1/scripts/security/d2-pw2-grants.sql"
  check "CI-PRIVWRITE-1 catches a generic app_admin write" FAIL "$T1"

  local T2="$BASE/v2"; make_clean_tree "$T2"
  echo 'CREATE ROLE app_ctlplane LOGIN BYPASSRLS;' >> "$T2/scripts/security/d2-pw2-grants.sql"
  check "CI-PRIVWRITE-2 catches BYPASSRLS" FAIL "$T2"

  local T3="$BASE/v3"; make_clean_tree "$T3"
  echo 'ALTER TABLE "BusinessFeatureAccess" OWNER TO app_ctlplane;' >> "$T3/prisma/migrations/20260901090000_d2_pw2_business_feature_access_rls/migration.sql"
  check "CI-PRIVWRITE-3 catches an ownership transfer" FAIL "$T3"

  local T4="$BASE/v4"; make_clean_tree "$T4"
  echo 'CREATE FUNCTION f() RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql SECURITY DEFINER;' >> "$T4/prisma/migrations/20260901090000_d2_pw2_business_feature_access_rls/migration.sql"
  check "CI-PRIVWRITE-4 catches SECURITY DEFINER" FAIL "$T4"

  local T5="$BASE/v5"; make_clean_tree "$T5"
  cat > "$T5/lib/prisma-control-plane.ts" <<'TS'
export function getPrismaControlPlane() {
  const url = process.env.CONTROL_PLANE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error("no url");
  }
  return url;
}
TS
  check "CI-PRIVWRITE-6 catches a credential fallback chain" FAIL "$T5"

  local T6="$BASE/v6"; make_clean_tree "$T6"
  mkdir -p "$T6/lib/services/billing"
  cat > "$T6/lib/services/billing/leak.ts" <<'TS'
import { getPrismaControlPlane } from "@/lib/prisma-control-plane";
export const x = getPrismaControlPlane;
TS
  check "CI-PRIVWRITE-7 catches the client leaking into tenant code" FAIL "$T6"

  local T7="$BASE/v7"; make_clean_tree "$T7"
  cat >> "$T7/lib/services/control-plane/control-plane-transaction.ts" <<'TS'
import { prisma } from "@/lib/prisma";
TS
  check "CI-PRIVWRITE-8 catches the tenant singleton inside the control-plane module" FAIL "$T7"

  local T8="$BASE/v8"; make_clean_tree "$T8"
  echo 'GRANT SELECT, UPDATE ON "Customer" TO app_ctlplane;' >> "$T8/scripts/security/d2-pw2-grants.sql"
  check "CI-PRIVWRITE-9 catches a grant on an unapproved table" FAIL "$T8"

  local T9="$BASE/v9"; make_clean_tree "$T9"
  echo 'GRANT DELETE ON "BusinessFeatureAccess" TO app_ctlplane;' >> "$T9/scripts/security/d2-pw2-grants.sql"
  check "CI-PRIVWRITE-10 catches a DELETE grant" FAIL "$T9"

  local T10="$BASE/v10"; make_clean_tree "$T10"
  sed -i 's/^ALTER TABLE "BusinessFeatureAccess" FORCE ROW LEVEL SECURITY;$//' \
    "$T10/prisma/migrations/20260901090000_d2_pw2_business_feature_access_rls/migration.sql"
  check "CI-PRIVWRITE-11 catches a missing FORCE RLS" FAIL "$T10"

  local T11="$BASE/v11"; make_clean_tree "$T11"
  cat >> "$T11/prisma/migrations/20260901090000_d2_pw2_business_feature_access_rls/migration.sql" <<'SQL'
CREATE POLICY p7pw2_tenant_write ON "BusinessFeatureAccess"
  FOR UPDATE
  USING (true) WITH CHECK (true);
SQL
  sed -i 's/  FOR SELECT$/  FOR SELECT\n  WITH CHECK (true)/' \
    "$T11/prisma/migrations/20260901090000_d2_pw2_business_feature_access_rls/migration.sql"
  check "CI-PRIVWRITE-12 catches a tenant write branch" FAIL "$T11"

  local T12="$BASE/v12"; make_clean_tree "$T12"
  cat > "$T12/prisma/migrations/20260901090000_d2_pw2_business_feature_access_rls/migration.sql" <<'SQL'
ALTER TABLE "BusinessFeatureAccess" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessFeatureAccess" FORCE ROW LEVEL SECURITY;
CREATE POLICY p7pw2_tenant_read ON "BusinessFeatureAccess"
  FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY p7adm_read ON "BusinessFeatureAccess"
  FOR SELECT TO app_admin
  USING (true);
CREATE POLICY p7pw2_ctl_insert ON "BusinessFeatureAccess"
  FOR INSERT TO app_ctlplane
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
CREATE POLICY p7pw2_ctl_update ON "BusinessFeatureAccess"
  FOR UPDATE TO app_ctlplane
  USING (true)
  WITH CHECK (true);
SQL
  check "CI-PRIVWRITE-13 catches an unconstrained control-plane update policy" FAIL "$T12"

  local T13="$BASE/v13"; make_clean_tree "$T13"
  cat > "$T13/app/api/platform-admin/businesses/[id]/features/[featureKey]/route.ts" <<'TS'
import { updateBusinessFeatureAccess } from "@/lib/services/platform-admin/update-business-feature-access.service";
export async function PATCH(req: Request) {
  const body = await req.json();
  return updateBusinessFeatureAccess({ actorUserId: body.actorUserId });
}
TS
  check "CI-PRIVWRITE-14/15 catch a route with no admin guard and a body actor" FAIL "$T13"

  local T14="$BASE/v14"; make_clean_tree "$T14"
  cat > "$T14/lib/services/feature-access/resolve-feature-access.ts" <<'TS'
import { prisma } from "@/lib/prisma";
export async function resolveBusinessCapabilities(businessId: number) {
  return prisma.businessFeatureAccess.findMany({ where: { businessId } });
}
TS
  check "CI-PRIVWRITE-16 catches the fail-open context-less resolver" FAIL "$T14"

  local T15="$BASE/v15"; make_clean_tree "$T15"
  cat > "$T15/lib/services/platform-admin/platform-business-features.service.ts" <<'TS'
import { prisma } from "@/lib/prisma";
export async function getPlatformAdminBusinessFeatures(id: number) {
  return prisma.businessFeatureAccess.findMany({ where: { businessId: id } });
}
TS
  check "CI-PRIVWRITE-17 catches the fail-silent admin read" FAIL "$T15"

  local T16="$BASE/v16"; make_clean_tree "$T16"
  cat > "$T16/lib/services/platform-admin/update-business-feature-access.service.ts" <<'TS'
import { prisma } from "@/lib/prisma";
import { createPlatformAuditEventTx } from "@/lib/services/platform-admin/platform-audit.service";
export async function updateBusinessFeatureAccess(input: { actorUserId: number }) {
  return prisma.$transaction(async (tx) => {
    await tx.businessFeatureAccess.upsert({});
    await createPlatformAuditEventTx(tx, { actorUserId: input.actorUserId });
  });
}
TS
  check "CI-PRIVWRITE-18 catches the bare context-less transaction" FAIL "$T16"

  local T17="$BASE/v17"; make_clean_tree "$T17"
  cat > "$T17/lib/services/platform-admin/update-business-feature-access.service.ts" <<'TS'
import { assertAffected, withControlPlaneTransaction } from "@/lib/services/control-plane/control-plane-transaction";
import { logPlatformAuditEvent } from "@/lib/services/platform-admin/platform-audit.service";
export async function updateBusinessFeatureAccess(input: { actorUserId: number }) {
  const r = await withControlPlaneTransaction(1, async (tx) => {
    const updated = await tx.businessFeatureAccess.updateMany({});
    assertAffected(updated.count, "update");
  });
  await logPlatformAuditEvent({ actorUserId: input.actorUserId });
  return r;
}
TS
  check "CI-PRIVWRITE-19 catches a non-atomic best-effort audit" FAIL "$T17"

  local T18="$BASE/v18"; make_clean_tree "$T18"
  cat >> "$T18/prisma/migrations/20260901090000_d2_pw2_business_feature_access_rls/migration.sql" <<'SQL'
CREATE POLICY p7pw2_ctl_delete ON "BusinessFeatureAccess"
  FOR DELETE TO app_ctlplane
  USING (true);
SQL
  check "CI-PRIVWRITE-20 catches a DELETE policy" FAIL "$T18"

  local T18b="$BASE/v18b"; make_clean_tree "$T18b"
  echo 'GRANT SELECT ON "PlatformAuditEvent" TO app_ctlplane;' >> "$T18b/scripts/security/d2-pw2-grants.sql"
  check "CI-PRIVWRITE-10 catches a SELECT grant on the append-only audit trail" FAIL "$T18b"

  local T19="$BASE/v19"; make_clean_tree "$T19"
  cat > "$T19/lib/services/feature-access/tenant-leak.ts" <<'TS'
import { getPrismaAdmin } from "@/lib/prisma-admin";
export const x = getPrismaAdmin;
TS
  check "CI-PRIVWRITE-21 catches a privileged client in tenant territory" FAIL "$T19"

  local T20="$BASE/v20"; make_clean_tree "$T20"
  rm -f "$T20/scripts/security/d2-pw2-rollback.sql"
  check "missing rollback artifact fails the guard" FAIL "$T20"

  echo "self-test: ok=$ok bad=$bad"
  [ "$bad" -eq 0 ]
}

if [ "${1:-}" = "--self-test" ]; then
  self_test
else
  run_guard "${1:-.}"
fi
