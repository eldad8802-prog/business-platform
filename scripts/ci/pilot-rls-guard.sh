#!/usr/bin/env bash
# D2 / PRODUCTION-RUNTIME-CUTOVER-2B — canonical five-pilot RLS ratchet.
#
# The failure this exists to prevent already happened once: the P4-B pilot enabled
# RLS on five tables by hand on the Preview branch and never shipped a migration, so
# for weeks Preview looked protected, Production was not, and the repository could not
# tell you which was correct. This guard makes the REPOSITORY the authority — if the
# migration stops covering a table, weakens FORCE to ENABLE, or grows a DELETE policy,
# CI fails rather than a future environment quietly diverging again.
#
#   bash scripts/ci/pilot-rls-guard.sh .            # check a tree
#   bash scripts/ci/pilot-rls-guard.sh --self-test  # negative proofs
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

PILOT="Conversation Customer Appointment BillingDocument PaymentRequest"
MIGDIR_REL="prisma/migrations/20260902120000_d2_cutover2b_pilot_tenant_rls"
MIG="$ROOT/$MIGDIR_REL/migration.sql"
RB="$ROOT/scripts/security/d2-cutover2b-rollback.sql"

# SQL with comments stripped, flattened to one line so multi-line policies match.
sqlcode() { grep -v '^[[:space:]]*--' "$1" 2>/dev/null | tr '\n' ' '; }

