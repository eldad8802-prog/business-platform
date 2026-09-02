#!/usr/bin/env bash
# D2 / ACCOUNT-DELETION-2A.3 — structural tenant-coherence ratchet.
#
# Pins the relational invariant so it cannot silently regress in a later refactor:
# the destructive Conversation children must reference (conversationId, businessId),
# the parent must keep the composite unique target, the key columns must stay
# NOT NULL (a nullable one reopens the MATCH SIMPLE bypass), MessageAnalysis must
# NOT gain a redundant businessId, and this wave must keep its privilege delta at
# exactly zero.
#
#   bash scripts/ci/conversation-coherence-guard.sh .            # check a tree
#   bash scripts/ci/conversation-coherence-guard.sh --self-test  # negative proofs
#
# NOTE ON PIPES: `grep -q` and `head -1` downstream of a pipe SIGPIPE the producer,
# which under `set -o pipefail` inverts guard results. Every check below reads its
# input to EOF and tests the captured value instead.

set -uo pipefail

MODE="check"
ROOT="${1:-.}"
if [ "${1:-}" = "--self-test" ]; then MODE="selftest"; ROOT="${2:-.}"; fi
PASS=0
FAIL=0

ok() {
  if [ "$2" = "1" ]; then
    PASS=$((PASS + 1))
    echo "  [PASS] $1"
  else
    FAIL=$((FAIL + 1))
    echo "  [FAIL] $1${3:+ — $3}"
  fi
}

SCHEMA="$ROOT/prisma/schema.prisma"
MIGDIR="$ROOT/prisma/migrations/20260902090000_d2_ad2a3_conversation_tenant_coherence"
MIG="$MIGDIR/migration.sql"
RB="$ROOT/scripts/security/d2-ad2a3-rollback.sql"
PREFLIGHT="$ROOT/scripts/security/conversation-coherence-preflight.mjs"

# Extract one Prisma model block by name.
model_block() {
  awk -v M="$2" '$1=="model" && $2==M {f=1} f{print} f && /^}/{exit}' "$1" 2>/dev/null
}
# Strip SQL comments so a commented-out statement never satisfies a check.
sqlcode() {
  grep -v '^[[:space:]]*--' "$1" 2>/dev/null | tr '\n' ' '
}

run_checks() {
echo "== CI-CC: conversation structural tenant coherence =="

# --- 1. parent composite target -------------------------------------------
CONV="$(model_block "$SCHEMA" Conversation)"
n=$(printf '%s' "$CONV" | grep -c '@@unique(\[id, businessId\])' || true)
ok "CI-CC-1  Conversation keeps @@unique([id, businessId]) (the FK target)" "$([ "$n" -ge 1 ] && echo 1 || echo 0)"

# --- 2/3. destructive children reference the tenant column ----------------
MSG="$(model_block "$SCHEMA" Message)"
n=$(printf '%s' "$MSG" | grep -c 'fields: \[conversationId, businessId\], references: \[id, businessId\]' || true)
ok "CI-CC-2  Message Conversation relation includes businessId" "$([ "$n" -ge 1 ] && echo 1 || echo 0)"

RS="$(model_block "$SCHEMA" ReplySuggestion)"
n=$(printf '%s' "$RS" | grep -c 'fields: \[conversationId, businessId\], references: \[id, businessId\]' || true)
ok "CI-CC-3  ReplySuggestion Conversation relation includes businessId" "$([ "$n" -ge 1 ] && echo 1 || echo 0)"

# --- 4. no silent regression to a single-column destructive FK -------------
n=$(printf '%s' "$MSG" | grep -c 'Conversation .*@relation(fields: \[conversationId\], references: \[id\]' || true)
m=$(printf '%s' "$RS" | grep -c 'Conversation .*@relation(fields: \[conversationId\], references: \[id\]' || true)
ok "CI-CC-4  neither child regressed to a single-column Conversation FK" "$([ "$n" -eq 0 ] && [ "$m" -eq 0 ] && echo 1 || echo 0)" "message=$n suggestion=$m"

# --- 5. MessageAnalysis must not gain a redundant businessId ---------------
MA="$(model_block "$SCHEMA" MessageAnalysis)"
n=$(printf '%s' "$MA" | grep -cE '^[[:space:]]*businessId[[:space:]]' || true)
ok "CI-CC-5  MessageAnalysis has NO businessId (ownership stays derived through Message)" "$([ "$n" -eq 0 ] && echo 1 || echo 0)"
n=$(printf '%s' "$MA" | grep -c 'messageId Int      @unique' || true)
m=$(printf '%s' "$MA" | grep -c 'onDelete: Cascade' || true)
ok "CI-CC-6  MessageAnalysis keeps messageId @unique + ON DELETE CASCADE" "$([ "$n" -ge 1 ] && [ "$m" -ge 1 ] && echo 1 || echo 0)"

# --- 7. NOT NULL is load-bearing (MATCH SIMPLE bypass guard) --------------
bad=0
for pair in "Message:conversationId" "Message:businessId" "ReplySuggestion:conversationId" "ReplySuggestion:businessId"; do
  mdl="${pair%%:*}"; col="${pair##*:}"
  blk="$(model_block "$SCHEMA" "$mdl")"
  line="$(printf '%s' "$blk" | grep -E "^[[:space:]]*${col}[[:space:]]+Int" || true)"
  [ -z "$line" ] && bad=1
  case "$line" in *"Int?"*) bad=1 ;; esac