run_checks() {
echo "== CI-PR: canonical five-pilot RLS =="

if [ ! -f "$MIG" ]; then
  ok "CI-PR-0  canonical pilot RLS migration exists" 0 "missing $MIGDIR_REL"
  echo ""; echo "[CI-PR] PASS=$PASS FAIL=$FAIL"; exit 1
fi
ok "CI-PR-0  canonical pilot RLS migration exists" 1
SQL="$(sqlcode "$MIG")"

# --- 1..5. every pilot table is covered, ENABLE + FORCE + all three policies
i=1
for t in $PILOT; do
  en=$(printf '%s' "$SQL" | grep -c "ALTER TABLE \"$t\" ENABLE ROW LEVEL SECURITY" || true)
  fo=$(printf '%s' "$SQL" | grep -c "ALTER TABLE \"$t\" FORCE ROW LEVEL SECURITY" || true)
  rd=$(printf '%s' "$SQL" | grep -c "CREATE POLICY p7pilot_tenant_read ON \"$t\" FOR SELECT" || true)
  ins=$(printf '%s' "$SQL" | grep -c "CREATE POLICY p7pilot_tenant_insert ON \"$t\" FOR INSERT" || true)
  up=$(printf '%s' "$SQL" | grep -c "CREATE POLICY p7pilot_tenant_update ON \"$t\" FOR UPDATE" || true)
  good=0
  [ "$en" -ge 1 ] && [ "$fo" -ge 1 ] && [ "$rd" -ge 1 ] && [ "$ins" -ge 1 ] && [ "$up" -ge 1 ] && good=1
  ok "CI-PR-${i}  $t: ENABLE + FORCE + SELECT/INSERT/UPDATE tenant policies" "$good" \
     "enable=$en force=$fo select=$rd insert=$ins update=$up"
  i=$((i + 1))
done

# --- 6. the exact tenant predicate, nothing looser -------------------------
PRED='"businessId" = NULLIF(current_setting('"'"'app.current_business_id'"'"', true), '"''"')::int'
# Four predicate clauses per table: SELECT USING, INSERT WITH CHECK, UPDATE USING,
# UPDATE WITH CHECK. Asserted EXACTLY rather than as a floor — a missing clause and an
# extra looser one are both regressions, and adding a sixth table should be a
# conscious update to this guard rather than something it silently absorbs.
PILOT_COUNT=$(printf '%s\n' $PILOT | grep -c . || true)
EXPECT_PRED=$((PILOT_COUNT * 4))
n=$(printf '%s' "$SQL" | grep -o "$PRED" | wc -l | tr -d ' ')
ok "CI-PR-6  the canonical tenant predicate appears exactly once per policy clause" \
   "$([ "$n" -eq "$EXPECT_PRED" ] && echo 1 || echo 0)" "found=$n expected=$EXPECT_PRED"

# --- 7. NO DELETE policy, and no FOR ALL (which would smuggle DELETE in) ---
n=$(printf '%s' "$SQL" | grep -ci 'FOR DELETE' || true)
ok "CI-PR-7  zero DELETE policy on any pilot table" "$([ "$n" -eq 0 ] && echo 1 || echo 0)" "found=$n"
n=$(printf '%s' "$SQL" | grep -c 'CREATE POLICY [a-z0-9_]* ON "[A-Za-z]*" FOR ALL' || true)
ok "CI-PR-8  zero FOR ALL policy (FOR ALL silently includes DELETE — the P4-B defect)" \
   "$([ "$n" -eq 0 ] && echo 1 || echo 0)" "found=$n"

# --- 9. the Preview-only residue is converged, not left overlapping --------
n=$(printf '%s' "$SQL" | grep -o 'DROP POLICY IF EXISTS p4b_tenant ON' | wc -l | tr -d ' ')
ok "CI-PR-9  the unmigrated Preview p4b_tenant residue is dropped on all five" \
   "$([ "$n" -ge 5 ] && echo 1 || echo 0)" "found=$n"

# --- 10. the existing canonical admin policy is left alone ----------------
n=$(printf '%s' "$SQL" | grep -c 'p7adm_read' || true)
ok "CI-PR-10 the migration does not touch p7adm_read (owned by W2-GATE)" \
   "$([ "$n" -eq 0 ] && echo 1 || echo 0)" "found=$n"

# --- 11..14. privilege delta must be exactly zero -------------------------
BOTH="$SQL $(sqlcode "$RB")"
n=$(printf '%s' "$BOTH" | grep -ci 'GRANT' || true)
ok "CI-PR-11 zero GRANT in migration + rollback" "$([ "$n" -eq 0 ] && echo 1 || echo 0)" "found=$n"
n=$(printf '%s' "$BOTH" | grep -ciE '(CREATE|ALTER|DROP) ROLE|BYPASSRLS|SECURITY[[:space:]]+DEFINER|OWNER TO' || true)
ok "CI-PR-12 zero role / BYPASSRLS / SECURITY DEFINER / ownership change" "$([ "$n" -eq 0 ] && echo 1 || echo 0)" "found=$n"
n=$(printf '%s' "$BOTH" | grep -ciE 'app_runtime|app_runtime_prod|neondb_owner|app_runtime_preview' || true)
ok "CI-PR-13 no environment-specific role named in migration or rollback" "$([ "$n" -eq 0 ] && echo 1 || echo 0)" "found=$n"
n=$(printf '%s' "$BOTH" | grep -ciE '(^|;)[[:space:]]*(INSERT[[:space:]]+INTO|UPDATE[[:space:]]+"|DELETE[[:space:]]+FROM)' || true)
ok "CI-PR-14 zero data DML in migration or rollback" "$([ "$n" -eq 0 ] && echo 1 || echo 0)" "found=$n"

# --- 15. rollback is paired and removes only task-owned policies ----------
ok "CI-PR-15 paired rollback artifact exists" "$([ -f "$RB" ] && echo 1 || echo 0)"
RBSQL="$(sqlcode "$RB")"
n=$(printf '%s' "$RBSQL" | grep -o 'DROP POLICY IF EXISTS p7pilot_tenant_' | wc -l | tr -d ' ')
m=$(printf '%s' "$RBSQL" | grep -c 'p7adm_read' || true)
ok "CI-PR-16 rollback drops the 15 task-owned policies and never p7adm_read" \
   "$([ "$n" -ge 15 ] && [ "$m" -eq 0 ] && echo 1 || echo 0)" "pilot=$n adm=$m"

echo ""
echo "[CI-PR] PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
}