done
ok "CI-CC-7  all four composite-key columns stay NOT NULL (nullable would reopen MATCH SIMPLE bypass)" "$([ "$bad" -eq 0 ] && echo 1 || echo 0)"

# --- 8. migration keeps explicit CASCADE semantics ------------------------
MIGSQL="$(sqlcode "$MIG")"
n=$(printf '%s' "$MIGSQL" | grep -c 'Message_conversationId_businessId_fkey' || true)
m=$(printf '%s' "$MIGSQL" | grep -c 'ReplySuggestion_conversationId_businessId_fkey' || true)
ok "CI-CC-8  migration creates both composite FKs" "$([ "$n" -ge 1 ] && [ "$m" -ge 1 ] && echo 1 || echo 0)"
n=$(printf '%s' "$MIGSQL" | grep -o 'ON DELETE CASCADE' | wc -l | tr -d ' ')
ok "CI-CC-9  migration states ON DELETE CASCADE explicitly for both" "$([ "$n" -ge 2 ] && echo 1 || echo 0)" "found=$n"
n=$(printf '%s' "$MIGSQL" | grep -c 'CREATE UNIQUE INDEX "Conversation_id_businessId_key"' || true)
ok "CI-CC-10 migration creates the composite parent unique index" "$([ "$n" -ge 1 ] && echo 1 || echo 0)"

# --- 11..16. privilege delta must be exactly zero -------------------------
BOTH="$MIGSQL $(sqlcode "$RB")"
n=$(printf '%s' "$BOTH" | grep -ci 'GRANT' || true)
ok "CI-CC-11 zero GRANT in migration + rollback" "$([ "$n" -eq 0 ] && echo 1 || echo 0)" "found=$n"
n=$(printf '%s' "$BOTH" | grep -ci 'GRANT[^;]*DELETE' || true)
ok "CI-CC-12 zero new DELETE grant" "$([ "$n" -eq 0 ] && echo 1 || echo 0)"
n=$(printf '%s' "$BOTH" | grep -ci 'POLICY' || true)
ok "CI-CC-13 zero RLS policy change" "$([ "$n" -eq 0 ] && echo 1 || echo 0)" "found=$n"
n=$(printf '%s' "$BOTH" | grep -ci 'ROW LEVEL SECURITY' || true)
ok "CI-CC-14 zero ENABLE/FORCE ROW LEVEL SECURITY change" "$([ "$n" -eq 0 ] && echo 1 || echo 0)"
n=$(printf '%s' "$BOTH" | grep -ciE '(CREATE|ALTER|DROP) ROLE|BYPASSRLS|SECURITY[[:space:]]+DEFINER' || true)
ok "CI-CC-15 zero role / BYPASSRLS / SECURITY DEFINER" "$([ "$n" -eq 0 ] && echo 1 || echo 0)"
n=$(printf '%s' "$BOTH" | grep -ciE 'app_admin|app_ctlplane|neondb_owner|app_runtime_preview' || true)
ok "CI-CC-16 no environment-specific role named in the migration" "$([ "$n" -eq 0 ] && echo 1 || echo 0)"

# --- 17. rollback artifact stays aligned with the migration ---------------
ok "CI-CC-17 paired rollback artifact exists" "$([ -f "$RB" ] && echo 1 || echo 0)"
n=$(printf '%s' "$(sqlcode "$RB")" | grep -c 'Message_conversationId_fkey' || true)
m=$(printf '%s' "$(sqlcode "$RB")" | grep -c 'DROP CONSTRAINT IF EXISTS "Message_conversationId_businessId_fkey"' || true)
ok "CI-CC-18 rollback restores the single-column FK and drops the composite one" "$([ "$n" -ge 1 ] && [ "$m" -ge 1 ] && echo 1 || echo 0)"

# --- 19. the preflight must stay SELECT-only ------------------------------
if [ -f "$PREFLIGHT" ]; then
  body="$(grep -v '^[[:space:]]*\*' "$PREFLIGHT" | grep -v '^[[:space:]]*//' | tr '\n' ' ')"
  n=$(printf '%s' "$body" | grep -ciE '\$executeRaw|INSERT INTO|UPDATE [A-Za-z"]|DELETE FROM|ALTER TABLE|CREATE (TABLE|INDEX)|DROP ' || true)
  ok "CI-CC-19 structural preflight is SELECT-only (no DML/DDL)" "$([ "$n" -eq 0 ] && echo 1 || echo 0)" "found=$n"
  n=$(printf '%s' "$body" | grep -c 'ep-flat-brook-am4bhq1y' || true)
  ok "CI-CC-20 preflight carries the Production deny-list" "$([ "$n" -ge 1 ] && echo 1 || echo 0)"
else
  ok "CI-CC-19 structural preflight is SELECT-only (no DML/DDL)" 0 "missing $PREFLIGHT"
  ok "CI-CC-20 preflight carries the Production deny-list" 0 "missing"
fi

# --- 21. this wave adds no Conversation DELETE capability anywhere ---------
n=$(grep -rlE 'GRANT[^;]*DELETE[^;]*"(Conversation|Message|MessageAnalysis|ReplySuggestion)"' \
      "$ROOT/prisma/migrations" "$ROOT/scripts/security" 2>/dev/null | grep -v 'rollback' | wc -l | tr -d ' ')
ok "CI-CC-21 no repo artifact grants DELETE on the Conversation subgraph" "$([ "$n" -eq 0 ] && echo 1 || echo 0)" "files=$n"

echo ""
echo "[CI-CC] PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
}