# ---------------------------------------------------------------------------
# NEGATIVE SELF-PROOFS
# ---------------------------------------------------------------------------
selftest() {
  local src="$ROOT" sp=0 sf=0
  probe() { # probe <label> <expected-failing-check> <mutator>
    local label="$1" expect="$2" mut="$3" tmp
    tmp="$(mktemp -d)"
    mkdir -p "$tmp/$MIGDIR_REL" "$tmp/scripts/security"
    cp "$src/$MIGDIR_REL/migration.sql" "$tmp/$MIGDIR_REL/migration.sql"
    cp "$src/scripts/security/d2-cutover2b-rollback.sql" "$tmp/scripts/security/"
    "$mut" "$tmp"
    local out; out="$(bash "$src/scripts/ci/pilot-rls-guard.sh" "$tmp" 2>&1)"
    local caught=0
    case "$out" in *"[FAIL] $expect"*) caught=1 ;; esac
    if [ "$caught" = "1" ]; then sp=$((sp+1)); echo "  [PASS] negative: $label -> $expect fails as designed";
    else sf=$((sf+1)); echo "  [FAIL] negative: $label -> $expect did NOT fail (guard is decorative)"; fi
    rm -rf "$tmp"
  }

  M() { echo "$1/$MIGDIR_REL/migration.sql"; }

  # A pilot table silently dropped from coverage — the original P4-B failure shape.
  m_drop_table() { perl -0pi -e 's/ALTER TABLE "PaymentRequest" ENABLE ROW LEVEL SECURITY;//' "$(M "$1")"; }
  # FORCE weakened to ENABLE-only: the table owner would then bypass its own policies.
  m_weaken_force() { perl -0pi -e 's/ALTER TABLE "Conversation" FORCE ROW LEVEL SECURITY;//' "$(M "$1")"; }
  # A permissive cross-tenant policy: permissive policies OR together, so one
  # `USING (true)` re-opens every tenant boundary on that table.
  m_cross_tenant() {
    printf '\nCREATE POLICY p7pilot_tenant_read ON "Customer" FOR SELECT USING (true);\n' >> "$(M "$1")"
    perl -0pi -e 's/CREATE POLICY p7pilot_tenant_read ON "Customer" FOR SELECT\n  USING \("businessId" = NULLIF\(current_setting\(.app\.current_business_id., true\), ..\)::int\);//' "$(M "$1")"
  }
  m_delete_policy() { printf '\nCREATE POLICY p7pilot_tenant_del ON "Conversation" FOR DELETE USING (true);\n' >> "$(M "$1")"; }
  m_for_all() { perl -0pi -e 's/CREATE POLICY p7pilot_tenant_read ON "Appointment" FOR SELECT/CREATE POLICY p7pilot_tenant_read ON "Appointment" FOR ALL/' "$(M "$1")"; }
  m_keep_residue() { perl -0pi -e 's/DROP POLICY IF EXISTS p4b_tenant ON "Customer";//' "$(M "$1")"; }
  m_touch_adm() { printf '\nDROP POLICY IF EXISTS p7adm_read ON "Conversation";\n' >> "$(M "$1")"; }
  m_grant() { printf '\nGRANT DELETE ON "Conversation" TO app_runtime;\n' >> "$(M "$1")"; }
  m_env_role() { printf '\nALTER POLICY p7pilot_tenant_read ON "Customer" TO neondb_owner;\n' >> "$(M "$1")"; }
  m_drop_rollback() { rm -f "$1/scripts/security/d2-cutover2b-rollback.sql"; }

  echo ""
  echo "== CI-PR negative self-proofs =="
  probe "a pilot table loses its ENABLE"                    "CI-PR-5"  m_drop_table
  probe "FORCE weakened to ENABLE-only"                     "CI-PR-1"  m_weaken_force
  probe "a permissive cross-tenant USING(true) policy"      "CI-PR-6"  m_cross_tenant
  probe "a DELETE policy is introduced"                     "CI-PR-7"  m_delete_policy
  probe "a policy is widened to FOR ALL"                    "CI-PR-8"  m_for_all
  probe "the Preview p4b_tenant residue is left in place"   "CI-PR-9"  m_keep_residue
  probe "the migration touches the W2-GATE admin policy"    "CI-PR-10" m_touch_adm
  probe "a GRANT is smuggled into the migration"            "CI-PR-11" m_grant
  probe "an environment-specific role is named"             "CI-PR-13" m_env_role
  probe "the paired rollback artifact is deleted"           "CI-PR-15" m_drop_rollback

  echo ""
  echo "[CI-PR self-test] PASS=$sp FAIL=$sf"
  [ "$sf" -eq 0 ] || exit 1
}

if [ "$MODE" = "selftest" ]; then selftest; else run_checks; fi