# ---------------------------------------------------------------------------
# NEGATIVE SELF-PROOFS
#
# A guard that has never been seen to fail is not evidence. Each mutation below
# reintroduces exactly the regression the corresponding check exists to catch;
# the guard MUST report that check as failed. If a mutation slips through, the
# guard is decorative and this script exits non-zero.
# ---------------------------------------------------------------------------
selftest() {
  local src="${SELFTEST_ROOT:-.}"
  local sp=0 sf=0

  probe() { # probe <label> <expected-failing-check-id> <mutator-fn>
    local label="$1" expect="$2" mut="$3"
    local tmp
    tmp="$(mktemp -d)"
    mkdir -p "$tmp/prisma/migrations/20260902090000_d2_ad2a3_conversation_tenant_coherence" \
             "$tmp/scripts/security" "$tmp/scripts/ci"
    cp "$src/prisma/schema.prisma" "$tmp/prisma/schema.prisma"
    cp "$src/prisma/migrations/20260902090000_d2_ad2a3_conversation_tenant_coherence/migration.sql" \
       "$tmp/prisma/migrations/20260902090000_d2_ad2a3_conversation_tenant_coherence/migration.sql"
    cp "$src/scripts/security/d2-ad2a3-rollback.sql" "$tmp/scripts/security/"
    cp "$src/scripts/security/conversation-coherence-preflight.mjs" "$tmp/scripts/security/"

    "$mut" "$tmp"

    local out
    out="$(bash "$src/scripts/ci/conversation-coherence-guard.sh" "$tmp" 2>&1)"
    local caught=0
    case "$out" in *"[FAIL] $expect"*) caught=1 ;; esac
    if [ "$caught" = "1" ]; then
      sp=$((sp + 1)); echo "  [PASS] negative: $label -> $expect fails as designed"
    else
      sf=$((sf + 1)); echo "  [FAIL] negative: $label -> $expect did NOT fail (guard is decorative)"
    fi
    rm -rf "$tmp"
  }

  m_drop_parent_unique() { sed -i 's|  @@unique(\[id, businessId\])||' "$1/prisma/schema.prisma"; }
  m_msg_single()  { perl -0pi -e 's/\Qconversation              Conversation        \E\@relation\(fields: \[conversationId, businessId\], references: \[id, businessId\]/conversation              Conversation        \@relation(fields: [conversationId], references: [id]/' "$1/prisma/schema.prisma"; }
  m_sug_single()  { perl -0pi -e 's/\Qconversation        Conversation          \E\@relation\(fields: \[conversationId, businessId\], references: \[id, businessId\]/conversation        Conversation          \@relation(fields: [conversationId], references: [id]/' "$1/prisma/schema.prisma"; }
  # NOTE: prisma/schema.prisma has CRLF line endings, so these two mutators must not
  # anchor on \n or $ — an earlier version did and silently mutated nothing, which
  # made both probes look like guard failures rather than mutator bugs.
  m_ma_business() {
    awk 'BEGIN{d=0} {print} /^model MessageAnalysis \{\r?$/ && d==0 {print "  businessId Int"; d=1}' \
      "$1/prisma/schema.prisma" > "$1/ma.tmp" && mv "$1/ma.tmp" "$1/prisma/schema.prisma"
  }
  m_nullable() {
    # Message.conversationId becomes optional: a NULL key component would make the
    # composite FK vacuously satisfied under MATCH SIMPLE.
    perl -0pi -e 's/  conversationId            Int(?![?\w])/  conversationId            Int?/' \
      "$1/prisma/schema.prisma"
  }
  m_delete_grant(){ echo 'GRANT DELETE ON "Conversation" TO app_runtime;' >> "$1/prisma/migrations/20260902090000_d2_ad2a3_conversation_tenant_coherence/migration.sql"; }
  m_delete_policy(){ echo 'CREATE POLICY cc_del ON "Conversation" FOR DELETE USING (true);' >> "$1/prisma/migrations/20260902090000_d2_ad2a3_conversation_tenant_coherence/migration.sql"; }
  m_no_cascade()  { perl -0pi -e 's/ON DELETE CASCADE ON UPDATE CASCADE;/ON UPDATE CASCADE;/g' "$1/prisma/migrations/20260902090000_d2_ad2a3_conversation_tenant_coherence/migration.sql"; }
  m_preflight_dml(){ echo 'await client.$executeRawUnsafe("UPDATE \"Message\" SET \"businessId\" = 1");' >> "$1/scripts/security/conversation-coherence-preflight.mjs"; }
  m_drop_rollback(){ rm -f "$1/scripts/security/d2-ad2a3-rollback.sql"; }

  echo ""
  echo "== CI-CC negative self-proofs =="
  probe "drop Conversation @@unique([id, businessId])"        "CI-CC-1"  m_drop_parent_unique
  probe "Message FK loses businessId"                          "CI-CC-2"  m_msg_single
  probe "ReplySuggestion FK loses businessId"                  "CI-CC-3"  m_sug_single
  probe "Message FK regresses to single-column"                "CI-CC-4"  m_msg_single
  probe "MessageAnalysis gains a redundant businessId"         "CI-CC-5"  m_ma_business
  probe "a composite-key column becomes nullable"              "CI-CC-7"  m_nullable
  probe "migration drops explicit ON DELETE CASCADE"           "CI-CC-9"  m_no_cascade
  probe "migration introduces a DELETE grant"                  "CI-CC-11" m_delete_grant
  probe "migration introduces a DELETE grant (DELETE-specific)" "CI-CC-12" m_delete_grant
  probe "migration introduces an RLS policy"                   "CI-CC-13" m_delete_policy
  probe "preflight gains a write statement"                    "CI-CC-19" m_preflight_dml
  probe "paired rollback artifact is deleted"                  "CI-CC-17" m_drop_rollback

  echo ""
  echo "[CI-CC self-test] PASS=$sp FAIL=$sf"
  [ "$sf" -eq 0 ] || exit 1
}

if [ "$MODE" = "selftest" ]; then
  SELFTEST_ROOT="$ROOT"
  selftest
else
  run_checks
fi
